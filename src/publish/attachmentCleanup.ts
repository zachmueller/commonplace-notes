/**
 * Attachment cleanup (attachment spec phase 3): sweeps after an access
 * change, a delete or a group purge (§2), the state rebuild (§3) and the
 * bucket side of "Audit published notes" (§4).
 *
 * Every function here runs while its caller holds the profile's publish lock
 * (P2 §1): sweeps inside a publish or a delete, the audit and its delete offer
 * under "checking attachments". None of them takes the lock itself, because
 * it isn't re-entrant.
 *
 * The rules (required, candidates, orphans, the bucket comparison, the
 * rebuild merge) are pure functions in src/utils/attachments.ts and
 * src/utils/attachmentState.ts; this module supplies the plugin's state, S3
 * and notices. Sweeps never check the attachment mode: gating attachment
 * cleanup on it would fail open (§2, "Sweeps ignore the attachment mode").
 */

import { TFile } from 'obsidian';
import type CommonplaceNotesPlugin from '../main';
import type { PublishingProfile } from '../types';
import { Logger, errorMessage } from '../utils/logging';
import { NoticeManager } from '../utils/notice';
import {
	compareWithBucket,
	createLimiter,
	describeArea,
	nameList,
	parseAttachmentKey,
	planSweep,
	plural,
	requiredByArea,
	uidsRequiring,
	type AreaKey,
	type RequiredInputs,
} from '../utils/attachments';
import {
	dropArea,
	ensureCompleteState,
	forgetUploaded,
	loadOrCreateAttachmentState,
	saveAttachmentState,
	type AttachmentStateFile,
	type BucketAttachmentState,
} from '../utils/attachmentState';
import {
	deleteAttachmentObjects,
	listAreas,
	listAttachmentObjects,
	listForRebuild,
	readNoteAttachments,
} from './attachmentS3';

/** Note JSON reads during a rebuild (§3, step 2). */
const REBUILD_CONCURRENCY = 5;

async function s3Of(plugin: CommonplaceNotesPlugin, profile: PublishingProfile) {
	if (!profile.awsSettings) throw new Error('Selected profile is not configured for AWS publishing');
	return {
		s3: await plugin.awsSdkManager.getS3Client(profile),
		bucket: profile.awsSettings.bucketName,
		s3Prefix: profile.awsSettings.s3Prefix || '',
	};
}

/**
 * The derivation's inputs from the plugin's in-memory mappings and access map
 * (the caller has loaded both) and the publish history on disk.
 */
async function requiredInputs(plugin: CommonplaceNotesPlugin, profileId: string, state: AttachmentStateFile): Promise<RequiredInputs> {
	return {
		uidToHash: plugin.mappingManager.getUidToHashMap(profileId),
		accessOf: uid => plugin.accessManager.getGroups(profileId, uid),
		history: await plugin.noteManager.loadPublishHistory(profileId),
		refs: state.refs,
	};
}

// ---------------------------------------------------------------------------
// §3 Rebuild
// ---------------------------------------------------------------------------

/**
 * Read the bucket's attachment state: list every area's note JSON and
 * attachment objects, then GET each note JSON whose hash `local` doesn't
 * already map (concurrency 5, progress notice). Throws on failure.
 */
export async function readBucketAttachmentState(
	plugin: CommonplaceNotesPlugin,
	profile: PublishingProfile,
	local: AttachmentStateFile | null,
): Promise<BucketAttachmentState> {
	const { s3, bucket, s3Prefix } = await s3Of(plugin, profile);
	const { notes, uploaded } = await listForRebuild(s3, bucket, s3Prefix, new Set(Object.keys(local?.refs ?? {})));
	const refs: Record<string, string[]> = {};
	const limit = createLimiter(REBUILD_CONCURRENCY);
	const { success, error } = await NoticeManager.showProgressWithCounter(
		'Rebuilding attachment state from published notes',
		notes.length,
		async (update) => {
			let done = 0;
			await Promise.all(notes.map(note => limit(async () => {
				const read = await readNoteAttachments(s3, bucket, note);
				if (read && read.keys.length > 0) refs[read.hash] = read.keys;
				update(++done);
			})));
		},
		'Attachment state rebuilt',
		'Could not rebuild attachment state, check console for error details',
	);
	if (!success) throw error ?? new Error('Attachment state rebuild failed');
	return { refs, uploaded };
}

/** `attachments.json`, rebuilt first when it isn't complete (§3). Throws when the rebuild fails. */
async function completeState(plugin: CommonplaceNotesPlugin, profile: PublishingProfile): Promise<AttachmentStateFile> {
	const am = plugin.attachmentManager;
	const state = await am.stateForCleanup(profile);
	const result = await ensureCompleteState(am.store, am.statePath(profile.id), state,
		() => readBucketAttachmentState(plugin, profile, state));
	if (result.rebuilt) Logger.info(`Rebuilt attachments.json for profile ${profile.id} from the bucket`);
	return result.state;
}

// ---------------------------------------------------------------------------
// §2 Sweeps
// ---------------------------------------------------------------------------

