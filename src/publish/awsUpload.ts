import { PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, S3ServiceException } from '@aws-sdk/client-s3';
import { CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { TFile, parseYaml } from 'obsidian';
import CommonplaceNotesPlugin from '../main';
import type { PublishingProfile } from '../types';
import { Logger, errorMessage } from '../utils/logging';
import { NoticeManager } from '../utils/notice';
import { renderIndexHtml, renderStylesCss, renderAppJs, renderConfigJson, getFlexSearchJs, renderVendorJs } from './siteRenderer';
import { discoverAssetCustomizations, getAssetsDir } from './assetCustomizations/discovery';
import { partitionRecord, partitionSlugMap, restrictedPrefix, type Partition } from '../utils/access';

/** Cache-Control for objects in a `restricted/<group>/` partition: never stored by browsers. */
const RESTRICTED_CACHE_CONTROL = 'private, no-store';

const MAX_CONCURRENCY = 5;

async function runWithConcurrency<T>(
	items: T[],
	fn: (item: T) => Promise<void>,
	concurrency: number,
	onComplete?: () => void
): Promise<void> {
	let index = 0;
	const execute = async (): Promise<void> => {
		while (index < items.length) {
			const current = index++;
			await fn(items[current]);
			if (onComplete) onComplete();
		}
	};
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => execute());
	await Promise.all(workers);
}

function isCredentialError(error: unknown): boolean {
	if (error instanceof S3ServiceException) {
		return ['AccessDenied', 'ExpiredToken', 'ExpiredTokenException', 'InvalidAccessKeyId', 'AuthFailure'].includes(error.name);
	}
	return false;
}

/** Resolve the home note's UID from the profile's configured home note path. */
function resolveHomeNoteUid(plugin: CommonplaceNotesPlugin, profile: PublishingProfile): string | undefined {
	if (!profile.homeNotePath) return undefined;
	const homeFile = plugin.app.vault.getAbstractFileByPath(profile.homeNotePath);
	if (homeFile instanceof TFile) {
		return plugin.frontmatterManager.getNoteUID(homeFile) || undefined;
	}
	return undefined;
}

/**
 * Render and upload the site's `config.json`. This carries the commenting/auth
 * flags the site client reads via `window.__CPN_CONFIG__`, so it must be kept in
 * sync whenever those settings change. Uploaded both when seeding assets and on
 * every publish (see pushMappingAndIndexToS3) so a normal publish keeps the
 * config current — otherwise a settings change would stay stale until the user
 * manually re-pushed site assets.
 */
async function uploadConfigJson(plugin: CommonplaceNotesPlugin, profile: PublishingProfile): Promise<void> {
	const s3Client = plugin.awsSdkManager.getS3Client(profile);
	const bucket = profile.awsSettings!.bucketName;
	const s3Prefix = profile.awsSettings!.s3Prefix || '';
	const homeNoteUid = resolveHomeNoteUid(plugin, profile);

	await s3Client.send(new PutObjectCommand({
		Bucket: bucket,
		Key: `${s3Prefix}config.json`,
		Body: renderConfigJson(profile, homeNoteUid),
		ContentType: 'application/json',
		CacheControl: 'no-cache',
	}));
	Logger.debug(`Uploaded site asset: ${s3Prefix}config.json`);
}

