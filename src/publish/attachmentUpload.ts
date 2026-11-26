import { awsSdk } from '../utils/awsModules';
import type CommonplaceNotesPlugin from '../main';
import type { PublishingProfile } from '../types';
import { Logger, toError } from '../utils/logging';
import { NoticeManager } from '../utils/notice';
import { effectiveSessionHours } from '../infrastructure/cognitoParams';
import {
	LARGE_UPLOAD_SLOTS,
	SINGLE_PUT_MAX_BYTES,
	attachmentCacheControl,
	attachmentObjectKey,
	contentDispositionFor,
	contentTypeFor,
	createLimiter,
	extensionOf,
	nameList,
	plural,
	recheckStagedAttachments,
	type SiteReadGate,
	type StagedAttachment,
} from '../utils/attachments';
import { isUploaded, recordUploaded } from '../utils/attachmentState';
import { AttachmentChangedError, objectExists, putMultipart, putSingle } from './attachmentS3';

/** At most this many attachment uploads at once (as for notes). */
const MAX_CONCURRENCY = 5;

/**
 * The attachment step of an AWS upload (attachment spec P2 §7), between
 * membership sync and note JSON. Re-checks every staged entry against the
 * current settings and vault, then ensures each (area, key) in S3. Returns
 * false on any failure (staging kept), after a notice; never throws.
 */
