/**
 * Attachment change notice (attachment spec phase 4).
 *
 * Editing an attachment doesn't touch the notes that reference it, so nothing
 * republishes them (P2 §8). This module tells the author when a published file
 * changes:
 *
 * - {@link AttachmentReferenceIndex} remembers, per profile, which published
 *   notes reference each attachment vault path and the hash each published.
 *   It is filled after every successful publish and is never persisted: the
 *   first publish after Obsidian starts rebuilds it.
 * - {@link AttachmentChangeWatcher} takes vault `modify` events, debounces
 *   them 5 s per file, and decides which profiles get a notice: profiles where
 *   the file still publishes and some note published different bytes.
 * - {@link runRepublish} is what the notice's **Republish them** button does.
 *
 * Pure module (no Obsidian imports): the vault, the hash cache, timers and the
 * notice itself come in through the deps, so it is unit-testable on its own.
 */

import { baseNameOf } from './attachments';

/** One attachment a published note revision uses. */
export interface PublishedRef {
	vaultPath: string;
	sha256: string;
}

/** One note a publish uploaded, with the attachments its revision uses. */
export interface PublishedNote {
	notePath: string;
	uid: string;
	refs: readonly PublishedRef[];
}

/** A published note that references one attachment. */
export interface ReferencingNote {
	notePath: string;
	uid: string;
	/** The hash the note's published revision uses. */
	sha256: string;
}

interface NoteEntry {
	uid: string;
	/** vaultPath → sha256 */
	refs: Map<string, string>;
}

/** In-memory map of profile → published note → the attachments it uses. */
export class AttachmentReferenceIndex {
	private byProfile = new Map<string, Map<string, NoteEntry>>();

	/**
	 * After a successful publish: each uploaded note's entry is replaced by its
	 * new refs (dropped when it has none). Notes outside the batch keep theirs.
	 */
	record(profileId: string, notes: readonly PublishedNote[]): void {
		let profileNotes = this.byProfile.get(profileId);
		if (!profileNotes) this.byProfile.set(profileId, profileNotes = new Map<string, NoteEntry>());
		for (const note of notes) {
			// One UID lives at one path: a renamed note's stale path goes.
			for (const [path, entry] of profileNotes) {
				if (entry.uid === note.uid && path !== note.notePath) profileNotes.delete(path);
			}
			if (note.refs.length === 0) {
				profileNotes.delete(note.notePath);
				continue;
			}
			profileNotes.set(note.notePath, {
				uid: note.uid,
				refs: new Map(note.refs.map(r => [r.vaultPath, r.sha256])),
			});
		}
		if (profileNotes.size === 0) this.byProfile.delete(profileId);
	}

	/** Whether any profile's published notes reference `vaultPath`. */
	references(vaultPath: string): boolean {
		for (const notes of this.byProfile.values()) {
			for (const entry of notes.values()) if (entry.refs.has(vaultPath)) return true;
		}
		return false;
	}

	/** The profiles (in recording order) with a published note referencing `vaultPath`. */
	profilesReferencing(vaultPath: string): string[] {
		const out: string[] = [];
		for (const [profileId, notes] of this.byProfile) {
			for (const entry of notes.values()) {
				if (entry.refs.has(vaultPath)) { out.push(profileId); break; }
			}
		}
		return out;
	}

	/** The published notes on `profileId` that reference `vaultPath`, sorted by path. */
	referencing(profileId: string, vaultPath: string): ReferencingNote[] {
		const out: ReferencingNote[] = [];
		for (const [notePath, entry] of this.byProfile.get(profileId) ?? []) {
			const sha256 = entry.refs.get(vaultPath);
			if (sha256 !== undefined) out.push({ notePath, uid: entry.uid, sha256 });
		}
		return out.sort((a, b) => a.notePath.localeCompare(b.notePath));
	}

	/** A note was renamed in the vault: its entries follow it. */
	renameNote(oldPath: string, newPath: string): void {
		for (const notes of this.byProfile.values()) {
			const entry = notes.get(oldPath);
			if (!entry) continue;
			notes.delete(oldPath);
			notes.set(newPath, entry);
		}
	}

	/** A note was deleted from the vault. */
	forgetNote(notePath: string): void {
		for (const [profileId, notes] of this.byProfile) {
			notes.delete(notePath);
			if (notes.size === 0) this.byProfile.delete(profileId);
		}
	}

	/** A note was deleted from a profile's site. */
	forgetUid(profileId: string, uid: string): void {
		const notes = this.byProfile.get(profileId);
		if (!notes) return;
		for (const [path, entry] of notes) if (entry.uid === uid) notes.delete(path);
		if (notes.size === 0) this.byProfile.delete(profileId);
	}
}

/** setTimeout/clearTimeout, injectable for tests. */
export interface Timers {
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

/** Runs `fire(key)` once `delayMs` after the last `trigger(key)`. */
export class KeyedDebouncer {
	private pending = new Map<string, unknown>();

	constructor(
		private readonly delayMs: number,
		private readonly fire: (key: string) => void,
		private readonly timers: Timers,
	) {}

	trigger(key: string): void {
		const existing = this.pending.get(key);
		if (existing !== undefined) this.timers.clear(existing);
		this.pending.set(key, this.timers.set(() => {
			this.pending.delete(key);
			this.fire(key);
		}, this.delayMs));
	}

	cancelAll(): void {
		for (const handle of this.pending.values()) this.timers.clear(handle);
		this.pending.clear();
	}

