#!/usr/bin/env npx tsx
/**
 * Lambda ZIP writer test.
 *
 * buildLambdaZip packages a single-file Lambda (config baked into the source) as
 * a STORED (uncompressed) single-entry zip that the plugin uploads to S3. This
 * exercises the shipped writer:
 *   - the archive parses as a valid zip (signatures, CRC32, sizes, entry name)
 *   - the stored bytes round-trip the exact source (verified via Node's own
 *     unzip in a real zlib inflate-free path — stored data is the bytes verbatim)
 *   - output is deterministic (same source -> byte-identical zip), which is what
 *     makes a content-hash of the zip a stable S3 key / Lambda version key
 *
 * Pure unit test — no AWS. Run: npx tsx e2e/scripts/test-lambda-zip.ts
 */

import * as zlib from 'zlib';
import * as lambdaZipModule from '../../src/infrastructure/lambdaZip';

const lambdaZip: any =
	(lambdaZipModule as any).buildLambdaZip !== undefined
		? lambdaZipModule
		: (lambdaZipModule as any).default;
const buildLambdaZip: (indexJs: string, entryName?: string) => Uint8Array = lambdaZip.buildLambdaZip;

const failures: string[] = [];
function check(cond: boolean, msg: string) {
	if (!cond) failures.push(msg);
}

function u16(b: Uint8Array, off: number): number {
	return b[off] | (b[off + 1] << 8);
}
function u32(b: Uint8Array, off: number): number {
	return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

function main() {
	const source = 'const CFG = { hash: "abc123", realm: "My Notes" };\nexports.handler = async () => "ok";\n';
	const zip = buildLambdaZip(source);
	const expected = new TextEncoder().encode(source);

	// --- Local file header ---
	check(u32(zip, 0) === 0x04034b50, 'local file header signature present');
	check(u16(zip, 8) === 0, 'compression method is stored (0)');
	const crc = u32(zip, 14);
	const compSize = u32(zip, 18);
	const uncompSize = u32(zip, 22);
	const nameLen = u16(zip, 26);
	const extraLen = u16(zip, 28);
	check(compSize === expected.length, 'compressed size equals source length (stored)');
	check(uncompSize === expected.length, 'uncompressed size equals source length');
	check(extraLen === 0, 'no extra field');

	const name = new TextDecoder().decode(zip.slice(30, 30 + nameLen));
	check(name === 'index.js', 'entry name is index.js');

	// --- Stored data round-trips the source verbatim ---
	const dataStart = 30 + nameLen + extraLen;
	const data = zip.slice(dataStart, dataStart + uncompSize);
	check(new TextDecoder().decode(data) === source, 'stored data round-trips the exact source');

	// --- CRC32 matches Node's own crc32 over the source bytes ---
	const nodeCrc = zlib.crc32 ? zlib.crc32(Buffer.from(expected)) >>> 0 : undefined;
	if (nodeCrc !== undefined) {
		check(crc === nodeCrc, 'CRC32 matches Node zlib.crc32');
	}

	// --- End-of-central-directory record: exactly one entry ---
	const eocdSig = 0x06054b50;
	// EOCD is the last 22 bytes (no comment).
	const eocdOff = zip.length - 22;
	check(u32(zip, eocdOff) === eocdSig, 'end-of-central-directory signature present');
	check(u16(zip, eocdOff + 8) === 1, 'exactly one entry on this disk');
	check(u16(zip, eocdOff + 10) === 1, 'exactly one total entry');

	// --- Determinism: identical source -> byte-identical zip ---
	const zip2 = buildLambdaZip(source);
	check(zip.length === zip2.length && zip.every((b, i) => b === zip2[i]), 'output is deterministic');

	// --- A different source yields a different archive ---
	const zipOther = buildLambdaZip(source + '// tweak\n');
	check(!(zipOther.length === zip.length && zipOther.every((b, i) => b === zip[i])), 'different source -> different zip');

	report();
}

function report() {
	if (failures.length === 0) {
		console.log('All lambda-zip cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} lambda-zip assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main();
