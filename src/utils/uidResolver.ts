/**
 * Note UID resolution with no Obsidian dependency, so it can be unit-tested
 * under plain Node (see e2e/scripts/test-uid-resolver.ts).
 *
 * The problem it solves: a UID minted for a note during a publish is written to
 * the note's frontmatter, but Obsidian's metadata cache only re-indexes the
 * file some time later. Any lookup in that window used to see "no UID" and
 * mint a second one, which then replaced the first on the next publish and left
 * the note on the site under two UIDs. The resolver therefore remembers every
 * UID it minted (or that CPN wrote) until the metadata cache shows a UID for
 * that file, and never mints while it holds one.
 */

export const UID_KEY = 'cpn-uid';

/**
 * The UID a raw `cpn-uid` frontmatter value stands for, or null when the note
 * has none. Mirrors how CPN has always read the value (`String(value)` of any
 * truthy value), so existing notes keep resolving to the exact UID they were
 * published under, including values YAML parsed as numbers.
 */
export function uidFromRaw(raw: unknown): string | null {
	if (!raw) return null;
	const uid = String(raw);
	return uid.trim() === '' ? null : uid;
}

/** Normalize a UID for comparison: trim + uppercase (Crockford Base32 is uppercase). */
export function normalizeUID(uid: unknown): string {
	return String(uid ?? '').trim().toUpperCase();
}

export interface UidResolverHooks<F> {
	/** Raw `cpn-uid` value from the metadata cache (undefined if absent or not indexed yet). */
	readIndexedUid(file: F): unknown;
	/** Whether a UID may be minted for this file (it lists a publish context). */
	canMint(file: F): boolean;
	/** Produce a fresh UID. */
	mint(): string;
	/** Called once per mint, e.g. to queue the frontmatter write. */
	onMint(file: F, uid: string): void;
	/** Human-readable name for log lines. */
	name(file: F): string;
	log: { debug(message: string): void; warn(message: string): void };
}

/**
 * Resolves a file's UID: the metadata cache wins, then a UID minted or written
 * for the file that the cache hasn't caught up with yet, then (for
 * {@link resolve} only) a freshly minted one.
 *
 * Pending UIDs are held in a WeakMap keyed by the file object. Obsidian keeps
 * the same TFile across renames and drops it on delete, so a note renamed
 * mid-publish keeps its UID and a new note created at a deleted note's path
 * does not inherit one.
 */
export class UidResolver<F extends object> {
	private pending = new WeakMap<F, string>();

	constructor(private readonly hooks: UidResolverHooks<F>) {}

	/** The file's UID without ever minting one. */
	peek(file: F): string | null {
		const indexed = uidFromRaw(this.hooks.readIndexedUid(file));
		const pending = this.pending.get(file);
		if (indexed !== null) {
			if (pending !== undefined) {
				this.pending.delete(file);
				if (pending !== indexed) {
					this.hooks.log.warn(
						`${this.hooks.name(file)} has cpn-uid ${indexed} on disk; dropping UID ${pending} that CPN held for it`,
					);
				}
			}
			return indexed;
		}
		if (pending !== undefined) {
			this.hooks.log.debug(`Using pending UID for ${this.hooks.name(file)}: ${pending}`);
			return pending;
		}
		return null;
	}

	/** The file's UID, minting one when it has none and is allowed one. */
	resolve(file: F): string | null {
		const existing = this.peek(file);
		if (existing !== null) return existing;
		if (!this.hooks.canMint(file)) return null;
		const uid = this.hooks.mint();
		this.pending.set(file, uid);
		this.hooks.onMint(file, uid);
		return uid;
	}

	/**
	 * Record a UID known to be on disk for this file (just written by CPN, or
	 * found there when a write was refused) until the metadata cache shows it.
	 */
	remember(file: F, uid: string): void {
		this.pending.set(file, uid);
	}

	/** Metadata-cache `changed` hook: forget the pending UID once the cache has one. */
	confirm(file: F, indexedRaw: unknown): void {
		const pending = this.pending.get(file);
		if (pending === undefined) return;
		const indexed = uidFromRaw(indexedRaw);
		if (indexed === null) return;
		this.pending.delete(file);
		if (indexed !== pending) {
			this.hooks.log.warn(
				`${this.hooks.name(file)} was indexed with cpn-uid ${indexed}; dropping UID ${pending} that CPN held for it`,
			);
		} else {
			this.hooks.log.debug(`Metadata cache confirmed UID ${indexed} for ${this.hooks.name(file)}`);
		}
	}

	hasPending(file: F): boolean {
		return this.pending.has(file);
	}
}
