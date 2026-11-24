#!/usr/bin/env npx tsx
/**
 * Attachment S3 transfer unit test (attachment spec P2 §7).
 *
 * Drives src/publish/attachmentS3.ts with a fake S3 client and real temp
 * files (small part size so a few KB make several parts):
 *   1. HeadObject: 200 exists; 404 and 403 count as missing; 500 throws.
 *   2. putSingle: headers set; a hash mismatch throws AttachmentChangedError
 *      and never sends PutObject.
 *   3. putMultipart: CRC32 on CreateMultipartUpload and each UploadPart,
 *      parts completed in order with ETag + ChecksumCRC32, headers on create,
 *      at most 4 parts in flight, no abort.
 *   4. putMultipart hash mismatch (file changed): aborted, never completed.
 *   5. putMultipart part failure: aborted, error rethrown.
 *
 * The real-S3 checks (CRC32 accepted, no incomplete uploads left) are in the
 * sandbox end-to-end run.
 *
 * Run: npx tsx e2e/scripts/test-attachment-upload.ts
 */

import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import * as s3Module from '../../src/publish/attachmentS3';

const m: typeof import('../../src/publish/attachmentS3') =
	(s3Module as any).putMultipart ? s3Module : (s3Module as any).default;

const failures: string[] = [];
let checks = 0;
function check(name: string, ok: boolean, detail: unknown = ''): void {
	checks++;
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures.push(name);
		console.log(`FAIL  ${name}${detail !== '' ? `\n        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
	}
}

interface Call { name: string; input: any }

function fakeS3(opts: { headStatus?: number; failPart?: number } = {}) {
	const calls: Call[] = [];
	let inflight = 0;
	let peak = 0;
	const send = async (cmd: any): Promise<any> => {
		const name: string = cmd.constructor.name;
		calls.push({ name, input: cmd.input });
		switch (name) {
			case 'HeadObjectCommand': {
				const status = opts.headStatus ?? 404;
				if (status === 200) return {};
				const err: any = new Error(`status ${status}`);
				err.name = status === 404 ? 'NotFound' : status === 403 ? 'Forbidden' : 'InternalError';
				err.$metadata = { httpStatusCode: status };
				throw err;
			}
			case 'CreateMultipartUploadCommand':
				return { UploadId: 'up-1' };
			case 'UploadPartCommand': {
				inflight++;
				peak = Math.max(peak, inflight);
				await new Promise(r => setTimeout(r, 2 + (cmd.input.PartNumber % 3) * 3));
				inflight--;
				if (opts.failPart === cmd.input.PartNumber) throw new Error('part failed');
				return { ETag: `"etag-${cmd.input.PartNumber}"`, ChecksumCRC32: `crc-${cmd.input.PartNumber}` };
			}
			default:
				return {};
		}
	};
	return { send, calls, peak: () => peak } as any;
}

const headers = { ContentType: 'audio/mpeg', ContentDisposition: "inline; filename*=UTF-8''a.mp3", CacheControl: 'public, max-age=31536000, immutable' };
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const entryFor = (b: Buffer, sha256 = sha(b)): any => ({ area: '', key: `${sha256}/a.mp3`, vaultPath: 'M/a.mp3', sha256, fileName: 'a.mp3', size: b.length });
const names = (calls: Call[]) => calls.map(c => c.name.replace('Command', ''));

