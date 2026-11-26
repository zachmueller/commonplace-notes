import { FileSystemAdapter, TFile, getLinkpath } from 'obsidian';
import { awsSdk } from '../utils/awsModules';
import type CommonplaceNotesPlugin from '../main';
import type { PublishingProfile } from '../types';
import { Logger } from '../utils/logging';
import { partitionsFor, restrictedPrefix } from '../utils/access';
import {
	attachmentKey,
	attachmentKind,
	baseNameOf,
	changedSince,
	extensionOf,
	filterAttachment,
	isExtensionAllowed,
	mergeStagedAttachments,
	refKeys,
	resolveAttachmentSettings,
	stagedEntriesFor,
	type AttachmentRef,
	type AttachmentRender,
	type AttachmentSettings,
	type StagedAttachment,
} from '../utils/attachments';
import {
	AttachmentHashCache,
	emptyAttachmentState,
	getOrCreateMachineId,
	hashCachePath,
	loadOrCreateAttachmentState,
	loadStagedAttachments,
	recordRefs,
	saveAttachmentState,
	saveStagedAttachments,
	statFile,
	type AttachmentStateFile,
	type FileStat,
	type TextStore,
} from '../utils/attachmentState';

/**
 * Obsidian-side attachment publishing (attachment spec phase 2): collects a
 * note's references from the metadata cache (§3), answers the renderer's
 * lookups (§4), owns the hash cache (§6) and each profile's
 * `attachments.json` / `staged-attachments.json` during a publish.
 *
 * The rules live in the pure modules src/utils/attachments.ts and
 * src/utils/attachmentState.ts; this class supplies Obsidian and the vault.
 */