export async function uploadStagedAttachments(plugin: CommonplaceNotesPlugin, profile: PublishingProfile): Promise<boolean> {
	const am = plugin.attachmentManager;
	const staged = await am.loadStaged(profile.id);
	if (staged.length === 0) return true;
	if (!profile.awsSettings) return false;

	// --- Re-check before upload --------------------------------------------
	let recheck;
	try {
		const settings = am.settingsFor(profile);
		recheck = await recheckStagedAttachments(staged, {
			settings,
			isExcluded: (path) => plugin.publisher.isPathExcluded(path, profile),
			sizeOf: async (vaultPath) => {
				if (extensionOf(vaultPath) === 'md') return null;
				return (await am.stat(vaultPath))?.size ?? null;
			},
			currentHash: async (vaultPath) => (await am.currentHash(vaultPath)) ?? '',
			thisBatch: am.batchIds(profile.id),
		});
	} catch (error) {
		Logger.error('Attachment re-check failed:', error);
		NoticeManager.showNotice(`Attachment check failed: ${error instanceof Error ? error.message : String(error)}`, 10000);
		return false;
	}

	if (recheck.stop) {
		// This batch's file changed after the pre-staging check. Stop before any
		// upload; on the next publish the entry is an earlier batch's and is
		// dropped instead.
		await am.evictHash(recheck.stop.vaultPath);
		await am.saveHashCache();
		NoticeManager.showNotice(`${recheck.stop.fileName} changed while publishing. Publish the notes that use it again.`, 12000);
		return false;
	}

	if (recheck.dropped.length > 0) {
		for (const { entry, reason } of recheck.dropped) {
			Logger.warn(`Not uploading attachment ${entry.vaultPath} (${entry.area || 'public'}): ${reason}`);
			if (reason === 'changed') await am.evictHash(entry.vaultPath);
		}
		const names = recheck.dropped.map(d => d.entry.fileName);
		const n = new Set(names).size;
		NoticeManager.showNotice(
			`${plural(n, 'attachment')} ${n === 1 ? "wasn't" : "weren't"} uploaded because ${n === 1 ? "it's" : "they're"} now excluded, no longer allowed, or changed since ${n === 1 ? 'it was' : 'they were'} staged: ${nameList(names)}.`,
			12000,
		);
		await am.saveStaged(profile.id, recheck.keep);
	}

	const entries = recheck.keep;
	if (entries.length === 0) return true;
	const state = am.getState(profile.id);
	if (!state) {
		// The mode is on whenever entries pass the re-check, and beginPublish
		// creates the file then. Missing here means it couldn't be written.
		NoticeManager.showNotice('Attachment state (attachments.json) is missing; nothing was uploaded.', 10000);
		return false;
	}

	// --- Per (area, key) ------------------------------------------------------
	const s3 = await plugin.awsSdkManager.getS3Client(profile);
	const bucket = profile.awsSettings.bucketName;
	const s3Prefix = profile.awsSettings.s3Prefix || '';
	const readGate: SiteReadGate = profile.infrastructureState?.readGateMode ?? 'none';
	const sessionHours = effectiveSessionHours(profile.infrastructureState?.cognitoAuth);
	const largeSlot = createLimiter(LARGE_UPLOAD_SLOTS);
	const todo = entries.filter(e => !isUploaded(state, e.area, e.key));

	let changed: StagedAttachment | null = null;
	const { success, error } = await NoticeManager.showProgressWithCounter(
		'Uploading attachments to S3',
		todo.length,
		async (updateProgress) => {
			let completed = 0;
			await runPool(todo, MAX_CONCURRENCY, async (entry) => {
				const key = attachmentObjectKey(s3Prefix, entry.area, entry.key);
				if (!await objectExists(s3, bucket, key)) {
					const headers = {
						ContentType: contentTypeFor(extensionOf(entry.fileName)),
						ContentDisposition: contentDispositionFor(extensionOf(entry.fileName), entry.fileName),
						CacheControl: attachmentCacheControl(entry.area, readGate, sessionHours),
					};
					const fullPath = plugin.attachmentManager.fullPath(entry.vaultPath);
					if (entry.size > SINGLE_PUT_MAX_BYTES) {
						await largeSlot(() => putMultipart(s3, bucket, key, fullPath, entry, headers));
					} else {
						await putSingle(s3, bucket, key, fullPath, entry, headers);
					}
					Logger.debug(`Uploaded attachment ${key}`);
				} else {
					Logger.debug(`Attachment already in the bucket: ${key}`);
				}
				recordUploaded(state, entry.area, entry.key);
				updateProgress(++completed);
			}, (err) => {
				if (err instanceof AttachmentChangedError && !changed) changed = err.entry;
			});
		},
		todo.length > 0 ? `Uploaded ${plural(todo.length, 'attachment')}` : undefined,
		'Attachment upload failed, check console for error details',
	);

	// Saved on failure too, so finished uploads aren't repeated.
	await saveStateQuietly(plugin, profile.id);

	if (changed) {
		const entry = changed as StagedAttachment;
		await am.evictHash(entry.vaultPath);
		await am.saveHashCache();
		NoticeManager.showNotice(`${entry.fileName} changed while publishing. Publish the notes that use it again.`, 12000);
		return false;
	}
	if (!success) {
		if (isCredentialError(error)) {
			NoticeManager.showNotice('S3 permission error — please refresh your AWS credentials and try again.', 10000);
		}
		return false;
	}
	return true;
}

async function saveStateQuietly(plugin: CommonplaceNotesPlugin, profileId: string): Promise<void> {
	try {
		await plugin.attachmentManager.saveState(profileId);
	} catch (e) {
		Logger.error('Could not save attachments.json:', e);
	}
}

/**
 * Run `fn` over `items`, `concurrency` at a time. Stops starting new items
 * after the first failure, waits for those running, then rethrows it.
 * `onError` sees every failure.
 */
async function runPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>, onError: (e: unknown) => void): Promise<void> {
	let index = 0;
	let firstError: unknown = null;
	const worker = async () => {
		while (firstError === null && index < items.length) {
			const item = items[index++];
			try {
				await fn(item);
			} catch (e) {
				onError(e);
				if (firstError === null) firstError = e;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	if (firstError !== null) throw toError(firstError);
}

function isCredentialError(error: unknown): boolean {
	// An S3ServiceException can only exist once the S3 module has loaded.
	const s3 = awsSdk.s3.peek();
	return !!s3 && error instanceof s3.S3ServiceException
		&& ['AccessDenied', 'ExpiredToken', 'ExpiredTokenException', 'InvalidAccessKeyId', 'AuthFailure'].includes(error.name);
}