	get size(): number {
		return this.pending.size;
	}
}

export const CHANGE_NOTICE_DEBOUNCE_MS = 5000;

/** What one notice says and what its button republishes. */
export interface ChangeNotice {
	profileId: string;
	profileName: string;
	/** Name the profile in the text (more than one profile is configured). */
	nameProfile: boolean;
	vaultPath: string;
	fileName: string;
	/** The published notes whose revision uses other bytes than the file has now. */
	notePaths: string[];
}

export interface ChangeWatcherDeps {
	/** The configured profiles. */
	profiles(): ReadonlyArray<{ id: string; name: string }>;
	/** Whether the per-machine hash cache has an entry for the file (P2 §6). */
	hasHashEntry(vaultPath: string): Promise<boolean>;
	/**
	 * Whether the file would still publish on the profile now: the attachment
	 * mode isn't off, and the file isn't excluded, is allowed and is within
	 * the size cap.
	 */
	eligible(profileId: string, vaultPath: string): Promise<boolean>;
	/** The file's current content hash, or null when it can't be read. */
	currentHash(vaultPath: string): Promise<string | null>;
	notify(notice: ChangeNotice): void;
	warn(message: string, error: unknown): void;
	timers: Timers;
	delayMs?: number;
}

/** Watches attachment edits and raises one notice per profile that uses them. */
export class AttachmentChangeWatcher {
	readonly index = new AttachmentReferenceIndex();
	private readonly debouncer: KeyedDebouncer;
	/** Resolves when the most recent check finishes (tests). */
	lastCheck: Promise<void> = Promise.resolve();

	constructor(private readonly deps: ChangeWatcherDeps) {
		this.debouncer = new KeyedDebouncer(deps.delayMs ?? CHANGE_NOTICE_DEBOUNCE_MS, path => {
			this.lastCheck = this.check(path).catch(e => deps.warn(`Could not check ${path} for the change notice:`, e));
		}, deps.timers);
	}

	/** A vault `modify` event. Notes and files no published note uses are ignored. */
	onModify(vaultPath: string): void {
		if (vaultPath.toLowerCase().endsWith('.md')) return;
		if (!this.index.references(vaultPath)) return;
		this.debouncer.trigger(vaultPath);
	}

	stop(): void {
		this.debouncer.cancelAll();
	}

	/** The debounced check for one file. */
	async check(vaultPath: string): Promise<void> {
		if (!await this.deps.hasHashEntry(vaultPath)) return;
		const profiles = this.deps.profiles();
		const candidates: Array<{ id: string; name: string }> = [];
		for (const profileId of this.index.profilesReferencing(vaultPath)) {
			const profile = profiles.find(p => p.id === profileId);
			if (profile && await this.deps.eligible(profileId, vaultPath)) candidates.push(profile);
		}
		if (candidates.length === 0) return;
		const current = await this.deps.currentHash(vaultPath);
		if (current === null) return;
		for (const profile of candidates) {
			const stale = this.index.referencing(profile.id, vaultPath).filter(n => n.sha256 !== current);
			if (stale.length === 0) continue;
			this.deps.notify({
				profileId: profile.id,
				profileName: profile.name,
				nameProfile: profiles.length > 1,
				vaultPath,
				fileName: baseNameOf(vaultPath),
				notePaths: stale.map(n => n.notePath),
			});
		}
	}
}

/**
 * The text after the file name: "changed. 3 published notes use it." With
 * `profileName`, "changed. 3 published notes in <profile> use it."
 */
export function changeNoticeTail(noteCount: number, profileName?: string): string {
	const notes = noteCount === 1 ? '1 published note' : `${noteCount} published notes`;
	const where = profileName ? ` in ${profileName}` : '';
	return ` changed. ${notes}${where} ${noteCount === 1 ? 'uses' : 'use'} it.`;
}

/** The whole notice as plain text (logs and tests). */
export function changeNoticeText(notice: ChangeNotice): string {
	return notice.fileName + changeNoticeTail(notice.notePaths.length, notice.nameProfile ? notice.profileName : undefined);
}

export interface RepublishDeps<F> {
	/** What holds the profile's publish lock, or null when it's free. */
	lockHolder(profileId: string): string | null;
	/** Show the busy notice for a refused request. */
	showBusy(heldBy: string): void;
	/** The vault note at `notePath` if it still publishes on the profile. */
	resolve(notePath: string): Promise<F | null>;
	/** Publish through the publisher (which takes the lock itself). */
	publish(files: F[]): Promise<void>;
	/** Close the change notice. */
	dismiss(): void;
}

/**
 * **Republish them**. While the profile is busy the busy notice shows and the
 * change notice stays open, so the author can try again. Otherwise the notice
 * closes and the referencing notes that still publish go to `publish`, which
 * holds the lock (and shows the busy notice itself if a publish started in
 * between). Returns `busy` when refused, `none` when no referencing note
 * publishes on the profile any more, else `published`.
 */
export async function runRepublish<F>(notice: ChangeNotice, deps: RepublishDeps<F>): Promise<'busy' | 'none' | 'published'> {
	const heldBy = deps.lockHolder(notice.profileId);
	if (heldBy !== null) {
		deps.showBusy(heldBy);
		return 'busy';
	}
	deps.dismiss();
	const files: F[] = [];
	for (const path of notice.notePaths) {
		const file = await deps.resolve(path);
		if (file) files.push(file);
	}
	if (files.length === 0) return 'none';
	await deps.publish(files);
	return 'published';
}
