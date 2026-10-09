import { TFile, App } from 'obsidian';
import { generateUID } from './uid';
import CommonplaceNotesPlugin from '../main';
import { Logger } from './logging';
import { NoticeManager } from '../utils/notice';
import { ACCESS_GROUPS_KEY, normalizeGroupList, type NormalizedGroups } from './access';
import { UidResolver, UID_KEY, normalizeUID, uidFromRaw } from './uidResolver';

/** What a frontmatter write did with `cpn-uid`. */
interface UidWriteOutcome {
	/** The UID on disk after the write (written now, or already there). */
	onDisk: string | null;
	/** A UID CPN was asked to write but refused, because the note already had a different one. */
	refused: string | null;
	/** The write added a UID (so the file changed and Obsidian will re-index it). */
	wroteUid: boolean;
}

/** How long {@link FrontmatterManager.process} waits for Obsidian to re-index written notes. */
const REINDEX_TIMEOUT_MS = 10000;

/** Result of {@link FrontmatterManager.process}. */
export interface FrontmatterProcessResult {
	/** Notes whose queued `cpn-uid` was refused because the note already had a different one on disk. */
	uidConflicts: string[];
}

export class FrontmatterManager {
	/** Queued frontmatter edits, keyed by file object (stable across renames). */
    private queue: Map<TFile, Record<string, unknown>> = new Map();
    private app: App;
	private plugin: CommonplaceNotesPlugin;
	private resolver: UidResolver<TFile>;
	private misconfiguredContexts: Set<string> = new Set();
	private lastNoticeTime: number = 0;
	private readonly NOTICE_COOLDOWN = 30000; // 30 seconds

    constructor(plugin: CommonplaceNotesPlugin) {
        this.plugin = plugin;
		this.app = plugin.app;
		this.resolver = new UidResolver<TFile>({
			readIndexedUid: (file) => this.getFrontmatterValue(file, UID_KEY),
			// Only notes that publish somewhere get a UID.
			canMint: (file) => this.hasFrontmatter(file) && this.normalizePublishContexts(file).length > 0,
			mint: () => generateUID(this.plugin.settings.uidLength),
			onMint: (file, uid) => {
				this.add(file, { [UID_KEY]: uid });
				Logger.debug(`Queuing frontmatter update to add UID ${uid} to ${file.basename}`);
			},
			name: (file) => file.path,
			log: {
				debug: (message) => Logger.debug(message),
				warn: (message) => Logger.warn(message),
			},
		});

		// Once the metadata cache shows a note's UID, the resolver no longer needs
		// to hold it.
		plugin.registerEvent(
			this.app.metadataCache.on('changed', (file, _data, cache) => {
				const fm = cache?.frontmatter as Record<string, unknown> | undefined;
				this.resolver.confirm(file, fm?.[UID_KEY]);
			}),
		);
    }

	getFrontmatter(file: TFile): Record<string, unknown> | undefined {
		const fileCache = this.app.metadataCache.getCache(file.path);
		return fileCache?.frontmatter;
	}

	getFrontmatterValue(file: TFile, key: string): unknown {
		const fm = this.getFrontmatter(file);
		return fm ? fm[key] : null;
	}

	hasFrontmatter(file: TFile): boolean {
		return this.getFrontmatter(file) !== undefined;
	}

	/** Normalize a UID for comparison: trim + uppercase (Crockford Base32 is uppercase). */
	static normalizeUID(uid: unknown): string {
		return normalizeUID(uid);
	}

	/**
	 * Every markdown file whose `cpn-uid` equals `uid` (normalized), in vault order.
	 * Empty if none. Scope = any md file carrying the UID (not just publish-context notes).
	 * Pure metadataCache read — do NOT use getNoteUID, which mints a cpn-uid as a side effect.
	 */
	getFilesByUID(uid: string): TFile[] {
		const target = FrontmatterManager.normalizeUID(uid);
		if (!target) return [];
		return this.app.vault.getMarkdownFiles().filter(
			(f) => FrontmatterManager.normalizeUID(this.getFrontmatterValue(f, 'cpn-uid')) === target,
		);
	}

	/**
	 * One-pass `cpn-uid` -> file map (normalized keys, first file wins on duplicate).
	 * Same pure-read caveat as getFilesByUID — never getNoteUID.
	 */
	buildUidToFileMap(): Map<string, TFile> {
		const map = new Map<string, TFile>();
		for (const f of this.app.vault.getMarkdownFiles()) {
			const uid = FrontmatterManager.normalizeUID(this.getFrontmatterValue(f, 'cpn-uid'));
			if (uid && !map.has(uid)) map.set(uid, f);
		}
		return map;
	}

