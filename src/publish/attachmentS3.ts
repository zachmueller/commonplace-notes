/**
 * S3 transfer of one attachment (attachment spec P2 §7, Step 2–3), and the
 * bucket reads and deletes cleanup uses (P3 §2–§4). No
 * Obsidian imports, so the unit test can drive it with a fake S3 client
 * (e2e/scripts/test-attachment-upload.ts).
 *
 * Bytes are hashed as they are sent, so an object can only ever hold bytes
 * that match its key.
 */

import {
	AbortMultipartUploadCommand,
	CompleteMultipartUploadCommand,
	CreateMultipartUploadCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	UploadPartCommand,
	type CompletedPart,
	type S3Client,
} from '@aws-sdk/client-s3';
import { promises as fsp } from 'fs';
import { createHash } from 'crypto';
import { Logger, toError } from '../utils/logging';
import {
	MULTIPART_PARTS_IN_FLIGHT,
	MULTIPART_PART_BYTES,
	attachmentObjectKey,
	parseAttachmentKey,
	type StagedAttachment,
} from '../utils/attachments';

/** The part of S3Client this module uses. */
export type S3Sender = Pick<S3Client, 'send'>;

/** The bytes sent didn't hash to the key's sha256: the file changed mid-upload. */
export class AttachmentChangedError extends Error {
	constructor(readonly entry: StagedAttachment) {
		super(`${entry.fileName} changed while publishing`);
	}
}

/**
 * HeadObject: 200 → it exists (recovers a lost manifest). 404 → missing. A 403
 * also counts as missing: without s3:ListBucket, S3 reports a missing key as
 * 403. Anything else throws.
 */
export async function objectExists(s3: S3Sender, Bucket: string, Key: string): Promise<boolean> {
	try {
		await s3.send(new HeadObjectCommand({ Bucket, Key }));
		return true;
	} catch (e) {
		const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
		const name = (e as { name?: string }).name;
		if (status === 404 || status === 403 || name === 'NotFound' || name === 'NoSuchKey') return false;
		throw e;
	}
}

export interface UploadHeaders {
	ContentType: string;
	ContentDisposition: string;
	CacheControl: string;
}

/** Up to 16 MB: read, hash, compare, then one PutObject (the SDK adds CRC32). */
export async function putSingle(s3: S3Sender, Bucket: string, Key: string, fullPath: string, entry: StagedAttachment, headers: UploadHeaders): Promise<void> {
	const body = await fsp.readFile(fullPath);
	const digest = createHash('sha256').update(body).digest('hex');
	if (digest !== entry.sha256) throw new AttachmentChangedError(entry);
	await s3.send(new PutObjectCommand({ Bucket, Key, Body: body, ...headers }));
}

/**
 * Larger files: multipart, 8 MB parts read in order from one file handle and
 * fed to a running hash, up to 4 parts in flight. The final digest is checked
 * before CompleteMultipartUpload; on a mismatch or any failure the upload is
 * aborted, so no object is created. CRC32 part checksums match the SDK's
 * default for PutObject/UploadPart.
 */
