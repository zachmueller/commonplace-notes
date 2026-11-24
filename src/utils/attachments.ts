/**
 * Attachment publishing, pure rules (attachment spec phase 2).
 *
 * Everything here is free of Obsidian and Node I/O, so it is unit-testable on
 * its own (e2e/scripts/test-attachments.ts):
 *
 * - settings defaults and the reference filter (§2, §3);
 * - kinds, keys and S3 keys (§3, §7);
 * - the response headers each file is uploaded with (§7, Headers);
 * - the note-hash segment and the note JSON list (§5);
 * - staged-entry merging and the re-check before upload (§6, §7);
 * - the "changed since" rule for Publish updates (§8);
 * - the large-file upload limiter (§7);
 * - phase 3 cleanup: which files each area needs, sweep orphans and the
 *   audit's comparison with the bucket (P3 §1, §2, §4).
 */

import { partitionsFor, restrictedPrefix, type Partition } from './access';

/** Which links to non-Markdown files publish the file. */
export type AttachmentMode = 'off' | 'embeds' | 'embedsAndLinks';

export interface AttachmentSettings {
	/** Which links to non-Markdown files publish the file. */
	mode: AttachmentMode;
	/** Lowercase extensions without the dot. `*` allows every extension. */
	allowedExtensions: string[];
	/** Files larger than this are skipped with a notice. 1–500. */
	maxFileSizeMB: number;
}

export type AttachmentKind = 'image' | 'audio' | 'video' | 'file';

/** One file a note revision references, as collected from the metadata cache (§3). */
export interface AttachmentRef {
	/** For upload and notices only; never published. */
	vaultPath: string;
	/** Hex, 64 chars. */
	sha256: string;
	/** Basename, e.g. "song.mp3". */
	fileName: string;
	/** Lowercase, '' when the file has none. */
	ext: string;
	/** fs.stat size. */
	size: number;
	/** fs.stat mtimeMs. */
	mtime: number;
	/** fs.stat ctimeMs (inode change time, not creation time). */
	ctime: number;
	kind: AttachmentKind;
}

/** What the renderer is told about a link target (§4). */
export type AttachmentRender =
	| { published: true; key: string; fileName: string; kind: AttachmentKind }
	| { published: false; fileName: string };

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'] as const;
export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac'] as const;
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'webm', 'mov'] as const;
export const DOCUMENT_EXTENSIONS = ['pdf'] as const;

export const DEFAULT_ALLOWED_EXTENSIONS: readonly string[] = [
	...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS, ...DOCUMENT_EXTENSIONS,
];
export const DEFAULT_MAX_FILE_SIZE_MB = 50;
export const MIN_FILE_SIZE_MB = 1;
export const MAX_FILE_SIZE_MB = 500;
export const ALLOW_ALL = '*';

const MB = 1024 * 1024;

/** A profile's attachment settings with defaults filled in. Absent ≡ off. */
export function resolveAttachmentSettings(raw: Partial<AttachmentSettings> | undefined): AttachmentSettings {
	const mode: AttachmentMode = raw?.mode === 'embeds' || raw?.mode === 'embedsAndLinks' ? raw.mode : 'off';
	const allowedExtensions = Array.isArray(raw?.allowedExtensions)
		? normalizeExtensionList(raw!.allowedExtensions)
		: [...DEFAULT_ALLOWED_EXTENSIONS];
	return { mode, allowedExtensions, maxFileSizeMB: clampFileSizeMB(raw?.maxFileSizeMB) };
}

export function clampFileSizeMB(value: unknown): number {
	const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DEFAULT_MAX_FILE_SIZE_MB;
	return Math.min(MAX_FILE_SIZE_MB, Math.max(MIN_FILE_SIZE_MB, n));
}

/** Lowercase, no leading dot, de-duplicated, blanks dropped. */
export function normalizeExtensionList(list: readonly string[]): string[] {
	const out: string[] = [];
	for (const raw of list) {
		const ext = raw.trim().toLowerCase().replace(/^\.+/, '');
		if (ext !== '' && !out.includes(ext)) out.push(ext);
	}
	return out;
}

