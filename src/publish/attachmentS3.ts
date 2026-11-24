/**
 * S3 transfer of one attachment (attachment spec P2 §7, Step 2–3). No
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
	HeadObjectCommand,
	PutObjectCommand,
	UploadPartCommand,
	type CompletedPart,
	type S3Client,
} from '@aws-sdk/client-s3';
import { promises as fsp } from 'fs';
import { createHash } from 'crypto';
import { Logger } from '../utils/logging';
import { MULTIPART_PARTS_IN_FLIGHT, MULTIPART_PART_BYTES, type StagedAttachment } from '../utils/attachments';

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
			if (failure !== null) throw failure;
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
		if (failure !== null) throw failure;
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
