/**
 * Attachment local state (attachment spec P2 §6): the per-machine hash cache,
 * streamed hashing, `attachments.json` and `staged-attachments.json`.
 *
 * Node-only (fs, crypto; the plugin is desktop-only), with no Obsidian
 * imports. File reads and writes of the JSON state go through a small
 * {@link TextStore}, which the plugin backs with the vault adapter and the
 * unit tests with memory.
 */

import { createReadStream, promises as fsp } from 'fs';
import { createHash } from 'crypto';
import type { StagedAttachment } from './attachments';

/** Text file I/O on vault-adapter paths. `read` returns null for a missing file. */
export interface TextStore {
	read(path: string): Promise<string | null>;
	write(path: string, text: string): Promise<void>;
}

/** The one stat every check uses (§3, "One stat per file"). */
export interface FileStat {
	size: number;
	mtimeMs: number;
	/** Inode change time. Every write moves it, and `utimes` can't set it back. */
	ctimeMs: number;
}

/** Node `fs.stat` on a full path; null when the file doesn't exist. */
export async function statFile(fullPath: string): Promise<FileStat | null> {
	try {
		const s = await fsp.stat(fullPath);
		if (!s.isFile()) return null;
		return { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs };
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
		throw e;
	}
}

/** SHA-256 hex of a file, streamed so memory doesn't grow with its size. */
export function hashFileStream(fullPath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		const stream = createReadStream(fullPath);
		stream.on('error', reject);
		stream.on('data', chunk => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
	});
}

// ---------------------------------------------------------------------------
// Machine ID
// ---------------------------------------------------------------------------

export const MACHINE_ID_KEY = 'cpn-machine-id';

/**
 * This device's ID, from Obsidian's device-local storage (never synced), or a
 * new random one saved there.
 */
export function getOrCreateMachineId(
	load: (key: string) => unknown,
	save: (key: string, value: string) => void,
	newId: () => string,
): string {
	const existing = load(MACHINE_ID_KEY);
	if (typeof existing === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing;
	const id = newId();
	save(MACHINE_ID_KEY, id);
	return id;
}

/** `<pluginDir>/attachment-hash-cache.<machineId>.json`: one per machine, shared by every profile. */
export function hashCachePath(pluginDir: string, machineId: string): string {
	return `${pluginDir}/attachment-hash-cache.${machineId}.json`;
}

// ---------------------------------------------------------------------------
// Hash cache
// ---------------------------------------------------------------------------

interface HashCacheEntry {
	size: number;
	mtime: number;
	ctime: number;
	sha256: string;
}

/** A hashed file with the stat taken before hashing. */
export interface HashedFile {
	sha256: string;
	size: number;
	mtime: number;
	ctime: number;
}

/**
 * vault path → hash, keyed on size, mtime and ctime from one stat taken
 * before hashing. A write during hashing leaves a stat that no longer matches
 * the file, so the next lookup re-hashes rather than trusting a torn hash.
 * Losing the cache costs only re-hashing.
 */
export class AttachmentHashCache {
	private entries: Record<string, HashCacheEntry> = {};
	private loaded = false;
	private dirty = false;
	/** Concurrent lookups of one path share one hash. */
	private inflight = new Map<string, Promise<HashedFile | null>>();

	constructor(private store: TextStore, private path: string) {}

	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const text = await this.store.read(this.path);
			const parsed = text ? JSON.parse(text) : {};
			this.entries = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
		} catch {
			this.entries = {};
		}
	}

	async save(): Promise<void> {
		if (!this.dirty) return;
		await this.store.write(this.path, JSON.stringify(this.entries));
		this.dirty = false;
	}

	/** The cached hash when the stat still matches, else null. */
	peek(vaultPath: string, stat: FileStat): string | null {
		const e = this.entries[vaultPath];
		if (!e) return null;
		return e.size === stat.size && e.mtime === stat.mtimeMs && e.ctime === stat.ctimeMs ? e.sha256 : null;
	}

	/**
	 * The file's hash: stat first, then the cache, else a streamed hash
	 * recorded under that stat. Null when the file no longer exists.
	 */
	async hashOf(vaultPath: string, fullPath: string): Promise<HashedFile | null> {
		await this.load();
		const running = this.inflight.get(vaultPath);
		if (running) return running;
		const job = this.compute(vaultPath, fullPath);
		this.inflight.set(vaultPath, job);
		try {
			return await job;
		} finally {
			this.inflight.delete(vaultPath);
		}
	}

	private async compute(vaultPath: string, fullPath: string): Promise<HashedFile | null> {
		const stat = await statFile(fullPath);
		if (!stat) {
			this.evict(vaultPath);
			return null;
		}
		const done = (sha256: string): HashedFile => ({ sha256, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs });
		const cached = this.peek(vaultPath, stat);
		if (cached) return done(cached);
		const sha256 = await hashFileStream(fullPath);
		this.entries[vaultPath] = { size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, sha256 };
		this.dirty = true;
		return done(sha256);
	}

	/** Drop a path's entry (a mismatch at upload, a rename or a delete). */
	evict(vaultPath: string): void {
		if (vaultPath in this.entries) {
			delete this.entries[vaultPath];
			this.dirty = true;
		}
	}

	has(vaultPath: string): boolean {
		return vaultPath in this.entries;
	}
}