function cantCheckNotice(names: readonly string[], area: string): void {
	const quoted = names.map(n => `"${n}"`);
	const who = quoted.length === 1 ? `${quoted[0]}'s attachments` : `the attachments of ${nameList(quoted)}`;
	// Persistent: the files may still be readable where the notes no longer are.
	NoticeManager.showNotice(
		`Couldn't check ${who}. They may still be readable in ${describeArea(area)}. Run "Audit published notes".`,
		0,
	);
}

/**
 * Sweep after published revisions were removed (§2). `removed` maps each area
 * to the note hashes removed from it; only the keys those revisions used are
 * candidates, and a candidate some live revision in the area still needs is
 * kept. The required set is derived from the plugin's current mappings and
 * access map, so the caller must have updated both first.
 *
 * Never throws and never fails the operation that removed the revisions: a
 * rebuild or delete failure shows a persistent notice (with `namesFor(area)`)
 * pointing to the audit, and keys that weren't deleted stay in `uploaded`.
 */
export async function sweepRemovedRevisions(
	plugin: CommonplaceNotesPlugin,
	profile: PublishingProfile,
	removed: ReadonlyMap<string, ReadonlySet<string>>,
	namesFor: (area: string) => string[],
): Promise<void> {
	const areas = [...removed].filter(([, hashes]) => hashes.size > 0).map(([area]) => area);
	if (areas.length === 0 || profile.publishMechanism !== 'AWS' || !profile.awsSettings) return;
	const am = plugin.attachmentManager;

	let state: AttachmentStateFile;
	try {
		state = await completeState(plugin, profile);
	} catch (e) {
		Logger.error('Attachment sweep skipped: the attachment state could not be rebuilt:', e);
		for (const area of areas) cantCheckNotice(namesFor(area), area);
		return;
	}

	try {
		const plan = planSweep(removed, await requiredInputs(plugin, profile.id, state));
		if (plan.size === 0) return;
		const { s3, bucket, s3Prefix } = await s3Of(plugin, profile);
		for (const [area, orphans] of plan) {
			const result = await deleteAttachmentObjects(s3, bucket, s3Prefix, area, orphans);
			forgetUploaded(state, area, result.deleted);
			if (result.deleted.length > 0) {
				Logger.info(`Attachment sweep: removed ${plural(result.deleted.length, 'file')} from ${describeArea(area)}`);
			}
			if (result.failed.length > 0) {
				Logger.error(`Attachment sweep: ${result.failed.length} file(s) not deleted from ${describeArea(area)}:`, result.error);
				cantCheckNotice(namesFor(area), area);
			}
		}
		await saveAttachmentState(am.store, am.statePath(profile.id), state);
	} catch (e) {
		Logger.error('Attachment sweep failed:', e);
		for (const area of areas) cantCheckNotice(namesFor(area), area);
	}
}

/**
 * A whole group area was deleted by prefix (group purge), its `attachments/`
 * with it: drop the area from `uploaded`. Only an existing file is changed.
 */
export async function forgetArea(plugin: CommonplaceNotesPlugin, profileId: string, area: string): Promise<void> {
	const am = plugin.attachmentManager;
	const path = am.statePath(profileId);
	const { state } = await loadOrCreateAttachmentState(am.store, path, null);
	if (!state || !(area in state.uploaded)) return;
	dropArea(state, area);
	await saveAttachmentState(am.store, path, state);
}

/** A display name for a UID: the vault note carrying it, else the UID. */
export function noteNameForUid(plugin: CommonplaceNotesPlugin, uid: string): string {
	for (const file of plugin.app.vault.getMarkdownFiles()) {
		if (plugin.frontmatterManager.peekNoteUID(file) === uid) return file.basename;
	}
	return uid;
}

// ---------------------------------------------------------------------------
// §4 Audit
// ---------------------------------------------------------------------------

export interface AttachmentAudit {
	/** Whether `attachments.json` was complete. When not, unreferenced may include files in use. */
	complete: boolean;
	/** In the bucket, not required by any published revision in its area. */
	unreferenced: AreaKey[];
	/** Required but missing; the vault has the bytes, so they were cleared from `uploaded`. */
	missingReupload: AreaKey[];
	/** Required but missing, and the bytes are no longer in the vault. */
	missingLost: AreaKey[];
	/** "area\0key" → names of the notes that use a missing key. */
	usedBy: Map<string, string[]>;
}

const areaKeyId = (a: AreaKey) => `${a.area}\u0000${a.key}`;

/**
 * List the bucket's attachment objects and compare them with what the
 * published revisions need. A missing object whose bytes the vault still has
 * is cleared from `uploaded`, so the next publish of a note that uses it
 * re-uploads it. Throws when the bucket can't be listed.
 */