	/**
	 * Normalize publish contexts - convert string to array if needed and track problematic files
	 */
	normalizePublishContexts(file: TFile): string[] {
		const rawContexts = this.getFrontmatterValue(file, 'cpn-publish-contexts');

		if (!rawContexts) {
			return [];
		}

		if (Array.isArray(rawContexts)) {
			return rawContexts as string[];
		}

		if (typeof rawContexts === 'string') {
			// Track this file as problematic, but don't auto-convert
			// Just keep it functional by wrapping in array
			this.misconfiguredContexts.add(file.path);

			// Just wrap in array for functional purposes - don't assume delimiters
			const normalized = [rawContexts.trim()];

			// Show notice if enough time has passed since last notice
			this.maybeShowContextsNotice();

			return normalized;
		}

		// If it's neither array nor string, track as problematic and return empty
		this.misconfiguredContexts.add(file.path);
		this.maybeShowContextsNotice();
		return [];
	}

	private maybeShowContextsNotice() {
		const now = Date.now();
		if (now - this.lastNoticeTime > this.NOTICE_COOLDOWN) {
			this.lastNoticeTime = now;
			this.showMisconfiguredContexts();
		}
	}

	private showMisconfiguredContexts() {
		if (this.misconfiguredContexts.size === 0) return;

		const fileList = Array.from(this.misconfiguredContexts)
			.slice(0, 5)
			.map(path => `  • ${path}`)
			.join('\n');

		const hasMore = this.misconfiguredContexts.size > 5;
		const moreText = hasMore ? `\n  ... and ${this.misconfiguredContexts.size - 5} more` : '';

		const message = `Found notes with cpn-publish-contexts as text instead of list:\n${fileList}${moreText}\n\nUse Developer Console to fix:\n> app.plugins.plugins['commonplace-notes'].fixPublishContextsFormat()`;

		NoticeManager.showNotice(message, 10000);
	}

	/**
	 * Get all files that have problematic publish contexts format
	 */
	getMisconfiguredContexts(): string[] {
		return Array.from(this.misconfiguredContexts);
	}

	/**
	 * Clear the problematic files tracking
	 */
	clearMisconfiguredContexts() {
		this.misconfiguredContexts.clear();
	}

	/**
	 * Fix publish contexts format for a specific file
	 */
	async fixPublishContextsFormat(file: TFile): Promise<boolean> {
		const rawContexts = this.getFrontmatterValue(file, 'cpn-publish-contexts');

		if (typeof rawContexts === 'string') {
			const normalized = rawContexts.includes(',')
				? rawContexts.split(',').map(s => s.trim()).filter(s => s.length > 0)
				: [rawContexts.trim()];

			await this.updateFrontmatter(file, {
				'cpn-publish-contexts': normalized
			});

			this.misconfiguredContexts.delete(file.path);
			return true;
		}

		return false;
	}

	/**
	 * The note's UID, minting one (queued for {@link process}) when the note has
	 * a publish context but no UID yet. A UID minted earlier is reused until the
	 * metadata cache shows it on disk, so a note gets exactly one UID even when
	 * it is looked up again after the write but before Obsidian re-indexes it.
	 *
	 * Mint only from the publish pipeline's queueing step (the note itself, and
	 * the targets of its links). Everything else should use {@link peekNoteUID}.
	 */
	getNoteUID(file: TFile): string | null {
		return this.resolver.resolve(file);
	}

	/** The note's UID (on disk, or minted and not yet indexed), never minting one. */
	peekNoteUID(file: TFile): string | null {
		return this.resolver.peek(file);
	}

	getNoteTitle(file: TFile): string {
		try {
			const title = this.getFrontmatterValue(file, 'cpn-title');
			return title ? String(title) : file.basename;
		} catch (error) {
			console.error('Error getting note title:', error);
			throw error;
		}
	}

	/**
	 * Named style for this note, from the `cpn-style` frontmatter string. Each
	 * publish context resolves this name against its own style registry; an
	 * unknown name falls back to default styling on the published site.
	 */
	getNoteStyle(file: TFile): string | null {
		const v = this.getFrontmatterValue(file, 'cpn-style');
		return typeof v === 'string' && v.trim() ? v.trim() : null;
	}