// ---------------------------------------------------------------------------
// attachments.json
// ---------------------------------------------------------------------------

export interface AttachmentStateFile {
	version: 1;
	/** False until this file is known to cover every published revision. */
	complete: boolean;
	/** Note content hash → attachment keys that revision uses. */
	refs: Record<string, string[]>;
	/** Area ('' = public, `restricted/<g>/`) → keys it already holds. */
	uploaded: Record<string, string[]>;
}

export function emptyAttachmentState(complete: boolean): AttachmentStateFile {
	return { version: 1, complete, refs: {}, uploaded: {} };
}

function parseState(text: string): AttachmentStateFile | null {
	try {
		const raw = JSON.parse(text) as Partial<AttachmentStateFile>;
		if (!raw || typeof raw !== 'object') return null;
		const strList = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
		const record = (v: unknown) => {
			const out: Record<string, string[]> = {};
			if (v && typeof v === 'object' && !Array.isArray(v)) {
				for (const [k, list] of Object.entries(v as Record<string, unknown>)) out[k] = strList(list);
			}
			return out;
		};
		return { version: 1, complete: raw.complete === true, refs: record(raw.refs), uploaded: record(raw.uploaded) };
	} catch {
		return null;
	}
}

export interface CreateStateInputs {
	/** The profile's publish history has no revisions. */
	historyEmpty: boolean;
	/**
	 * Whether the bucket holds any attachment object, in any area. Throws when
	 * the probe fails (credentials, network).
	 */
	probeHasAttachments: () => Promise<boolean>;
}

/**
 * Load `attachments.json`, or create it. A new file starts complete when the
 * history is empty or the probe finds no attachment objects (a sweep can only
 * wrongly delete an object that exists). A failed probe still creates the
 * file, incomplete, so the refs this publish commits are kept. An existing
 * file is returned as it is; it is never re-probed.
 */
export async function loadOrCreateAttachmentState(
	store: TextStore,
	path: string,
	inputs: CreateStateInputs | null,
): Promise<{ state: AttachmentStateFile | null; created: boolean; probeError?: unknown }> {
	const text = await store.read(path);
	if (text !== null) {
		const parsed = parseState(text);
		// An unreadable file is treated as lost: the next sweep rebuilds first.
		if (parsed) return { state: parsed, created: false };
	}
	if (!inputs) return { state: null, created: false };
	let complete = false;
	let probeError: unknown;
	if (inputs.historyEmpty) {
		complete = true;
	} else {
		try {
			complete = !(await inputs.probeHasAttachments());
		} catch (e) {
			probeError = e;
			complete = false;
		}
	}
	const state = emptyAttachmentState(complete);
	await store.write(path, JSON.stringify(state));
	return { state, created: true, probeError };
}

export async function saveAttachmentState(store: TextStore, path: string, state: AttachmentStateFile): Promise<void> {
	await store.write(path, JSON.stringify(state));
}

/** Record a revision's keys (omitted when it has none). */
export function recordRefs(state: AttachmentStateFile, noteHash: string, keys: readonly string[]): void {
	if (keys.length === 0) return;
	state.refs[noteHash] = [...new Set(keys)].sort();
}

export function isUploaded(state: AttachmentStateFile, area: string, key: string): boolean {
	return state.uploaded[area]?.includes(key) ?? false;
}

export function recordUploaded(state: AttachmentStateFile, area: string, key: string): void {
	const list = state.uploaded[area] ?? (state.uploaded[area] = []);
	if (!list.includes(key)) list.push(key);
}

// ---------------------------------------------------------------------------
// staged-attachments.json
// ---------------------------------------------------------------------------

export async function loadStagedAttachments(store: TextStore, path: string): Promise<StagedAttachment[]> {
	const text = await store.read(path);
	if (!text) return [];
	try {
		const raw = JSON.parse(text);
		if (!Array.isArray(raw)) return [];
		return raw.filter((e): e is StagedAttachment =>
			!!e && typeof e.area === 'string' && typeof e.key === 'string' && typeof e.vaultPath === 'string'
			&& typeof e.sha256 === 'string' && typeof e.fileName === 'string' && typeof e.size === 'number');
	} catch {
		return [];
	}
}

export async function saveStagedAttachments(store: TextStore, path: string, entries: readonly StagedAttachment[]): Promise<void> {
	await store.write(path, JSON.stringify(entries));
}