export async function pushLocalJsonsToS3(
	plugin: CommonplaceNotesPlugin,
	profileId: string,
	triggerCloudFrontInvalidation: boolean = false
): Promise<boolean> {
	try {
		const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);

		if (!profile) {
			throw new Error('No publishing profile provided');
		}

		if (profile.publishMechanism !== 'AWS' || !profile.awsSettings) {
			throw new Error('Selected profile is not configured for AWS publishing');
		}

		const s3Client = plugin.awsSdkManager.getS3Client(profile);
		const bucket = profile.awsSettings.bucketName;
		const s3Prefix = profile.awsSettings.s3Prefix || '';

		const stagedNotesDir = plugin.profileManager.getStagedNotesDir(profileId);

		if (!await plugin.app.vault.adapter.exists(stagedNotesDir)) {
			throw new Error(`Staged notes directory does not exist: ${stagedNotesDir}`);
		}

		// Public notes are staged at the top level; gated copies under
		// restricted/<group>/ (see NoteManager.writeNoteToStaging).
		const noteFiles = await listStagedNoteUploads(plugin, profileId, s3Prefix);
		const hasAccessChanges = plugin.accessManager.peekTransitions(profileId).length > 0;

		if (noteFiles.length === 0 && !hasAccessChanges) {
			Logger.debug('No staged note files to upload');
			NoticeManager.showNotice('No staged notes to upload');
			return true;
		}

		// Membership first, so readers of newly gated notes can get in. Best
		// effort: a stale membership file only ever denies (fail closed).
		try {
			await plugin.syncAccessGroups(profile);
		} catch (err) {
			Logger.warn('Access-group membership sync failed:', err);
			NoticeManager.showNotice(`Could not sync access-group membership: ${errorMessage(err)}`, 10000);
		}

		const { success, error } = await NoticeManager.showProgressWithCounter(
			'Uploading notes to S3',
			noteFiles.length,
			async (updateProgress) => {
				let completed = 0;
				await runWithConcurrency(noteFiles, async ({ path: filePath, key, restricted }) => {
					const content = await plugin.app.vault.adapter.read(filePath);

					await s3Client.send(new PutObjectCommand({
						Bucket: bucket,
						Key: key,
						Body: content,
						ContentType: 'application/json',
						...(restricted ? { CacheControl: RESTRICTED_CACHE_CONTROL } : {}),
					}));

					completed++;
					updateProgress(completed);
					Logger.debug(`Uploaded ${key}`);
				}, MAX_CONCURRENCY);
			},
			`Successfully uploaded ${noteFiles.length} notes to S3`,
			`Notes upload failed, check console for error details`
		);

		if (!success) {
			if (isCredentialError(error)) {
				NoticeManager.showNotice('S3 permission error — please refresh your AWS credentials and try again.', 10000);
			}
			return false;
		}

		await pushMappingAndIndexToS3(plugin, profileId);

		// Remove copies from partitions notes left (e.g. public -> gated). Runs
		// after the new mappings are live so no mapping points at a deleted key.
		const removedAny = await applyAccessTransitions(plugin, profileId);
		if (removedAny === null) return false; // credential error, already reported

		// An access change must reach the edge cache now, whatever the profile's
		// invalidation scheme: a formerly public copy may still be cached.
		if (triggerCloudFrontInvalidation || removedAny) {
			await createCloudFrontInvalidation(plugin, profileId);
		}

		return true;
	} catch (error) {
		Logger.error('Error during S3 upload:', error);
		if (isCredentialError(error)) {
			NoticeManager.showNotice('S3 permission error — please refresh your AWS credentials and try again.', 10000);
		} else {
			NoticeManager.showNotice(`Upload failed: ${errorMessage(error)}`);
		}
		return false;
	}
}