	/**
	 * Access groups from the `cpn-access-groups` frontmatter (per-note access
	 * gating), normalized. Empty groups = the note inherits the site-wide read
	 * gate. Invalid entries are reported, never silently dropped, so the caller
	 * can fail closed.
	 */
	getNoteAccessGroups(file: TFile): NormalizedGroups {
		return normalizeGroupList(this.getFrontmatterValue(file, ACCESS_GROUPS_KEY));
	}

    add(file: TFile, updates: Record<string, unknown>) {
        if (!this.queue.has(file)) {
            this.queue.set(file, {});
        }
        const fileUpdates = this.queue.get(file)!;
        Object.assign(fileUpdates, updates);
    }

	/**
	 * Write every queued frontmatter edit. An entry is removed once written; one
	 * whose write fails stays queued for the next publish (its minted UID stays
	 * held, so the retry writes the same UID), and the call throws after trying
	 * the rest.
	 *
	 * Returns once Obsidian has re-indexed the written notes and re-resolved
	 * their links. Until then the metadata cache and link graph for those notes
	 * are in flux, and staging that reads them mid-update drops backlinks.
	 */
    async process(): Promise<FrontmatterProcessResult> {
		const uidConflicts: string[] = [];
		const failures: string[] = [];
		// Written files whose post-write link resolution hasn't been seen yet.
		// Each file is added before its write, so a fast `resolve` isn't missed.
		const awaitingResolve = new Set<TFile>();
		let wake: (() => void) | null = null;
		const ref = this.app.metadataCache.on('resolve', (file) => {
			if (awaitingResolve.delete(file) && awaitingResolve.size === 0) wake?.();
		});
		try {
			for (const [file, updates] of [...this.queue]) {
				if (this.app.vault.getAbstractFileByPath(file.path) !== file) {
					Logger.warn(`Dropping queued frontmatter edits for ${file.path}: the note no longer exists`);
					this.queue.delete(file);
					continue;
				}
				awaitingResolve.add(file);
				try {
					Logger.debug(`Commit frontmatter edits to ${file.basename}: ${JSON.stringify(updates)}`);
					const outcome = await this.writeFrontmatter(file, updates, 'replace');
					if (outcome.refused !== null) uidConflicts.push(file.path);
					// Nothing changed on disk, so there will be no re-index to wait for.
					const changed = outcome.wroteUid || Object.keys(updates).some((k) => k !== UID_KEY);
					if (!changed) awaitingResolve.delete(file);
					this.queue.delete(file);
				} catch (error) {
					awaitingResolve.delete(file);
					Logger.error(`Failed to write frontmatter for ${file.path}:`, error);
					failures.push(file.path);
				}
			}
			if (awaitingResolve.size > 0) {
				await new Promise<void>((resolve) => {
					const timer = window.setTimeout(() => {
						Logger.warn(`Timed out waiting for Obsidian to re-index ${awaitingResolve.size} note(s) after writing their frontmatter`);
						resolve();
					}, REINDEX_TIMEOUT_MS);
					wake = () => {
						window.clearTimeout(timer);
						resolve();
					};
				});
			}
		} finally {
			this.app.metadataCache.offref(ref);
		}
		if (failures.length > 0) {
			const listed = failures.slice(0, 5).join(', ');
			const more = failures.length > 5 ? ` and ${failures.length - 5} more` : '';
			throw new Error(`Could not write frontmatter for ${listed}${more}`);
		}
		Logger.debug('Frontmatter queue processed');
		return { uidConflicts };
    }

	async updateFrontmatter(file: TFile, updates: Record<string, unknown>): Promise<void> {
		await this.writeFrontmatter(file, updates, 'replace');
	}

	/**
	 * Merge updates into a note's frontmatter, preserving existing collection
	 * values instead of overwriting them (unlike {@link updateFrontmatter}):
	 *   - existing array (or JSON-array string) → union + de-dupe with the value
	 *   - existing plain object + object value  → shallow merge (value wins)
	 *   - otherwise                             → scalar overwrite
	 *   - `undefined` value                     → delete the key
	 *   - `cpn-uid`                             → set only if the note has none
	 *
	 * Ports the semantics of Zach's Templater `setFrontmatter()` for the routing
	 * engine (e.g. so re-routing unions publish contexts rather than clobbering).
	 * Writes directly via `processFrontMatter` — not through the batch queue,
	 * since routing is interactive.
	 */
	async mergeFrontmatter(file: TFile, updates: Record<string, unknown>): Promise<void> {
		await this.writeFrontmatter(file, updates, 'merge');
	}