export async function putMultipart(
	s3: S3Sender,
	Bucket: string,
	Key: string,
	fullPath: string,
	entry: StagedAttachment,
	headers: UploadHeaders,
	partBytes: number = MULTIPART_PART_BYTES,
): Promise<void> {
	const create = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key, ChecksumAlgorithm: 'CRC32', ...headers }));
	const UploadId = create.UploadId;
	if (!UploadId) throw new Error(`CreateMultipartUpload returned no UploadId for ${Key}`);
	const handle = await fsp.open(fullPath, 'r');
	const hash = createHash('sha256');
	const parts: CompletedPart[] = [];
	const inflight = new Set<Promise<void>>();
	let failure: unknown = null;
	try {
		let partNumber = 0;
		for (;;) {
			// Wait for a free slot before reading, so at most 4 parts are in memory.
			while (inflight.size >= MULTIPART_PARTS_IN_FLIGHT) await Promise.race(inflight);
			if (failure !== null) throw toError(failure);
			const buffer = Buffer.alloc(partBytes);
			const { bytesRead } = await handle.read(buffer, 0, partBytes, null);
			if (bytesRead === 0) break;
			const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
			hash.update(chunk);
			const PartNumber = ++partNumber;
			const job: Promise<void> = s3.send(new UploadPartCommand({
				Bucket, Key, UploadId, PartNumber, Body: chunk, ChecksumAlgorithm: 'CRC32',
			})).then(res => {
				parts.push({ PartNumber, ETag: res.ETag, ChecksumCRC32: res.ChecksumCRC32 });
			}, (e: unknown) => {
				if (failure === null) failure = e;
			}).finally(() => {
				inflight.delete(job);
			});
			inflight.add(job);
		}
		await Promise.all(inflight);
		if (failure !== null) throw toError(failure);
		if (hash.digest('hex') !== entry.sha256) throw new AttachmentChangedError(entry);
		parts.sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0));
		await s3.send(new CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: parts } }));
	} catch (e) {
		await Promise.allSettled(inflight);
		try {
			await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
		} catch (abortError) {
			Logger.warn(`Could not abort multipart upload ${UploadId} for ${Key}:`, abortError);
		}
		throw e;
	} finally {
		await handle.close();
	}
}

// ---------------------------------------------------------------------------
// Cleanup (attachment spec P3)
// ---------------------------------------------------------------------------

/** Every key under `Prefix`, paged. */
export async function listKeys(s3: S3Sender, Bucket: string, Prefix: string): Promise<string[]> {
	const out: string[] = [];
	let token: string | undefined;
	do {
		const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken: token }));
		for (const o of page.Contents ?? []) if (o.Key) out.push(o.Key);
		token = page.IsTruncated ? page.NextContinuationToken : undefined;
	} while (token);
	return out;
}

/** The bucket's areas: '' plus each `restricted/<g>/` that holds any object. */
export async function listAreas(s3: S3Sender, Bucket: string, s3Prefix: string): Promise<string[]> {
	const areas = [''];
	const base = `${s3Prefix}restricted/`;
	let token: string | undefined;
	do {
		const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: base, Delimiter: '/', ContinuationToken: token }));
		for (const p of page.CommonPrefixes ?? []) {
			if (p.Prefix?.startsWith(base)) areas.push(p.Prefix.slice(s3Prefix.length));
		}
		token = page.IsTruncated ? page.NextContinuationToken : undefined;
	} while (token);
	return areas;
}

/** Area → attachment keys (`<sha256>/<fileName>`) its `attachments/` holds. */
export async function listAttachmentObjects(s3: S3Sender, Bucket: string, s3Prefix: string, areas: readonly string[]): Promise<Record<string, string[]>> {
	const out: Record<string, string[]> = {};
	for (const area of areas) {
		const prefix = attachmentObjectKey(s3Prefix, area, '');
		const keys = (await listKeys(s3, Bucket, prefix)).map(k => k.slice(prefix.length)).filter(k => k.length > 0);
		if (keys.length > 0) out[area] = keys.sort();
	}
	return out;
}

/** A published note JSON to read during a rebuild. */
export interface NoteObject {
	/** S3 key. */
	key: string;
	/** From the file name, or null for `notes/index.json` (read from its `hash`). */
	hash: string | null;
}

/**
 * Rebuild steps 1 and 3: the note JSONs under `notes/` and each
 * `restricted/<g>/notes/` (one per hash, skipping hashes in `known`, whose
 * refs are already authoritative locally), and the attachment listing that
 * replaces `uploaded`.
 */