/** The settings text field: space- or comma-separated. */
export function parseExtensionList(text: string): string[] {
	return normalizeExtensionList(text.split(/[\s,]+/));
}

export function formatExtensionList(list: readonly string[]): string {
	return list.join(' ');
}

/** Case-insensitive; `*` allows every extension, including none. */
export function isExtensionAllowed(ext: string, allowed: readonly string[]): boolean {
	if (allowed.includes(ALLOW_ALL)) return true;
	const e = ext.toLowerCase();
	return e !== '' && allowed.includes(e);
}

export function maxFileSizeBytes(settings: AttachmentSettings): number {
	return settings.maxFileSizeMB * MB;
}

/** Kind from the extension: the default image/audio/video sets, else `file`. */
export function attachmentKind(ext: string): AttachmentKind {
	const e = ext.toLowerCase();
	if ((IMAGE_EXTENSIONS as readonly string[]).includes(e)) return 'image';
	if ((AUDIO_EXTENSIONS as readonly string[]).includes(e)) return 'audio';
	if ((VIDEO_EXTENSIONS as readonly string[]).includes(e)) return 'video';
	return 'file';
}

/** A candidate file, as the filter sees it. */
export interface AttachmentCandidate {
	path: string;
	/** Lowercase or not; compared case-insensitively. */
	ext: string;
	size: number;
}

export type FilterResult = 'ok' | 'markdown' | 'extension' | 'excluded' | 'size';

/**
 * The §3 filter, minus the mode check (the caller picks embeds/links by mode).
 * A Markdown file is a note, never an attachment.
 */
export function filterAttachment(
	file: AttachmentCandidate,
	settings: AttachmentSettings,
	isExcluded: (path: string) => boolean,
): FilterResult {
	const ext = file.ext.toLowerCase();
	if (ext === 'md') return 'markdown';
	if (!isExtensionAllowed(ext, settings.allowedExtensions)) return 'extension';
	if (isExcluded(file.path)) return 'excluded';
	if (file.size > maxFileSizeBytes(settings)) return 'size';
	return 'ok';
}

/** `<sha256>/<fileName>`: the key's last segment is the real file name. */
export function attachmentKey(sha256: string, fileName: string): string {
	return `${sha256}/${fileName}`;
}

/** The S3 object key: `<s3Prefix><area>attachments/<sha256>/<fileName>` (area `''` or `restricted/<g>/`). */
export function attachmentObjectKey(s3Prefix: string, area: string, key: string): string {
	return `${s3Prefix}${area}attachments/${key}`;
}

/** Split a key back into its hash and file name. */
export function parseAttachmentKey(key: string): { sha256: string; fileName: string } | null {
	const slash = key.indexOf('/');
	if (slash !== 64 || !/^[0-9a-f]{64}$/.test(key.slice(0, 64))) return null;
	return { sha256: key.slice(0, 64), fileName: key.slice(65) };
}

// ---------------------------------------------------------------------------
// Headers (§7)
// ---------------------------------------------------------------------------

/**
 * Passive types only: browsers display these without running site code. An
 * extension missing here is served as application/octet-stream and
 * downloads.
 */
const PASSIVE_CONTENT_TYPES: Readonly<Record<string, string>> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	svg: 'image/svg+xml',
	mp3: 'audio/mpeg',
	m4a: 'audio/mp4',
	aac: 'audio/aac',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	opus: 'audio/opus',
	wav: 'audio/wav',
	flac: 'audio/flac',
	mp4: 'video/mp4',
	m4v: 'video/mp4',
	webm: 'video/webm',
	mov: 'video/quicktime',
	pdf: 'application/pdf',
};

/**
 * Types a browser can render as a document with script. Never mapped, whatever
 * the user allows: a same-origin page would run with the reader's session.
 * The unit tests check none of these is in the passive map.
 */
