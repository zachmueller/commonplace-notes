/**
 * Control keys for the declarative settings tab (spec §3).
 *
 * Obsidian binds each `control` row to a string key and hands it back to the
 * tab's getControlValue / setControlValue. CPN's settings are nested and
 * per-profile, so a key is a path:
 *
 *   general.<path>          → plugin.settings.<path>
 *   profile.<ref>.<path>    → the profile object registered under <ref>, then <path>
 *
 * `<ref>` is a session ref from {@link RefRegistry}, not the profile's index
 * (shifts on delete) or `id` (itself an editable field). Path segments are
 * escaped so names containing dots (named styles, ids) stay one segment.
 *
 * This module must not import 'obsidian': the tsx unit test runs it directly.
 */

export type KeyScope = 'general' | 'profile';

export type ParsedKey =
	| { scope: 'general'; path: string[] }
	| { scope: 'profile'; ref: string; path: string[] };

/** A path given as segments, or as a dotted literal (segments without dots). */
export type PathInput = string | readonly string[];

export function escapeSegment(segment: string): string {
	return segment.replace(/%/g, '%25').replace(/\./g, '%2E');
}

export function unescapeSegment(segment: string): string {
	return segment.replace(/%2E/gi, '.').replace(/%25/g, '%');
}

export function toPath(path: PathInput): string[] {
	return typeof path === 'string' ? path.split('.') : [...path];
}

export function buildGeneralKey(path: PathInput): string {
	return ['general', ...toPath(path).map(escapeSegment)].join('.');
}

export function buildProfileKey(ref: string, path: PathInput): string {
	return ['profile', escapeSegment(ref), ...toPath(path).map(escapeSegment)].join('.');
}

/** Parse a key built by buildGeneralKey / buildProfileKey; null if malformed. */
export function parseKey(key: string): ParsedKey | null {
	const parts = key.split('.').map(unescapeSegment);
	const [scope, ...rest] = parts;
	if (scope === 'general') {
		if (rest.length === 0 || rest.some(s => s === '')) return null;
		return { scope: 'general', path: rest };
	}
	if (scope === 'profile') {
		const [ref, ...path] = rest;
		if (!ref || path.length === 0 || path.some(s => s === '')) return null;
		return { scope: 'profile', ref, path };
	}
	return null;
}

function isIndex(segment: string): boolean {
	return /^(0|[1-9]\d*)$/.test(segment);
}

function isContainer(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/** Read `path` under `root`; undefined if any step is missing. */
export function getAtPath(root: unknown, path: readonly string[]): unknown {
	let cur: unknown = root;
	for (const segment of path) {
		if (!isContainer(cur)) return undefined;
		cur = cur[segment];
	}
	return cur;
}

/**
 * Write `value` at `path` under `root`, creating missing intermediate objects
 * (arrays when the next segment is an index). Returns false if a non-object
 * sits in the way.
 */
export function setAtPath(root: unknown, path: readonly string[], value: unknown): boolean {
	if (!isContainer(root) || path.length === 0) return false;
	let cur: Record<string, unknown> = root;
	for (let i = 0; i < path.length - 1; i++) {
		const segment = path[i];
		let next = cur[segment];
		if (next === undefined || next === null) {
			next = isIndex(path[i + 1]) ? [] : {};
			cur[segment] = next;
		}
		if (!isContainer(next)) return false;
		cur = next;
	}
	cur[path[path.length - 1]] = value;
	return true;
}

/** Delete the leaf at `path` (no-op if absent). Returns true if something was removed. */
export function deleteAtPath(root: unknown, path: readonly string[]): boolean {
	if (path.length === 0) return false;
	const parent = getAtPath(root, path.slice(0, -1));
	if (!isContainer(parent)) return false;
	const leaf = path[path.length - 1];
	if (!(leaf in parent)) return false;
	delete parent[leaf];
	return true;
}

/**
 * Match a path against a pattern of segments where `*` matches any single
 * segment and a trailing `**` matches any remainder (including none).
 */
export function matchPath(pattern: readonly string[], path: readonly string[]): boolean {
	for (let i = 0; i < pattern.length; i++) {
		if (pattern[i] === '**' && i === pattern.length - 1) return true;
		if (i >= path.length) return false;
		if (pattern[i] !== '*' && pattern[i] !== path[i]) return false;
	}
	return pattern.length === path.length;
}

/**
 * Session-stable refs for objects (profiles, access groups, named styles).
 * The same object always gets the same ref, so renaming its record key or
 * editing its `id` never orphans the keys and pages built from the ref.
 */
export class RefRegistry {
	private ids = new WeakMap<object, string>();
	private objects = new Map<string, object>();
	private counter = 0;

	constructor(private prefix = 'r') {}

	refFor(obj: object): string {
		let ref = this.ids.get(obj);
		if (!ref) {
			ref = `${this.prefix}${++this.counter}`;
			this.ids.set(obj, ref);
			this.objects.set(ref, obj);
		}
		return ref;
	}

	resolve<T extends object = object>(ref: string): T | undefined {
		return this.objects.get(ref) as T | undefined;
	}
}