export async function listForRebuild(
	s3: S3Sender,
	Bucket: string,
	s3Prefix: string,
	known: ReadonlySet<string>,
): Promise<{ notes: NoteObject[]; uploaded: Record<string, string[]> }> {
	const areas = await listAreas(s3, Bucket, s3Prefix);
	const byHash = new Map<string, NoteObject>();
	const homes: NoteObject[] = [];
	for (const area of areas) {
		const prefix = `${s3Prefix}${area}notes/`;
		for (const key of await listKeys(s3, Bucket, prefix)) {
			const name = key.slice(prefix.length);
			if (name.includes('/') || !name.endsWith('.json')) continue;
			const stem = name.slice(0, -'.json'.length);
			if (stem === 'index') {
				homes.push({ key, hash: null });
				continue;
			}
			if (!known.has(stem) && !byHash.has(stem)) byHash.set(stem, { key, hash: stem });
		}
	}
	const uploaded = await listAttachmentObjects(s3, Bucket, s3Prefix, areas);
	return { notes: [...byHash.values(), ...homes], uploaded };
}

/** Rebuild step 2 for one note JSON: its hash and `attachments` keys, or null when it is gone. */
export async function readNoteAttachments(s3: S3Sender, Bucket: string, note: NoteObject): Promise<{ hash: string; keys: string[] } | null> {
	let text: string;
	try {
		const res = await s3.send(new GetObjectCommand({ Bucket, Key: note.key }));
		text = await (res.Body as { transformToString(): Promise<string> } | undefined)?.transformToString() ?? '';
	} catch (e) {
		// Deleted between the listing and the read: it records nothing.
		const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
		if (status === 404 || (e as { name?: string }).name === 'NoSuchKey') return null;
		throw e;
	}
	let json: { hash?: unknown; attachments?: unknown };
	try {
		json = JSON.parse(text) as typeof json;
	} catch {
		Logger.warn(`Skipping unreadable note JSON ${note.key}`);
		return null;
	}
	const hash = note.hash ?? (typeof json.hash === 'string' ? json.hash : null);
	if (!hash) return null;
	// Pre-feature revisions have no field, so they correctly record nothing.
	const list = Array.isArray(json.attachments) ? json.attachments : [];
	const keys = list
		.map(a => (a && typeof a === 'object' ? (a as { key?: unknown }).key : undefined))
		.filter((k): k is string => typeof k === 'string' && parseAttachmentKey(k) !== null);
	return { hash, keys: [...new Set(keys)].sort() };
}

/** The outcome of deleting one area's keys. */
export interface DeleteResult {
	deleted: string[];
	/** Keys not deleted: per-key errors, or every key of a batch whose call failed. */
	failed: string[];
	/** The first error, for the log. */
	error?: unknown;
}

/** DeleteObjects allows at most this many keys per call. */
export const DELETE_BATCH = 1000;

/**
 * Delete attachment keys from one area with DeleteObjects, in batches of
 * 1000. Never throws: a failed call marks its whole batch failed and later
 * batches still run.
 */
export async function deleteAttachmentObjects(
	s3: S3Sender,
	Bucket: string,
	s3Prefix: string,
	area: string,
	keys: readonly string[],
): Promise<DeleteResult> {
	const result: DeleteResult = { deleted: [], failed: [] };
	const prefix = attachmentObjectKey(s3Prefix, area, '');
	for (let i = 0; i < keys.length; i += DELETE_BATCH) {
		const batch = keys.slice(i, i + DELETE_BATCH);
		try {
			const res = await s3.send(new DeleteObjectsCommand({
				Bucket,
				Delete: { Objects: batch.map(k => ({ Key: prefix + k })), Quiet: true },
			}));
			const errored = new Set<string>();
			for (const err of res.Errors ?? []) {
				if (!err.Key?.startsWith(prefix)) continue;
				errored.add(err.Key.slice(prefix.length));
				Logger.error(`Could not delete ${err.Key}: ${err.Code} ${err.Message}`);
				if (result.error === undefined) result.error = new Error(`${err.Code}: ${err.Message}`);
			}
			for (const k of batch) (errored.has(k) ? result.failed : result.deleted).push(k);
		} catch (e) {
			if (result.error === undefined) result.error = e;
			result.failed.push(...batch);
		}
	}
	return result;
}