export async function pushMappingAndIndexToS3(
	plugin: CommonplaceNotesPlugin,
	profileId: string
): Promise<void> {
	const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
	if (!profile?.awsSettings) {
		throw new Error('Selected profile is not configured for AWS publishing');
	}

	const s3Client = plugin.awsSdkManager.getS3Client(profile);
	const bucket = profile.awsSettings.bucketName;
	const s3Prefix = profile.awsSettings.s3Prefix || '';

	const mappingDir = plugin.profileManager.getMappingDir(profileId);
	if (!await plugin.app.vault.adapter.exists(mappingDir)) {
		throw new Error(`Mapping directory does not exist: ${mappingDir}`);
	}

	// Split every site-wide aggregate by access: the public copies exclude gated
	// notes entirely, and each group gets its own mirror under restricted/<group>/.
	// Groups defined in settings but without notes still get (empty) mirrors so
	// the SPA's per-group fetches never hit a missing key.
	await plugin.accessManager.ensureLoaded(profileId);
	const accessOf = (uid: string) => plugin.accessManager.getGroups(profileId, uid);
	const groupNames = [...new Set([
		...Object.keys(profile.accessGroups || {}),
		...plugin.accessManager.groupsInUse(profileId),
	])].sort();

	const readJson = async <T>(p: string, fallback: T): Promise<T> => {
		if (!await plugin.app.vault.adapter.exists(p)) return fallback;
		return JSON.parse(await plugin.app.vault.adapter.read(p)) as T;
	};
	const slugToUid = await readJson<Record<string, string>>(`${mappingDir}/slug-to-uid.json`, {});
	const uidToHash = await readJson<Record<string, string>>(`${mappingDir}/uid-to-hash.json`, {});
	const slugParts = partitionSlugMap(slugToUid, accessOf, groupNames);
	const hashParts = partitionRecord(uidToHash, accessOf, groupNames);

	const uploads: Array<{ key: string; body: string; restricted: boolean }> = [
		{ key: `${s3Prefix}static/mapping/slug-to-uid.json`, body: JSON.stringify(slugParts.publicView), restricted: false },
		{ key: `${s3Prefix}static/mapping/uid-to-hash.json`, body: JSON.stringify(hashParts.publicView), restricted: false },
	];
	for (const g of groupNames) {
		const base = `${s3Prefix}${restrictedPrefix(g)}static/mapping/`;
		uploads.push(
			{ key: `${base}slug-to-uid.json`, body: JSON.stringify(slugParts.groupViews[g] || {}), restricted: true },
			{ key: `${base}uid-to-hash.json`, body: JSON.stringify(hashParts.groupViews[g] || {}), restricted: true },
		);
	}

	const { success } = await NoticeManager.showProgressWithCounter(
		'Uploading mappings to S3',
		uploads.length,
		async (updateProgress) => {
			let completed = 0;
			await runWithConcurrency(uploads, async ({ key, body, restricted }) => {
				await s3Client.send(new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					Body: body,
					ContentType: 'application/json',
					...(restricted ? { CacheControl: RESTRICTED_CACHE_CONTROL } : {}),
				}));
				completed++;
				updateProgress(completed);
				Logger.debug(`Uploaded mapping: ${key}`);
			}, MAX_CONCURRENCY);
		},
		`Mapping files successfully uploaded to S3`,
		`Mapping upload failed, check console for error details`
	);
	if (!success) throw new Error('Mapping upload failed');

	if (profile.publishContentIndex) {
		const contentIndexPath = plugin.profileManager.getContentIndexPath(profileId);

		if (!await plugin.app.vault.adapter.exists(contentIndexPath)) {
			Logger.warn(`Content index file does not exist: ${contentIndexPath}`);
			NoticeManager.showNotice('No content index file found to upload');
		} else {
			// Gated notes are never queued into the index, but filter again so a
			// stale local entry (e.g. from before the note was gated) can't leak.
			const index = JSON.parse(await plugin.app.vault.adapter.read(contentIndexPath)) as Record<string, unknown>;
			const content = JSON.stringify(partitionRecord(index, accessOf, []).publicView);
			const key = `${s3Prefix}static/content/contentIndex.json`;

			const { success } = await NoticeManager.showProgress(
				`Uploading content index to S3`,
				s3Client.send(new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					Body: content,
					ContentType: 'application/json',
				})),
				`Content index successfully uploaded to S3`,
				`Content index upload failed, check console for error details`
			);

			if (!success) throw new Error('Content index upload failed');
			Logger.debug(`Uploaded content index: ${key}`);
		}
	}

	// Upload changed chat-corpus artifacts (kb/{uid}.md) when chat is enabled.
	// Incremental: only UIDs staged this publish are pushed.
	if (profile.chat?.enabled) {
		await pushKbCorpusToS3(plugin, profileId);
	}

	// Refresh config.json so commenting/auth (and theme/home) flags stay in sync
	// on every publish — without this a settings change would not reach the site
	// until the user manually re-pushed site assets.
	await uploadConfigJson(plugin, profile);
}