async function main(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), 'cpn-att-up-'));
	try {
		// 1. HeadObject
		check('HEAD 200 → exists', await m.objectExists(fakeS3({ headStatus: 200 }), 'b', 'k'));
		check('HEAD 404 → missing', !(await m.objectExists(fakeS3({ headStatus: 404 }), 'b', 'k')));
		check('HEAD 403 → missing (no ListBucket)', !(await m.objectExists(fakeS3({ headStatus: 403 }), 'b', 'k')));
		let threw = false;
		try { await m.objectExists(fakeS3({ headStatus: 500 }), 'b', 'k'); } catch { threw = true; }
		check('HEAD 500 → throws', threw);

		// 2. putSingle
		const small = Buffer.from('small file bytes');
		const smallPath = join(dir, 'small.mp3');
		writeFileSync(smallPath, small);
		{
			const s3 = fakeS3();
			await m.putSingle(s3, 'b', 'attachments/k', smallPath, entryFor(small), headers);
			const put = s3.calls.find((c: Call) => c.name === 'PutObjectCommand');
			check('putSingle sends PutObject with headers', !!put && put.input.ContentType === 'audio/mpeg'
				&& put.input.ContentDisposition === headers.ContentDisposition && put.input.CacheControl === headers.CacheControl
				&& Buffer.compare(put.input.Body, small) === 0);
		}
		{
			const s3 = fakeS3();
			let err: unknown = null;
			try { await m.putSingle(s3, 'b', 'k', smallPath, entryFor(small, 'f'.repeat(64)), headers); } catch (e) { err = e; }
			check('putSingle mismatch → AttachmentChangedError, no PutObject', err instanceof m.AttachmentChangedError
				&& !s3.calls.some((c: Call) => c.name === 'PutObjectCommand'));
		}

		// 3. putMultipart
		const big = Buffer.alloc(10 * 1024 + 300);
		for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
		const bigPath = join(dir, 'big.wav');
		writeFileSync(bigPath, big);
		{
			const s3 = fakeS3();
			await m.putMultipart(s3, 'b', 'attachments/k', bigPath, entryFor(big), headers, 1024);
			const create = s3.calls.find((c: Call) => c.name === 'CreateMultipartUploadCommand');
			const partCalls = s3.calls.filter((c: Call) => c.name === 'UploadPartCommand');
			const complete = s3.calls.find((c: Call) => c.name === 'CompleteMultipartUploadCommand');
			check('multipart: CRC32 and headers on CreateMultipartUpload', create?.input.ChecksumAlgorithm === 'CRC32'
				&& create?.input.ContentType === 'audio/mpeg' && create?.input.CacheControl === headers.CacheControl);
			check('multipart: 11 parts of ≤1 KB, CRC32 on each', partCalls.length === 11
				&& partCalls.every((c: Call) => c.input.ChecksumAlgorithm === 'CRC32' && c.input.Body.length <= 1024));
			const sent = Buffer.concat(partCalls.sort((a: Call, b: Call) => a.input.PartNumber - b.input.PartNumber).map((c: Call) => c.input.Body));
			check('multipart: parts reassemble the file', Buffer.compare(sent, big) === 0);
			const parts = complete?.input.MultipartUpload.Parts ?? [];
			check('multipart: Complete lists parts in order with ETag and ChecksumCRC32',
				parts.length === 11 && parts.every((p: any, i: number) => p.PartNumber === i + 1 && p.ETag === `"etag-${i + 1}"` && p.ChecksumCRC32 === `crc-${i + 1}`), parts);
			check('multipart: at most 4 parts in flight', s3.peak() <= 4 && s3.peak() >= 2, s3.peak());
			check('multipart: no abort on success', !s3.calls.some((c: Call) => c.name === 'AbortMultipartUploadCommand'));
		}

		// 4. Mismatch → abort
		{
			const s3 = fakeS3();
			let err: unknown = null;
			try { await m.putMultipart(s3, 'b', 'k', bigPath, entryFor(big, 'e'.repeat(64)), headers, 1024); } catch (e) { err = e; }
			check('multipart mismatch → AttachmentChangedError', err instanceof m.AttachmentChangedError);
			check('multipart mismatch → aborted, never completed', names(s3.calls).includes('AbortMultipartUpload')
				&& !names(s3.calls).includes('CompleteMultipartUpload'), names(s3.calls));
		}

		// 5. Part failure → abort
		{
			const s3 = fakeS3({ failPart: 3 });
			let err: any = null;
			try { await m.putMultipart(s3, 'b', 'k', bigPath, entryFor(big), headers, 1024); } catch (e) { err = e; }
			check('part failure rethrown', err?.message === 'part failed', String(err));
			check('part failure → aborted, never completed', names(s3.calls).includes('AbortMultipartUpload')
				&& !names(s3.calls).includes('CompleteMultipartUpload'));
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	console.log('');
	if (failures.length === 0) {
		console.log(`All ${checks} attachment-upload checks passed.`);
		process.exit(0);
	}
	console.log(`${failures.length}/${checks} attachment-upload checks FAILED.`);
	process.exit(1);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