export const ACTIVE_EXTENSIONS: readonly string[] = [
	'html', 'htm', 'xhtml', 'xht', 'shtml', 'mht', 'mhtml',
	'xml', 'xsl', 'xslt', 'rss', 'atom',
	'js', 'mjs', 'cjs', 'wasm',
	'svgz',
];

export const OCTET_STREAM = 'application/octet-stream';

export function contentTypeFor(ext: string): string {
	const e = ext.toLowerCase();
	if (ACTIVE_EXTENSIONS.includes(e)) return OCTET_STREAM;
	return Object.prototype.hasOwnProperty.call(PASSIVE_CONTENT_TYPES, e) ? PASSIVE_CONTENT_TYPES[e] : OCTET_STREAM;
}

/** RFC 5987 `ext-value` for a UTF-8 file name: `UTF-8''<percent-encoded>`. */
export function rfc5987FileName(fileName: string): string {
	// encodeURIComponent leaves ' ( ) * ! unescaped, which attr-char forbids.
	const encoded = encodeURIComponent(fileName).replace(/['()*!]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
	return `UTF-8''${encoded}`;
}

/**
 * `inline` for mapped passive types except svg (a PDF opens in the viewer);
 * `attachment` for svg and everything served as octet-stream. `<img>` ignores
 * the header, so an SVG still renders inline in the note.
 */
export function contentDispositionFor(ext: string, fileName: string): string {
	const type = contentTypeFor(ext);
	const inline = type !== OCTET_STREAM && ext.toLowerCase() !== 'svg';
	return `${inline ? 'inline' : 'attachment'}; filename*=${rfc5987FileName(fileName)}`;
}

export type SiteReadGate = 'none' | 'cognito' | 'password' | 'byo';

/**
 * Cache-Control for an attachment object. Keys are immutable (the hash is in
 * the key), so every value is `immutable`. Restricted areas and whole-site
 * gates use `private`, so shared caches stay out; restricted areas keep a
 * file for at most one sign-in session.
 */
export function attachmentCacheControl(area: string, readGate: SiteReadGate, sessionHours: number): string {
	if (area !== '') return `private, max-age=${Math.max(1, Math.round(sessionHours * 3600))}, immutable`;
	if (readGate === 'none') return 'public, max-age=31536000, immutable';
	return 'private, max-age=31536000, immutable';
}

// ---------------------------------------------------------------------------
// Pinning (§5)
// ---------------------------------------------------------------------------

/** Sorted, de-duplicated keys of a note's refs. */
export function refKeys(refs: readonly Pick<AttachmentRef, 'sha256' | 'fileName'>[]): string[] {
	return [...new Set(refs.map(r => attachmentKey(r.sha256, r.fileName)))].sort();
}

/** `::att=<key>,<key>` for the note hash, or '' when the note has no refs. */
export function attachmentHashSegment(refs: readonly Pick<AttachmentRef, 'sha256' | 'fileName'>[]): string {
	const att = refKeys(refs);
	return att.length ? `::att=${att.join(',')}` : '';
}

export interface NoteJsonAttachment {
	key: string;
	name: string;
	size: number;
}

/** The note JSON `attachments` list, sorted by key; null when empty (omit the field). */
export function noteJsonAttachments(refs: readonly AttachmentRef[]): NoteJsonAttachment[] | null {
	const byKey = new Map<string, NoteJsonAttachment>();
	for (const r of refs) {
		const key = attachmentKey(r.sha256, r.fileName);
		if (!byKey.has(key)) byKey.set(key, { key, name: r.fileName, size: r.size });
	}
	if (byKey.size === 0) return null;
	return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Staging (§6) and the re-check before upload (§7)
// ---------------------------------------------------------------------------

/** One (area, key) the staged batch needs. */
export interface StagedAttachment {
	/** '' = public, else `restricted/<group>/`. */
	area: string;
	key: string;
	vaultPath: string;
	sha256: string;
	fileName: string;
	size: number;
}

export function stagedId(e: Pick<StagedAttachment, 'area' | 'key'>): string {
	return `${e.area}\u0000${e.key}`;
}

/**
 * Merge this batch's entries into those a failed earlier batch left, keyed by
 * area + key (a newer entry replaces an older one). Returns the merged list
 * and the ids this batch staged or merged into.
 */
export function mergeStagedAttachments(
	existing: readonly StagedAttachment[],
	added: readonly StagedAttachment[],
): { merged: StagedAttachment[]; thisBatch: Set<string> } {
	const byId = new Map<string, StagedAttachment>();
	for (const e of existing) byId.set(stagedId(e), e);
	const thisBatch = new Set<string>();
	for (const e of added) {
		const id = stagedId(e);
		byId.set(id, e);
		thisBatch.add(id);
	}
	return { merged: [...byId.values()], thisBatch };
}

/** The staged entries for one note revision: each key in each of its areas. */
export function stagedEntriesFor(areas: readonly string[], refs: readonly AttachmentRef[]): StagedAttachment[] {
	const out: StagedAttachment[] = [];
	const seen = new Set<string>();
	for (const area of areas) {
		for (const r of refs) {
			const key = attachmentKey(r.sha256, r.fileName);
			const id = stagedId({ area, key });
			if (seen.has(id)) continue;
			seen.add(id);
			out.push({ area, key, vaultPath: r.vaultPath, sha256: r.sha256, fileName: r.fileName, size: r.size });
		}
	}
	return out;
}

export type RecheckDropReason = 'missing' | 'excluded' | 'extension' | 'size' | 'mode-off' | 'changed';

/** What the re-check needs to know about the vault, injected so this stays pure. */
export interface RecheckEnv {
	settings: AttachmentSettings;
	isExcluded: (vaultPath: string) => boolean;
	/** Current size of the vault file, or null when it no longer exists (or is now a note). */
	sizeOf: (vaultPath: string) => Promise<number | null>;
	/** The file's current sha256 (from the hash cache, re-hashing on a stat change). */
	currentHash: (vaultPath: string) => Promise<string>;
	/** Ids (stagedId) this publish staged or merged into. */
	thisBatch: ReadonlySet<string>;
}

export interface RecheckResult {
	keep: StagedAttachment[];
	dropped: Array<{ entry: StagedAttachment; reason: RecheckDropReason }>;
	/** This batch's entry whose bytes changed: stop the publish before any upload. */
	stop: StagedAttachment | null;
}

/**
 * The re-check before upload (§7). Entries failing the settings or vault
 * checks are dropped. A hash mismatch drops an earlier batch's entry, and
 * stops the publish for this batch's entry.
 */
export async function recheckStagedAttachments(entries: readonly StagedAttachment[], env: RecheckEnv): Promise<RecheckResult> {
	const keep: StagedAttachment[] = [];
	const dropped: RecheckResult['dropped'] = [];
	// One hash per vault path, however many areas need it.
	const hashes = new Map<string, Promise<string>>();
	for (const entry of entries) {
		const reason = await recheckReason(entry);
		if (reason === null) {
			keep.push(entry);
			continue;
		}
		if (reason === 'changed' && env.thisBatch.has(stagedId(entry))) {
			return { keep, dropped, stop: entry };
		}
		dropped.push({ entry, reason });
	}
	return { keep, dropped, stop: null };

	async function recheckReason(entry: StagedAttachment): Promise<RecheckDropReason | null> {
		if (env.settings.mode === 'off') return 'mode-off';
		const size = await env.sizeOf(entry.vaultPath);
		if (size === null) return 'missing';
		const ext = extensionOf(entry.vaultPath);
		const filter = filterAttachment({ path: entry.vaultPath, ext, size }, env.settings, env.isExcluded);
		if (filter === 'markdown') return 'missing';
		if (filter !== 'ok') return filter;
		let hash = hashes.get(entry.vaultPath);
		if (!hash) {
			hash = env.currentHash(entry.vaultPath);
			hashes.set(entry.vaultPath, hash);
		}
		return (await hash) === entry.sha256 ? null : 'changed';
	}
}

/** Lowercase extension of a path's basename, '' when none (a leading dot isn't one). */
export function extensionOf(path: string): string {
	const base = path.slice(path.lastIndexOf('/') + 1);
	const dot = base.lastIndexOf('.');
	return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Basename of a vault path. */
export function baseNameOf(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

/** "2 attachments …: a, b." with a short name list. */
export function nameList(names: readonly string[], max = 5): string {
	const unique = [...new Set(names)];
	const shown = unique.slice(0, max).join(', ');
	return unique.length > max ? `${shown} and ${unique.length - max} more` : shown;
}

export function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Publish updates (§8)
// ---------------------------------------------------------------------------

/** A file changed after `since` when the later of mtime and ctime is after it. */
export function changedSince(stat: { mtimeMs: number; ctimeMs: number }, since: number): boolean {
	return Math.max(stat.mtimeMs, stat.ctimeMs) > since;
}

// ---------------------------------------------------------------------------
// Upload limiter (§7)
// ---------------------------------------------------------------------------

/** Run at most `slots` tasks at once; the rest wait their turn (FIFO). */
export function createLimiter(slots: number): <T>(fn: () => Promise<T>) => Promise<T> {
	let active = 0;
	const waiting: Array<() => void> = [];
	return async <T>(fn: () => Promise<T>): Promise<T> => {
		// A finishing task hands its slot straight to the next waiter, so a new
		// caller can't take it in between.
		if (active >= slots) await new Promise<void>(resolve => waiting.push(resolve));
		else active++;
		try {
			return await fn();
		} finally {
			const next = waiting.shift();
			if (next) next();
			else active--;
		}
	};
}

/** Files up to this size go in one PutObject; larger ones use multipart. */
export const SINGLE_PUT_MAX_BYTES = 16 * MB;
export const MULTIPART_PART_BYTES = 8 * MB;
export const MULTIPART_PARTS_IN_FLIGHT = 4;
export const LARGE_UPLOAD_SLOTS = 2;

// ---------------------------------------------------------------------------
// Cleanup (attachment spec P3 §1, §2, §4)
// ---------------------------------------------------------------------------

/** The area of a partition: '' for public, `restricted/<g>/` for a group. */
export function areaOfPartition(p: Partition): string {
	return p === null ? '' : restrictedPrefix(p);
}

/** The areas a note with these access groups publishes to. [] (or none recorded) is public. */
export function areasForGroups(groups: readonly string[] | undefined): string[] {
	return partitionsFor([...(groups ?? [])]).map(areaOfPartition);
}

/** For logs and notices: "the public site" or `group "family"`. */
export function describeArea(area: string): string {
	const m = /^restricted\/([^/]+)\/$/.exec(area);
	return m ? `group "${m[1]}"` : 'the public site';
}

/** Local state the derivation reads (P3 §1). */
export interface RequiredInputs {
	/**
	 * Which UIDs are published: the keys of the profile's `uid-to-hash`
	 * mapping. Not the access map, which can lack a published UID. The value
	 * (the live hash) also counts as one of the UID's revisions.
	 */
	uidToHash: Readonly<Record<string, string>>;
	/** A UID's current groups from `access.json`; missing or [] is public. */
	accessOf: (uid: string) => readonly string[] | undefined;
	/** `publish-history.json`: uid → every revision hash. */
	history: Readonly<Record<string, readonly string[]>>;
	/** `attachments.json` refs: note hash → keys that revision uses. */
	refs: Readonly<Record<string, readonly string[]>>;
}

/** Every revision hash of a published UID: its history plus its live hash. */
function revisionsOf(inputs: RequiredInputs, uid: string): Set<string> {
	const out = new Set(inputs.history[uid] ?? []);
	const live = inputs.uidToHash[uid];
	if (live) out.add(live);
	return out;
}

/**
 * required(area) for every area at once: the union of `refs[h]` over every
 * revision `h` of every published UID whose current areas include the area.
 * A superset of what the area's live revisions use (an access change doesn't
 * copy old revisions into new areas), which is the safe direction.
 */
export function requiredByArea(inputs: RequiredInputs): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
	for (const uid of Object.keys(inputs.uidToHash)) {
		const keys: string[] = [];
		for (const h of revisionsOf(inputs, uid)) keys.push(...(inputs.refs[h] ?? []));
		if (keys.length === 0) continue;
		for (const area of areasForGroups(inputs.accessOf(uid))) {
			const set = out.get(area) ?? new Set<string>();
			keys.forEach(k => set.add(k));
			out.set(area, set);
		}
	}
	return out;
}

/** required(area) for one area. */
export function requiredKeys(inputs: RequiredInputs, area: string): Set<string> {
	return requiredByArea(inputs).get(area) ?? new Set();
}

/** The published UIDs whose revisions in `area` count `key` as required (for reports). */
export function uidsRequiring(inputs: RequiredInputs, area: string, key: string): string[] {
	const out: string[] = [];
	for (const uid of Object.keys(inputs.uidToHash)) {
		if (!areasForGroups(inputs.accessOf(uid)).includes(area)) continue;
		for (const h of revisionsOf(inputs, uid)) {
			if (inputs.refs[h]?.includes(key)) {
				out.push(uid);
				break;
			}
		}
	}
	return out.sort();
}

/** Sweep candidates: the keys the removed revisions used. Nothing else can be deleted. */
export function sweepCandidates(removedHashes: Iterable<string>, refs: Readonly<Record<string, readonly string[]>>): Set<string> {
	const out = new Set<string>();
	for (const h of removedHashes) (refs[h] ?? []).forEach(k => out.add(k));
	return out;
}

/** orphans = candidates − required, sorted. */
export function sweepOrphans(candidates: Iterable<string>, required: ReadonlySet<string>): string[] {
	return [...new Set(candidates)].filter(k => !required.has(k)).sort();
}

/**
 * One sweep (P3 §2): for each area, the keys only the removed revisions used.
 * `removed` maps an area to the note hashes removed from it. Areas with no
 * orphans are omitted.
 */
export function planSweep(removed: ReadonlyMap<string, Iterable<string>>, inputs: RequiredInputs): Map<string, string[]> {
	const required = requiredByArea(inputs);
	const out = new Map<string, string[]>();
	for (const [area, hashes] of removed) {
		const orphans = sweepOrphans(sweepCandidates(hashes, inputs.refs), required.get(area) ?? new Set());
		if (orphans.length > 0) out.set(area, orphans);
	}
	return out;
}

/** One object the audit reports: an area and a key in it. */
export interface AreaKey {
	area: string;
	key: string;
}

/**
 * The audit's comparison (P3 §4) of what the bucket holds with what the
 * published revisions need. `bucket` maps each listed area to its keys.
 * Unreferenced: in the bucket, not required. Missing: required, not in the
 * bucket. Both sorted by area, then key.
 */
export function compareWithBucket(
	bucket: Readonly<Record<string, readonly string[]>>,
	required: ReadonlyMap<string, ReadonlySet<string>>,
): { unreferenced: AreaKey[]; missing: AreaKey[] } {
	const unreferenced: AreaKey[] = [];
	const missing: AreaKey[] = [];
	for (const [area, keys] of Object.entries(bucket)) {
		const need = required.get(area) ?? new Set<string>();
		for (const key of keys) if (!need.has(key)) unreferenced.push({ area, key });
	}
	for (const [area, keys] of required) {
		const have = new Set(bucket[area] ?? []);
		for (const key of keys) if (!have.has(key)) missing.push({ area, key });
	}
	const order = (a: AreaKey, b: AreaKey) => (a.area === b.area ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.area < b.area ? -1 : 1);
	return { unreferenced: unreferenced.sort(order), missing: missing.sort(order) };
}