/**
 * Upload the per-UID chat corpus artifacts changed since the last push to
 * `${s3Prefix}kb/{uid}.md`. Incremental by design — the KbCorpusManager tracks
 * which UIDs changed this publish, so unchanged notes are not re-uploaded. The
 * Bedrock Knowledge Base data source is scoped to this `kb/` prefix.
 */
export async function pushKbCorpusToS3(
	plugin: CommonplaceNotesPlugin,
	profileId: string
): Promise<void> {
	const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
	if (!profile?.awsSettings) {
		throw new Error('Selected profile is not configured for AWS publishing');
	}

	const changedUids = plugin.kbCorpusManager.consumeChangedUids(profileId);
	if (changedUids.length === 0) {
		Logger.debug(`No changed KB corpus artifacts to upload for profile ${profileId}`);
		return;
	}

	const s3Client = plugin.awsSdkManager.getS3Client(profile);
	const bucket = profile.awsSettings.bucketName;
	const s3Prefix = profile.awsSettings.s3Prefix || '';

	const { success } = await NoticeManager.showProgressWithCounter(
		'Uploading chat corpus to S3',
		changedUids.length,
		async (updateProgress) => {
			let completed = 0;
			await runWithConcurrency(changedUids, async (uid) => {
				const localPath = plugin.profileManager.getKbCorpusPath(profileId, uid);
				if (!await plugin.app.vault.adapter.exists(localPath)) {
					Logger.warn(`KB corpus artifact missing locally, skipping upload: ${localPath}`);
					return;
				}
				const body = await plugin.app.vault.adapter.read(localPath);
				const key = `${s3Prefix}kb/${uid}.md`;
				await s3Client.send(new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					Body: body,
					ContentType: 'text/markdown',
				}));
				completed++;
				updateProgress(completed);
				Logger.debug(`Uploaded KB corpus artifact: ${key}`);
			}, MAX_CONCURRENCY);
		},
		`Chat corpus successfully uploaded to S3`,
		`Chat corpus upload failed, check console for error details`
	);

	if (!success) throw new Error('Chat corpus upload failed');
}

/**
 * Delete a single note's chat corpus artifact `${s3Prefix}kb/{uid}.md`. Called
 * from the note-delete path — a wholesale content-index re-push cannot orphan-
 * remove a per-UID object, so the delete must be explicit and keyed by UID.
 * Returns false on a credential error (so the caller can stop), throws otherwise.
 */
export async function deleteKbCorpusFromS3(
	plugin: CommonplaceNotesPlugin,
	profileId: string,
	uid: string
): Promise<boolean> {
	const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
	if (!profile?.awsSettings) {
		throw new Error('Selected profile is not configured for AWS publishing');
	}

	const s3Client = plugin.awsSdkManager.getS3Client(profile);
	const bucket = profile.awsSettings.bucketName;
	const s3Prefix = profile.awsSettings.s3Prefix || '';
	const key = `${s3Prefix}kb/${uid}.md`;

	try {
		await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
		Logger.debug(`Deleted KB corpus artifact ${key}`);
		return true;
	} catch (error) {
		if (isCredentialError(error)) {
			NoticeManager.showNotice(
				'S3 permission error — please refresh your AWS credentials and try again.',
				10000
			);
			Logger.error('S3 permission error during KB corpus delete:', error);
			return false;
		}
		Logger.error('Error deleting KB corpus artifact from S3:', error);
		throw error;
	}
}