export async function auditAttachmentObjects(plugin: CommonplaceNotesPlugin, profile: PublishingProfile): Promise<AttachmentAudit> {
	const am = plugin.attachmentManager;
	await plugin.mappingManager.loadProfileMappings(profile.id);
	await plugin.accessManager.load(profile.id);
	const state = await am.stateForCleanup(profile);
	const { s3, bucket, s3Prefix } = await s3Of(plugin, profile);
	const listing = await listAttachmentObjects(s3, bucket, s3Prefix, await listAreas(s3, bucket, s3Prefix));
	const inputs = await requiredInputs(plugin, profile.id, state);
	const { unreferenced, missing } = compareWithBucket(listing, requiredByArea(inputs));

	const missingReupload: AreaKey[] = [];
	const missingLost: AreaKey[] = [];
	const usedBy = new Map<string, string[]>();
	const inVault = new Map<string, boolean>();
	for (const m of missing) {
		usedBy.set(areaKeyId(m), uidsRequiring(inputs, m.area, m.key).map(uid => noteNameForUid(plugin, uid)));
		if (!inVault.has(m.key)) inVault.set(m.key, await vaultHasBytes(plugin, m.key));
		(inVault.get(m.key) ? missingReupload : missingLost).push(m);
	}
	if (missingReupload.length > 0) {
		for (const m of missingReupload) forgetUploaded(state, m.area, [m.key]);
		await saveAttachmentState(am.store, am.statePath(profile.id), state);
	}
	if (missing.length > 0) await am.saveHashCache().catch(e => Logger.warn('Could not save the attachment hash cache:', e));
	return { complete: state.complete, unreferenced, missingReupload, missingLost, usedBy };
}

/** Whether some vault file named like the key still hashes to its sha256. */
async function vaultHasBytes(plugin: CommonplaceNotesPlugin, key: string): Promise<boolean> {
	const parsed = parseAttachmentKey(key);
	if (!parsed) return false;
	const candidates = plugin.app.vault.getFiles().filter(f => f instanceof TFile && f.name === parsed.fileName && f.extension.toLowerCase() !== 'md');
	for (const file of candidates) {
		try {
			if (await plugin.attachmentManager.currentHash(file.path) === parsed.sha256) return true;
		} catch (e) {
			Logger.warn(`Could not hash ${file.path}:`, e);
		}
	}
	return false;
}

/** Console lines for the audit's attachment findings. */
export function formatAttachmentAudit(audit: AttachmentAudit): string[] {
	const lines: string[] = [];
	const by = (list: AreaKey[]) => {
		const out = new Map<string, string[]>();
		for (const a of list) out.set(a.area, [...(out.get(a.area) ?? []), a.key]);
		return out;
	};
	if (!audit.complete) {
		lines.push('Attachment state (attachments.json) is incomplete: some unreferenced objects may still be in use. Deleting them rebuilds the state first.');
	}
	lines.push(`Unreferenced attachment objects: ${audit.unreferenced.length}`);
	for (const [area, keys] of by(audit.unreferenced)) {
		lines.push(`  ${describeArea(area)}:`);
		keys.forEach(k => lines.push(`    ${k}`));
	}
	const missing = (title: string, list: AreaKey[]) => {
		lines.push(`${title}: ${list.length}`);
		for (const a of list) {
			const notes = audit.usedBy.get(areaKeyId(a)) ?? [];
			lines.push(`  ${describeArea(a.area)}: ${a.key}${notes.length ? ` (used by ${nameList(notes)})` : ''}`);
		}
	};
	missing('Missing attachment objects, re-uploaded at the next publish of a note that uses them', audit.missingReupload);
	missing('Missing attachment objects, referenced, never uploaded (bytes no longer in the vault)', audit.missingLost);
	return lines;
}

/**
 * The audit's delete offer: rebuild first when the state is incomplete, list
 * the bucket again and delete what is still unreferenced. Returns the counts.
 * Throws when the rebuild or the listing fails (nothing is deleted then).
 */
export async function deleteUnreferencedAttachments(
	plugin: CommonplaceNotesPlugin,
	profile: PublishingProfile,
): Promise<{ deleted: number; failed: number }> {
	const am = plugin.attachmentManager;
	await plugin.mappingManager.loadProfileMappings(profile.id);
	await plugin.accessManager.load(profile.id);
	const state = await completeState(plugin, profile);
	const { s3, bucket, s3Prefix } = await s3Of(plugin, profile);
	const listing = await listAttachmentObjects(s3, bucket, s3Prefix, await listAreas(s3, bucket, s3Prefix));
	const { unreferenced } = compareWithBucket(listing, requiredByArea(await requiredInputs(plugin, profile.id, state)));

	const byArea = new Map<string, string[]>();
	for (const u of unreferenced) byArea.set(u.area, [...(byArea.get(u.area) ?? []), u.key]);
	let deleted = 0;
	let failed = 0;
	for (const [area, keys] of byArea) {
		const result = await deleteAttachmentObjects(s3, bucket, s3Prefix, area, keys);
		forgetUploaded(state, area, result.deleted);
		deleted += result.deleted.length;
		failed += result.failed.length;
		if (result.failed.length > 0) Logger.error(`Could not delete ${result.failed.length} object(s) from ${describeArea(area)}:`, result.error);
	}
	await saveAttachmentState(am.store, am.statePath(profile.id), state);
	return { deleted, failed };
}

/** A short notice line for an error. */
export function auditErrorLine(e: unknown): string {
	return `Attachments: couldn't list the bucket (${errorMessage(e)}). Needs s3:ListBucket.`;
}
