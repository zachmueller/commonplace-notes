/**
 * Minimal, dependency-free ZIP writer for packaging a single-file Lambda.
 *
 * A Lambda@Edge function's config (the sha256 password hash + realm) cannot be
 * injected via CloudFormation template substitution once the code lives in an S3
 * asset (`Code: { S3Bucket, S3Key }`), and Lambda@Edge forbids environment
 * variables. So the plugin bakes the config into the function source and ships
 * the result as a zip it uploads to S3 itself. The package is a single
 * `index.js`, so we emit a STORED (uncompressed) entry — no deflate needed,
 * which keeps this to a tiny CRC32 + a few fixed-layout records and avoids
 * pulling in a zip dependency (matters for the plugin bundle / supply chain).
 *
 * Layout (PKZIP APPNOTE): [local file header + data] then [central directory
 * header] then [end-of-central-directory record]. Times are fixed (the S3 key
 * is content-addressed, so a stable mtime keeps identical code → identical zip).
 */

// Precomputed CRC32 table (IEEE polynomial 0xEDB88320).
const CRC_TABLE: Uint32Array = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

/** Append a little-endian 16-bit value. */
function u16(out: number[], v: number): void {
	out.push(v & 0xff, (v >>> 8) & 0xff);
}

/** Append a little-endian 32-bit value. */
function u32(out: number[], v: number): void {
	out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

function pushBytes(out: number[], bytes: Uint8Array): void {
	for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
}

/**
 * Build a ZIP archive containing a single STORED entry `index.js` with the given
 * source. Deterministic: the same source always yields byte-identical output, so
 * a content hash of the result is a stable cache/version key.
 */
export function buildLambdaZip(indexJs: string, entryName = 'index.js'): Uint8Array {
	const nameBytes = new TextEncoder().encode(entryName);
	const dataBytes = new TextEncoder().encode(indexJs);
	const crc = crc32(dataBytes);
	const size = dataBytes.length;

	// DOS time/date fixed to 1980-01-01 00:00:00 (0x0021 date, 0x0000 time) so
	// the archive is reproducible.
	const dosTime = 0;
	const dosDate = 0x0021;

	const out: number[] = [];

	// --- Local file header ---
	const localHeaderOffset = 0; // always first entry
	u32(out, 0x04034b50); // signature
	u16(out, 20); // version needed
	u16(out, 0); // general purpose flags
	u16(out, 0); // compression method: 0 = stored
	u16(out, dosTime);
	u16(out, dosDate);
	u32(out, crc);
	u32(out, size); // compressed size (== uncompressed for stored)
	u32(out, size); // uncompressed size
	u16(out, nameBytes.length);
	u16(out, 0); // extra field length
	pushBytes(out, nameBytes);
	pushBytes(out, dataBytes);

	// --- Central directory header ---
	const centralDirOffset = out.length;
	u32(out, 0x02014b50); // signature
	u16(out, 20); // version made by
	u16(out, 20); // version needed
	u16(out, 0); // flags
	u16(out, 0); // compression: stored
	u16(out, dosTime);
	u16(out, dosDate);
	u32(out, crc);
	u32(out, size);
	u32(out, size);
	u16(out, nameBytes.length);
	u16(out, 0); // extra field length
	u16(out, 0); // comment length
	u16(out, 0); // disk number start
	u16(out, 0); // internal attributes
	u32(out, 0); // external attributes
	u32(out, localHeaderOffset);
	pushBytes(out, nameBytes);
	const centralDirSize = out.length - centralDirOffset;

	// --- End of central directory record ---
	u32(out, 0x06054b50); // signature
	u16(out, 0); // this disk
	u16(out, 0); // disk with central dir
	u16(out, 1); // entries on this disk
	u16(out, 1); // total entries
	u32(out, centralDirSize);
	u32(out, centralDirOffset);
	u16(out, 0); // comment length

	return Uint8Array.from(out);
}

/** Lowercase hex sha256 of bytes, via Web Crypto (Obsidian's Electron renderer). */
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}