export async function deleteNoteHashesFromS3(
	plugin: CommonplaceNotesPlugin,
	profileId: string,
	hashes: string[],
	/** '' for the public `notes/`, or `restricted/<group>/` for a group partition. */
	partitionPrefix: string = ''
): Promise<boolean> {
	const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
	if (!profile?.awsSettings) {
		throw new Error('Selected profile is not configured for AWS publishing');
	}

	const s3Client = plugin.awsSdkManager.getS3Client(profile);
	const bucket = profile.awsSettings.bucketName;
	const s3Prefix = profile.awsSettings.s3Prefix || '';

	try {
		if (hashes.length <= 5) {
			for (const hash of hashes) {
				const key = `${s3Prefix}${partitionPrefix}notes/${hash}.json`;
				await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
				Logger.debug(`Deleted ${key}`);
			}
		} else {
			const objects = hashes.map(hash => ({ Key: `${s3Prefix}${partitionPrefix}notes/${hash}.json` }));
			const response = await s3Client.send(new DeleteObjectsCommand({
				Bucket: bucket,
				Delete: { Objects: objects },
			}));

			if (response.Errors && response.Errors.length > 0) {
				for (const err of response.Errors) {
					Logger.error(`Failed to delete ${err.Key}: ${err.Code} - ${err.Message}`);
				}
				throw new Error(`Batch delete had ${response.Errors.length} error(s)`);
			}

			Logger.debug(`Batch deleted ${hashes.length} objects`);
		}

		return true;
	} catch (error) {
		if (isCredentialError(error)) {
			NoticeManager.showNotice(
				'S3 permission error — please refresh your AWS credentials and try again.',
				10000
			);
			Logger.error('S3 permission error during delete:', error);
			return false;
		}
		Logger.error('Error deleting from S3:', error);
		throw error;
	}
}

/** A staged note JSON and the S3 key it uploads to. */
interface StagedNoteUpload {
	path: string;
	key: string;
	restricted: boolean;
}

/**
 * Staged note JSONs for this profile: public ones at the top of staged-notes/
 * (-> `notes/`), gated copies under staged-notes/restricted/<group>/
 * (-> `restricted/<group>/notes/`).
 */
async function listStagedNoteUploads(
	plugin: CommonplaceNotesPlugin,
	profileId: string,
	s3Prefix: string,
): Promise<StagedNoteUpload[]> {
	const adapter = plugin.app.vault.adapter;
	const stagedNotesDir = plugin.profileManager.getStagedNotesDir(profileId);
	const out: StagedNoteUpload[] = [];
	const top = await adapter.list(stagedNotesDir);
	for (const f of top.files.filter(f => f.endsWith('.json'))) {
		out.push({ path: f, key: `${s3Prefix}notes/${f.split('/').pop()}`, restricted: false });
	}
	const restrictedDir = `${stagedNotesDir}/restricted`;
	if (await adapter.exists(restrictedDir)) {
		const groups = await adapter.list(restrictedDir);
		for (const groupDir of groups.folders) {
			const group = groupDir.split('/').pop()!;
			const files = await adapter.list(groupDir);
			for (const f of files.files.filter(f => f.endsWith('.json'))) {
				out.push({
					path: f,
					key: `${s3Prefix}${restrictedPrefix(group)}notes/${f.split('/').pop()}`,
					restricted: true,
				});
			}
		}
	}
	return out;
}

/**
 * Delete note copies from the partitions notes left this publish (drained from
 * AccessManager), then persist the access map. Every historical hash of the
 * note is removed from each partition it left, so old permalinks there go too.
 * Returns true if anything was deleted, false if nothing to do, or null on a
 * credential error (already reported).
 */