	/**
	 * Apply `updates` to a note's frontmatter in one `processFrontMatter` call,
	 * resolving after the file is written (and rejecting if it can't be).
	 *
	 * `cpn-uid` is set only when the note has none: an existing UID backs a
	 * published URL, and replacing it would publish the note a second time under
	 * the new UID. A refused UID is logged and reported in the outcome.
	 */
	private async writeFrontmatter(
		file: TFile,
		updates: Record<string, unknown>,
		mode: 'replace' | 'merge',
	): Promise<UidWriteOutcome> {
		const outcome: UidWriteOutcome = { onDisk: null, refused: null, wroteUid: false };
		await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			for (const [key, value] of Object.entries(updates)) {
				if (key === UID_KEY) {
					this.applyUid(frontmatter, value, outcome);
				} else if (value === undefined) {
					delete frontmatter[key];
				} else if (mode === 'merge') {
					this.mergeValue(frontmatter, key, value);
				} else {
					frontmatter[key] = value;
				}
			}
		});
		if (outcome.refused !== null) {
			Logger.warn(
				`Kept cpn-uid ${outcome.onDisk} on ${file.path}; refused to replace it with ${outcome.refused}`,
			);
		}
		// Hold the on-disk UID until the metadata cache re-indexes the file.
		if (outcome.onDisk !== null) this.resolver.remember(file, outcome.onDisk);
		return outcome;
	}

	private applyUid(frontmatter: Record<string, unknown>, value: unknown, outcome: UidWriteOutcome): void {
		const existing = uidFromRaw(frontmatter[UID_KEY]);
		if (value === undefined) {
			// Explicit removal by a caller.
			delete frontmatter[UID_KEY];
			return;
		}
		const incoming = uidFromRaw(value);
		if (existing !== null) {
			outcome.onDisk = existing;
			if (incoming !== null && incoming !== existing) outcome.refused = incoming;
			return;
		}
		if (incoming === null) return;
		frontmatter[UID_KEY] = value;
		outcome.onDisk = incoming;
		outcome.wroteUid = true;
	}

	/** {@link mergeFrontmatter}'s per-key rule (see its doc comment). */
	private mergeValue(frontmatter: Record<string, unknown>, key: string, value: unknown): void {
		const existing = frontmatter[key];
		const existingArray = this.asArrayOrNull(existing);

		if (existingArray !== null) {
			// Array (or JSON-array string) property → union + de-dupe.
			const incoming: unknown[] = Array.isArray(value) ? value : [value];
			frontmatter[key] = [...new Set([...existingArray, ...incoming])];
		} else if (
			existing &&
			typeof existing === 'object' &&
			!Array.isArray(existing) &&
			value &&
			typeof value === 'object' &&
			!Array.isArray(value)
		) {
			// Object property → shallow merge.
			frontmatter[key] = { ...existing, ...value };
		} else {
			// Scalar / absent → set (overwrite).
			frontmatter[key] = value;
		}
	}

	/** Coerce an existing frontmatter value to an array if it is one (or a JSON-array string), else null. */
	private asArrayOrNull(existing: unknown): unknown[] | null {
		if (Array.isArray(existing)) return existing as unknown[];
		if (typeof existing === 'string' && existing.trim().startsWith('[')) {
			try {
				const parsed: unknown = JSON.parse(existing);
				if (Array.isArray(parsed)) return parsed as unknown[];
			} catch {
				// Not valid JSON — fall through, treat as scalar.
			}
		}
		return null;
	}

	async togglePublishContext(file: TFile, profileId: string): Promise<void> {
		const contexts = this.normalizePublishContexts(file);
		const wasPresent = contexts.includes(profileId);
		
		const updatedContexts = wasPresent
			? contexts.filter((ctx: string) => ctx !== profileId)
			: [...contexts, profileId];
		
		await this.updateFrontmatter(file, {
			'cpn-publish-contexts': updatedContexts
		});

		// Remove from problematic files since we're fixing it
		this.misconfiguredContexts.delete(file.path);

		// Highlight to user whether it was added/removed
		NoticeManager.showNotice(
			wasPresent 
				? `Removed "${profileId}" from publishing contexts`
				: `Added "${profileId}" to publishing contexts`
		);
	}

	// Check queue status
	hasUpdates(): boolean {
		return this.queue.size > 0;
	}

	// Get queue size
	getQueueSize(): number {
		return this.queue.size;
	}

	// Clear queue without processing
	clear() {
		this.queue.clear();
	}
}