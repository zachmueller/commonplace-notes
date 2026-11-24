/**
 * Excluded-directory matching, shared by every caller of
 * Publisher.isFileExcluded (publishing, the audit, file-tree indicators).
 *
 * Rules (docs/settings.md, "Excluded directories"):
 *
 * 1. Each line is a folder pattern from the vault root. Lines are trimmed and
 *    empty lines ignored. A leading `/` or `./` and a trailing `/` are
 *    optional: `private`, `/private` and `private/` mean the same.
 * 2. Segments are matched against whole folder names: `private` never matches
 *    `privateer`.
 * 3. Without wildcards a pattern names one folder from the root:
 *    `Projects/private/` excludes only `Projects/private/…`.
 * 4. `*` within a segment matches any run of characters except `/`.
 * 5. A segment that is exactly `**` matches zero or more folders. `**` inside a
 *    longer segment is treated as `*`.
 * 6. Matching is case-insensitive.
 * 7. Other characters (`?`, `[`, `{`, `\`) are literal. No escaping or negation.
 * 8. Patterns match folders, never file names: a file is excluded when any of
 *    its ancestor folders matches a pattern in full.
 *
 * Also holds the one-time upgrade from the old rule
 * (`path.startsWith(dir) || path.includes('/' + dir + '/')`), which matched
 * slashless entries by prefix and at any depth.
 *
 * Pure: no Obsidian imports, so it can be unit-tested with tsx.
 */

/** Excluded-directory rules version that profiles record once upgraded. */
export const EXCLUDED_DIRS_RULES_VERSION = 2;

/** `**` segment marker in a compiled pattern. */
const ANY_DEPTH = null;
type CompiledSegment = RegExp | typeof ANY_DEPTH;

/**
 * Normalize one settings line to `seg/seg/…` (rule 1), or `null` when it
 * names nothing.
 */
export function normalizeExcludeEntry(line: string): string | null {
	let entry = line.trim();
	for (;;) {
		if (entry.startsWith('./')) entry = entry.slice(2);
		else if (entry.startsWith('/')) entry = entry.slice(1);
		else break;
	}
	entry = entry.replace(/\/+$/, '');
	return entry === '' ? null : entry;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileSegment(segment: string): CompiledSegment {
	if (segment === '**') return ANY_DEPTH;
	// Any run of `*` (including `**` inside a longer segment) is one `*`.
	const source = segment.split(/\*+/).map(escapeRegExp).join('[^/]*');
	return new RegExp(`^${source}$`, 'i');
}

function compilePattern(entry: string): CompiledSegment[] {
	return entry.split('/').filter(s => s !== '').map(compileSegment);
}

/** Whether `pattern` matches all of `folders` (rule 5's `**` included). */
function matchesAll(pattern: CompiledSegment[], folders: string[]): boolean {
	const memo = new Map<number, boolean>();
	const step = (i: number, j: number): boolean => {
		const key = i * (folders.length + 1) + j;
		const cached = memo.get(key);
		if (cached !== undefined) return cached;
		let result: boolean;
		if (i === pattern.length) {
			result = j === folders.length;
		} else {
			const seg = pattern[i];
			if (seg === ANY_DEPTH) {
				result = step(i + 1, j) || (j < folders.length && step(i, j + 1));
			} else {
				result = j < folders.length && seg.test(folders[j]) && step(i + 1, j + 1);
			}
		}
		memo.set(key, result);
		return result;
	};
	return step(0, 0);
}

/**
 * Compile the profile's excluded-directory lines into a predicate over
 * vault-relative file paths (`a/b/c.md`).
 */
export function compileExcludePatterns(lines: readonly string[]): (path: string) => boolean {
	// Rule 8: a pattern matching some ancestor folder in full is the same as
	// the pattern followed by `**` matching the file's whole folder path.
	const patterns = lines
		.map(normalizeExcludeEntry)
		.filter((e): e is string => e !== null)
		.map(e => [...compilePattern(e), ANY_DEPTH]);

	return (path: string): boolean => {
		const folders = path.split('/').slice(0, -1).filter(s => s !== '');
		// A file at the vault root has no ancestor folder to match.
		if (folders.length === 0) return false;
		return patterns.some(p => matchesAll(p, folders));
	};
}

// ---------------------------------------------------------------------------
// One-time upgrade from the old rule
// ---------------------------------------------------------------------------

/**
 * The rule before version 2, kept only so the upgrade can report what the new
 * rule no longer excludes. Entries are used exactly as stored.
 */
export function legacyIsExcluded(entries: readonly string[], path: string): boolean {
	return entries.some(dir => path.startsWith(dir) || path.includes('/' + dir + '/'));
}

export interface ExcludeUpgrade {
	/** The profile's entries with the added patterns appended. */
	entries: string[];
	/** Patterns appended, in order. */
	added: string[];
}

/**
 * Step 1: for each entry that doesn't end in `/` once trimmed, append
 * `**\/<entry>/` (the old any-depth match) and `<entry>*\/` (the old prefix
 * match), skipping any already in the list. The user's own entries are kept as
 * typed. Entries ending in `/` meant the same under both rules and gain
 * nothing.
 */
export function upgradeExcludedDirectories(entries: readonly string[]): ExcludeUpgrade {
	const out = [...entries];
	const present = new Set(entries.map(e => e.trim()));
	const added: string[] = [];
	for (const entry of entries) {
		const trimmed = entry.trim();
		if (trimmed === '' || trimmed.endsWith('/')) continue;
		const norm = normalizeExcludeEntry(entry);
		if (norm === null) continue;
		for (const pattern of [`**/${norm}/`, `${norm}*/`]) {
			if (present.has(pattern)) continue;
			present.add(pattern);
			out.push(pattern);
			added.push(pattern);
		}
	}
	return { entries: out, added };
}

/**
 * Step 2: the files the old entries excluded that the new entries don't. After
 * step 1 these are only files the old rule matched by their own name
 * (`private.md` at the root, from the entry `private`), which no folder
 * pattern can express.
 */
export function findNoLongerExcluded(
	oldEntries: readonly string[],
	newEntries: readonly string[],
	paths: readonly string[]
): string[] {
	const isExcluded = compileExcludePatterns(newEntries);
	return paths.filter(p => legacyIsExcluded(oldEntries, p) && !isExcluded(p));
}