export async function applyAccessTransitions(
	plugin: CommonplaceNotesPlugin,
	profileId: string,
): Promise<boolean | null> {
	const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
	if (!profile?.awsSettings) return false;

	const transitions = plugin.accessManager.consumeTransitions(profileId);
	const homeRemoved = plugin.accessManager.consumeHomeRemoved(profileId);
	if (transitions.length === 0 && !homeRemoved) {
		await plugin.accessManager.save(profileId);
		return false;
	}

	const history = await plugin.noteManager.loadPublishHistory(profileId);
	// Group the deletes per partition to batch them.
	const byPartition = new Map<string, Set<string>>();
	const leftPublic: string[] = [];
	for (const t of transitions) {
		const hashes = history[t.uid] || [];
		const keep = new Set((t.to ?? []).map((p: Partition) => p ?? ''));
		for (const p of t.from) {
			const k = p ?? '';
			if (keep.has(k)) continue;
			if (p === null) leftPublic.push(t.uid);
			if (!byPartition.has(k)) byPartition.set(k, new Set());
			hashes.forEach(h => byPartition.get(k)!.add(h));
		}
	}

	for (const [k, hashes] of byPartition) {
		if (hashes.size === 0) continue;
		const prefix = k === '' ? '' : restrictedPrefix(k);
		const ok = await deleteNoteHashesFromS3(plugin, profileId, [...hashes], prefix);
		if (!ok) return null;
		Logger.info(`Access change: removed ${hashes.size} note version(s) from ${prefix || 'notes/'}`);
	}

	if (homeRemoved) {
		const s3Client = plugin.awsSdkManager.getS3Client(profile);
		await s3Client.send(new DeleteObjectCommand({
			Bucket: profile.awsSettings.bucketName,
			Key: `${profile.awsSettings.s3Prefix || ''}notes/index.json`,
		}));
	}

	// Notes that left the public partition also leave the chat corpus.
	if (profile.chat?.enabled) {
		for (const uid of leftPublic) {
			const ok = await deleteKbCorpusFromS3(plugin, profileId, uid);
			if (!ok) return null;
		}
	}

	await plugin.accessManager.save(profileId);
	return true;
}

/**
 * Delete every object under a group partition (`restricted/<group>/`), e.g.
 * after the group is removed from settings. Returns the number deleted.
 */
export async function purgeRestrictedPartition(
	plugin: CommonplaceNotesPlugin,
	profileId: string,
	group: string,
): Promise<number> {
	const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
	if (!profile?.awsSettings) return 0;
	const s3Client = plugin.awsSdkManager.getS3Client(profile);
	const bucket = profile.awsSettings.bucketName;
	const prefix = `${profile.awsSettings.s3Prefix || ''}${restrictedPrefix(group)}`;
	let deleted = 0;
	let token: string | undefined;
	do {
		const page = await s3Client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
		const keys = (page.Contents || []).map(o => ({ Key: o.Key! })).filter(o => o.Key);
		if (keys.length > 0) {
			await s3Client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
			deleted += keys.length;
		}
		token = page.IsTruncated ? page.NextContinuationToken : undefined;
	} while (token);
	return deleted;
}