export class AttachmentManager {
	private plugin: CommonplaceNotesPlugin;
	private cache: AttachmentHashCache | null = null;
	/** profileId → attachments.json loaded for the running publish. */
	private states = new Map<string, AttachmentStateFile>();
	/** profileId → entries staged by this publish's commit, awaiting flush. */
	private pendingStaged = new Map<string, StagedAttachment[]>();
	/** profileId → staged ids this publish staged or merged into (§7). */
	private thisBatch = new Map<string, Set<string>>();
	/** profileId → files skipped by the size cap while queuing this batch. */
	private oversized = new Map<string, Set<string>>();

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
	}

	/** Vault-adapter I/O for the JSON state files. */
	readonly store: TextStore = {
		read: async (path) => {
			const adapter = this.plugin.app.vault.adapter;
			return (await adapter.exists(path)) ? adapter.read(path) : null;
		},
		write: async (path, text) => {
			await this.plugin.app.vault.adapter.write(path, text);
		},
	};

	settingsFor(profile: PublishingProfile | undefined): AttachmentSettings {
		return resolveAttachmentSettings(profile?.attachments);
	}

	/** Files publish only on AWS profiles whose mode isn't off. */
	isActive(profile: PublishingProfile | undefined): boolean {
		return !!profile && profile.publishMechanism === 'AWS' && this.settingsFor(profile).mode !== 'off';
	}

	/** The OS path of a vault file (the plugin is desktop-only). */
	fullPath(vaultPath: string): string {
		const adapter = this.plugin.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) throw new Error('Attachment publishing needs the desktop app');
		return adapter.getFullPath(vaultPath);
	}

	async stat(vaultPath: string): Promise<FileStat | null> {
		return statFile(this.fullPath(vaultPath));
	}

	/** The per-machine hash cache, loaded on first use. */
	async hashCache(): Promise<AttachmentHashCache> {
		if (!this.cache) {
			const app = this.plugin.app;
			const machineId = getOrCreateMachineId(
				key => app.loadLocalStorage(key),
				(key, value) => app.saveLocalStorage(key, value),
				() => crypto.randomUUID(),
			);
			this.cache = new AttachmentHashCache(this.store, hashCachePath(this.plugin.profileManager.getPluginDir(), machineId));
			await this.cache.load();
		}
		return this.cache;
	}

	async saveHashCache(): Promise<void> {
		await this.cache?.save();
	}

	/** Vault rename/delete: drop the old path's hash entry (§6). */
	forgetPath(vaultPath: string): void {
		// Notes are never in the cache; skip loading it for them.
		if (vaultPath.toLowerCase().endsWith('.md')) return;
		void (async () => {
			const cache = await this.hashCache();
			if (!cache.has(vaultPath)) return;
			cache.evict(vaultPath);
			await cache.save();
		})().catch(e => Logger.warn('Could not update the attachment hash cache:', e));
	}

	/** The current hash of a vault file, or null when it is gone. */
	async currentHash(vaultPath: string): Promise<string | null> {
		const cache = await this.hashCache();
		return (await cache.hashOf(vaultPath, this.fullPath(vaultPath)))?.sha256 ?? null;
	}

	async evictHash(vaultPath: string): Promise<void> {
		(await this.hashCache()).evict(vaultPath);
	}

	// -------------------------------------------------------------------------
	// §3 Collecting references
	// -------------------------------------------------------------------------

	/**
	 * The files `file` publishes with on `profile`, from Obsidian's metadata
	 * cache only: its embeds, plus its links in embedsAndLinks mode. Each kept
	 * file is stat'ed once (Node fs, before hashing) and hashed through the
	 * cache. Empty when the mode is off, on Local profiles, or when the note
	 * isn't indexed yet (fails closed). Files over the cap are remembered for
	 * the batch notice unless `quiet`.
	 */
	async collect(file: TFile, profile: PublishingProfile | undefined, opts: { quiet?: boolean } = {}): Promise<AttachmentRef[]> {
		if (!profile || !this.isActive(profile)) return [];
		const settings = this.settingsFor(profile);
		const mc = this.plugin.app.metadataCache;
		const fileCache = mc.getFileCache(file);
		if (!fileCache) return [];
		const refs = [...(fileCache.embeds ?? [])];
		if (settings.mode === 'embedsAndLinks') refs.push(...(fileCache.links ?? []));

		const isExcluded = (path: string) => this.plugin.publisher.isPathExcluded(path, profile);
		const cache = await this.hashCache();
		const seen = new Set<string>();
		const out: AttachmentRef[] = [];
		for (const ref of refs) {
			const target = mc.getFirstLinkpathDest(getLinkpath(ref.link), file.path);
			if (!(target instanceof TFile) || seen.has(target.path)) continue;
			seen.add(target.path);
			if (target.extension.toLowerCase() === 'md') continue;
			const full = this.fullPath(target.path);
			const stat = await statFile(full);
			if (!stat) continue;
			const ext = target.extension.toLowerCase();
			const verdict = filterAttachment({ path: target.path, ext, size: stat.size }, settings, isExcluded);
			if (verdict === 'size') {
				if (!opts.quiet) this.noteOversized(profile.id, target.name);
				continue;
			}
			if (verdict !== 'ok') continue;
			const hashed = await cache.hashOf(target.path, full);
			if (!hashed) continue;
			out.push({
				vaultPath: target.path,
				sha256: hashed.sha256,
				fileName: target.name,
				ext,
				size: hashed.size,
				mtime: hashed.mtime,
				ctime: hashed.ctime,
				kind: attachmentKind(ext),
			});
		}
		return out;
	}

	private noteOversized(profileId: string, name: string): void {
		let set = this.oversized.get(profileId);
		if (!set) this.oversized.set(profileId, set = new Set());
		set.add(name);
	}

	/** The batch's over-cap file names, cleared. */
	consumeOversized(profileId: string): string[] {
		const names = [...(this.oversized.get(profileId) ?? [])];
		this.oversized.delete(profileId);
		return names;
	}

	/** Whether any ref's file changed since it was hashed (§7, item 1). */
	async firstChanged(refs: readonly AttachmentRef[]): Promise<AttachmentRef | null> {
		for (const ref of refs) {
			const s = await this.stat(ref.vaultPath);
			if (!s || s.size !== ref.size || s.mtimeMs !== ref.mtime || s.ctimeMs !== ref.ctime) return ref;
		}
		return null;
	}

	/**
	 * §8: every vault file some note links to that passes the §3 filters (an
	 * allowed extension, not excluded, within the cap) and changed after
	 * `since` (the later of mtime and ctime, from one fs.stat each).
	 */
	async changedAttachmentPaths(profile: PublishingProfile, since: number): Promise<Set<string>> {
		const settings = this.settingsFor(profile);
		const targets = new Set<string>();
		for (const links of Object.values(this.plugin.app.metadataCache.resolvedLinks)) {
			for (const t of Object.keys(links)) {
				if (!t.toLowerCase().endsWith('.md')) targets.add(t);
			}
		}
		const out = new Set<string>();
		for (const path of targets) {
			const ext = extensionOf(path);
			if (!isExtensionAllowed(ext, settings.allowedExtensions)) continue;
			const stat = await this.stat(path);
			if (!stat) continue;
			const verdict = filterAttachment({ path, ext, size: stat.size }, settings,
				p => this.plugin.publisher.isPathExcluded(p, profile));
			if (verdict === 'ok' && changedSince(stat, since)) out.add(path);
		}
		return out;
	}

	// -------------------------------------------------------------------------
	// §4 Rendering
	// -------------------------------------------------------------------------

	/**
	 * The renderer's lookup for one note: null for anything that isn't a
	 * non-Markdown vault file; published only for files in the note's list.
	 */
	resolverFor(sourcePath: string, refs: readonly AttachmentRef[], profile?: PublishingProfile): (linkpath: string) => AttachmentRender | null {
		const byPath = new Map(refs.map(r => [r.vaultPath, r]));
		const inlinePdfs = this.settingsFor(profile).inlinePdfs;
		// The renderer passes paths with any #fragment already removed.
		return (linkpath: string) => {
			const target = this.plugin.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
			if (!(target instanceof TFile) || target.extension.toLowerCase() === 'md') return null;
			const ref = byPath.get(target.path);
			if (!ref) return { published: false, fileName: target.name };
			const render: AttachmentRender = { published: true, key: attachmentKey(ref.sha256, ref.fileName), fileName: ref.fileName, kind: ref.kind };
			// Only the renderer's embed branch reads this; links stay links.
			if (inlinePdfs && ref.ext === 'pdf') render.inline = true;
			return render;
		};
	}

	// -------------------------------------------------------------------------
	// §6 Local state for a publish
	// -------------------------------------------------------------------------

	/**
	 * Load `attachments.json` at the start of an AWS publish, creating it when
	 * the mode isn't off. With the mode off an existing file is still loaded
	 * (the sweeps use it). Never skipped on a failed probe: the file is then
	 * created incomplete, so the refs this publish commits are kept.
	 */
	async beginPublish(profile: PublishingProfile): Promise<void> {
		this.states.delete(profile.id);
		this.pendingStaged.delete(profile.id);
		this.thisBatch.set(profile.id, new Set());
		this.oversized.delete(profile.id);
		if (profile.publishMechanism !== 'AWS') return;
		const path = this.plugin.profileManager.getAttachmentsStatePath(profile.id);
		const history = await this.plugin.noteManager.loadPublishHistory(profile.id);
		const historyEmpty = Object.values(history).every(list => list.length === 0);
		const { state, created, probeError } = await loadOrCreateAttachmentState(
			this.store,
			path,
			this.isActive(profile) ? { historyEmpty, probeHasAttachments: () => this.probeBucket(profile) } : null,
		);
		if (probeError) Logger.warn('Attachment completeness probe failed; attachments.json starts incomplete:', probeError);
		if (created) Logger.info(`Created ${path} (complete: ${state?.complete})`);
		if (state) this.states.set(profile.id, state);
	}

	/**
	 * `attachments.json` for a sweep, the audit or a rebuild (P3), whatever the
	 * mode: the running publish's copy, else loaded from disk, else created
	 * (complete when the history is empty or the bucket probe finds no
	 * attachment objects; incomplete when the probe fails). A copy created
	 * during a publish becomes that publish's state.
	 */
	async stateForCleanup(profile: PublishingProfile): Promise<AttachmentStateFile> {
		const running = this.states.get(profile.id);
		if (running) return running;
		const path = this.plugin.profileManager.getAttachmentsStatePath(profile.id);
		const history = await this.plugin.noteManager.loadPublishHistory(profile.id);
		const historyEmpty = Object.values(history).every(list => list.length === 0);
		const { state, created, probeError } = await loadOrCreateAttachmentState(this.store, path, {
			historyEmpty,
			probeHasAttachments: () => this.probeBucket(profile),
		});
		if (probeError) Logger.warn('Attachment completeness probe failed; attachments.json starts incomplete:', probeError);
		if (created) Logger.info(`Created ${path} (complete: ${state?.complete})`);
		// Always non-null: inputs are given, so a missing file is created.
		const out = state ?? emptyAttachmentState(false);
		if (this.thisBatch.has(profile.id)) this.states.set(profile.id, out);
		return out;
	}

	statePath(profileId: string): string {
		return this.plugin.profileManager.getAttachmentsStatePath(profileId);
	}

	getState(profileId: string): AttachmentStateFile | null {
		return this.states.get(profileId) ?? null;
	}

	async saveState(profileId: string): Promise<void> {
		const state = this.states.get(profileId);
		if (!state) return;
		await saveAttachmentState(this.store, this.plugin.profileManager.getAttachmentsStatePath(profileId), state);
	}

	/**
	 * Whether the bucket holds any attachment object: `attachments/` and each
	 * `restricted/<g>/attachments/`, one key each. Throws on failure.
	 */
	async probeBucket(profile: PublishingProfile): Promise<boolean> {
		if (!profile.awsSettings) throw new Error('No AWS settings');
		const s3 = await this.plugin.awsSdkManager.getS3Client(profile);
		const { ListObjectsV2Command } = await awsSdk.s3();
		const Bucket = profile.awsSettings.bucketName;
		const s3Prefix = profile.awsSettings.s3Prefix || '';
		const any = async (Prefix: string) => {
			const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, MaxKeys: 1 }));
			return (page.KeyCount ?? page.Contents?.length ?? 0) > 0;
		};
		if (await any(`${s3Prefix}attachments/`)) return true;
		let token: string | undefined;
		do {
			const page = await s3.send(new ListObjectsV2Command({
				Bucket, Prefix: `${s3Prefix}restricted/`, Delimiter: '/', ContinuationToken: token,
			}));
			for (const p of page.CommonPrefixes ?? []) {
				if (p.Prefix && await any(`${p.Prefix}attachments/`)) return true;
			}
			token = page.IsTruncated ? page.NextContinuationToken : undefined;
		} while (token);
		return false;
	}

	/**
	 * One staged revision (commitPendingNotes): record its refs and the
	 * (area, key) entries its areas need.
	 */
	stageRevision(profileId: string, noteHash: string, access: string[], refs: readonly AttachmentRef[]): void {
		const state = this.states.get(profileId);
		if (state) recordRefs(state, noteHash, refKeys(refs));
		if (refs.length === 0) return;
		const areas = partitionsFor(access).map(p => (p === null ? '' : restrictedPrefix(p)));
		const list = this.pendingStaged.get(profileId) ?? [];
		list.push(...stagedEntriesFor(areas, refs));
		this.pendingStaged.set(profileId, list);
	}

	/**
	 * Merge this commit's entries into `staged-attachments.json` (keeping a
	 * failed earlier batch's), and remember which ids are this batch's.
	 */
	async flushStaged(profileId: string): Promise<void> {
		const added = this.pendingStaged.get(profileId) ?? [];
		this.pendingStaged.delete(profileId);
		if (added.length === 0) return;
		const path = this.plugin.profileManager.getStagedAttachmentsPath(profileId);
		const existing = await loadStagedAttachments(this.store, path);
		const { merged, thisBatch } = mergeStagedAttachments(existing, added);
		await saveStagedAttachments(this.store, path, merged);
		const batch = this.thisBatch.get(profileId) ?? new Set<string>();
		thisBatch.forEach(id => batch.add(id));
		this.thisBatch.set(profileId, batch);
	}

	batchIds(profileId: string): ReadonlySet<string> {
		return this.thisBatch.get(profileId) ?? new Set();
	}

	async loadStaged(profileId: string): Promise<StagedAttachment[]> {
		return loadStagedAttachments(this.store, this.plugin.profileManager.getStagedAttachmentsPath(profileId));
	}

	async saveStaged(profileId: string, entries: readonly StagedAttachment[]): Promise<void> {
		const path = this.plugin.profileManager.getStagedAttachmentsPath(profileId);
		if (entries.length === 0) {
			if (await this.plugin.app.vault.adapter.exists(path)) await this.plugin.app.vault.adapter.remove(path);
			return;
		}
		await saveStagedAttachments(this.store, path, entries);
	}

	/** End of a publish: forget the in-memory state and save the hash cache. */
	async endPublish(profileId: string): Promise<void> {
		this.states.delete(profileId);
		this.pendingStaged.delete(profileId);
		this.thisBatch.delete(profileId);
		this.oversized.delete(profileId);
		await this.saveHashCache().catch(e => Logger.warn('Could not save the attachment hash cache:', e));
	}

	/** File name for notices. */
	static nameOf(vaultPath: string): string {
		return baseNameOf(vaultPath);
	}
}
