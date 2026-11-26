/**
 * Stable page names for the declarative settings tab (spec §4).
 *
 * Obsidian re-finds the open sub-page after `update()` by its path of page
 * names: a renamed page renders empty, and two sibling pages with the same
 * name both open the first. So pages for user-named items (profiles, access
 * groups, named styles) take their names from a per-session snapshot:
 *
 * - The first time an item is seen in a scope its current name is recorded,
 *   made unique among its siblings with a " (2)" suffix.
 * - Later renames don't change the recorded name until {@link clear}, which
 *   the tab calls when it's hidden.
 * - An item that disappears from its scope becomes a tombstone: its name stays
 *   reserved and {@link removed} lists it, so the tab can keep a placeholder
 *   page that still resolves until {@link clear}.
 *
 * This module must not import 'obsidian': the tsx unit test runs it directly.
 */

export interface NamedItem {
	ref: string;
	name: string;
}

interface Entry {
	name: string;
	removed: boolean;
}

/**
 * `base`, or `base (2)`, `base (3)`, ... whichever is not in `taken`. A blank
 * or non-string `base` (malformed data.json) becomes "Untitled".
 */
export function uniqueName(base: unknown, taken: ReadonlySet<string>): string {
	const name = (typeof base === 'string' ? base.trim() : '') || 'Untitled';
	if (!taken.has(name)) return name;
	for (let n = 2; ; n++) {
		const candidate = `${name} (${n})`;
		if (!taken.has(candidate)) return candidate;
	}
}

export class PageNameSnapshot {
	private scopes = new Map<string, Map<string, Entry>>();

	/**
	 * Display names for `items` (live, in order) within `scope`. Items not
	 * seen before are recorded; recorded items missing from `items` become
	 * tombstones.
	 */
	resolve(scope: string, items: readonly NamedItem[]): NamedItem[] {
		let entries = this.scopes.get(scope);
		if (!entries) {
			entries = new Map();
			this.scopes.set(scope, entries);
		}
		const live = new Set(items.map(i => i.ref));
		for (const [ref, entry] of entries) {
			if (!live.has(ref)) entry.removed = true;
		}
		const out: NamedItem[] = [];
		for (const item of items) {
			let entry = entries.get(item.ref);
			if (!entry) {
				const taken = new Set([...entries.values()].map(e => e.name));
				entry = { name: uniqueName(item.name, taken), removed: false };
				entries.set(item.ref, entry);
			}
			// A ref can come back (e.g. an undo); treat it as live again.
			entry.removed = false;
			out.push({ ref: item.ref, name: entry.name });
		}
		return out;
	}

	/** Tombstones in `scope`: items recorded this session that are now gone. */
	removed(scope: string): NamedItem[] {
		const entries = this.scopes.get(scope);
		if (!entries) return [];
		return [...entries].filter(([, e]) => e.removed).map(([ref, e]) => ({ ref, name: e.name }));
	}

	/** The recorded name of `ref` in `scope`, if it has been resolved this session. */
	nameOf(scope: string, ref: string): string | undefined {
		return this.scopes.get(scope)?.get(ref)?.name;
	}

	/** Forget everything; names are taken fresh at the next resolve. */
	clear(): void {
		this.scopes.clear();
	}
}