export async function pushSiteAssetsToS3(
	plugin: CommonplaceNotesPlugin,
	profileId: string
): Promise<boolean> {
	try {
		const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);

		if (!profile) {
			throw new Error('No publishing profile provided');
		}

		if (profile.publishMechanism !== 'AWS' || !profile.awsSettings) {
			throw new Error('Selected profile is not configured for AWS publishing');
		}

		const s3Client = plugin.awsSdkManager.getS3Client(profile);
		const bucket = profile.awsSettings.bucketName;
		const s3Prefix = profile.awsSettings.s3Prefix || '';

		// Resolve home note UID from the configured home note path
		const homeNoteUid = resolveHomeNoteUid(plugin, profile);

		// Discover per-profile snippet customizations authored as vault notes
		// (route 2). Pre-resolved here so the (synchronous) renderers receive
		// them the same way homeNoteUid is threaded in.
		const assetsDir = getAssetsDir(plugin.settings.cpnDirectory, profileId);
		const { customizations, errors: customizationErrors } = await discoverAssetCustomizations(
			plugin.app.vault,
			plugin.app.metadataCache,
			assetsDir,
			parseYaml,
		);
		if (customizationErrors.length > 0) {
			for (const err of customizationErrors) {
				Logger.warn(`Asset customization skipped: ${err.filePath} — ${err.message}`);
			}
			NoticeManager.showNotice(
				`${customizationErrors.length} asset customization note(s) skipped; see console.`,
				8000
			);
		}
		if (customizations.length > 0) {
			Logger.info(`Applying ${customizations.length} asset customization snippet(s) for profile ${profileId}`);
		}

		const assets: { key: string; body: string; contentType: string; cacheControl: string }[] = [
			{
				key: `${s3Prefix}index.html`,
				body: renderIndexHtml(profile, homeNoteUid, customizations),
				contentType: 'text/html',
				cacheControl: 'no-cache',
			},
			{
				key: `${s3Prefix}styles.css`,
				body: renderStylesCss(profile, customizations),
				contentType: 'text/css',
				cacheControl: 'public, max-age=31536000, immutable',
			},
			{
				key: `${s3Prefix}app.js`,
				body: renderAppJs(),
				contentType: 'application/javascript',
				cacheControl: 'public, max-age=31536000, immutable',
			},
			{
				key: `${s3Prefix}flexsearch.min.js`,
				body: getFlexSearchJs(),
				contentType: 'application/javascript',
				cacheControl: 'public, max-age=31536000, immutable',
			},
			{
				key: `${s3Prefix}vendor.js`,
				body: renderVendorJs(),
				contentType: 'application/javascript',
				cacheControl: 'public, max-age=31536000, immutable',
			},
			{
				key: `${s3Prefix}config.json`,
				body: renderConfigJson(profile, homeNoteUid),
				contentType: 'application/json',
				cacheControl: 'no-cache',
			},
		];

		const { success, error } = await NoticeManager.showProgress(
			'Uploading site assets to S3',
			(async () => {
				for (const asset of assets) {
					await s3Client.send(new PutObjectCommand({
						Bucket: bucket,
						Key: asset.key,
						Body: asset.body,
						ContentType: asset.contentType,
						CacheControl: asset.cacheControl,
					}));
					Logger.debug(`Uploaded site asset: ${asset.key}`);
				}
			})(),
			'Site assets uploaded successfully',
			'Site assets upload failed, check console for error details'
		);

		if (!success) {
			if (isCredentialError(error)) {
				NoticeManager.showNotice('S3 permission error — please refresh your AWS credentials and try again.', 10000);
			}
			return false;
		}

		return true;
	} catch (error) {
		Logger.error('Error uploading site assets:', error);
		if (isCredentialError(error)) {
			NoticeManager.showNotice('S3 permission error — please refresh your AWS credentials and try again.', 10000);
		} else {
			NoticeManager.showNotice(`Site assets upload failed: ${errorMessage(error)}`);
		}
		return false;
	}
}

export async function createCloudFrontInvalidation(plugin: CommonplaceNotesPlugin, profileId: string): Promise<boolean> {
	try {
		const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
		if (!profile?.awsSettings?.cloudFrontDistributionId) {
			Logger.debug('No CloudFront distribution ID configured, skipping invalidation');
			return false;
		}

		const cfClient = plugin.awsSdkManager.getCloudFrontClient(profile);

		const { success, error } = await NoticeManager.showProgress(
			`Creating CloudFront invalidation`,
			cfClient.send(new CreateInvalidationCommand({
				DistributionId: profile.awsSettings.cloudFrontDistributionId,
				InvalidationBatch: {
					Paths: { Quantity: 1, Items: ['/*'] },
					CallerReference: Date.now().toString(),
				},
			})),
			`CloudFront invalidation created successfully`,
			`CloudFront invalidation failed, check console for error details`
		);

		if (!success) {
			throw error;
		}

		return true;
	} catch (error) {
		Logger.error('Failed to create CloudFront invalidation:', error);
		NoticeManager.showNotice('Failed to create CloudFront invalidation: ' + errorMessage(error));
		return false;
	}
}
