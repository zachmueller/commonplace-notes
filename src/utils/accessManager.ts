import type CommonplaceNotesPlugin from '../main';
import { Logger } from './logging';
import { partitionsFor, removedPartitions, type Partition } from './access';

/**
 * What changed about a note's partitions in this publish. `to: null` means the
 * note left the site entirely (e.g. it became gated but can't publish gated).
 */
export interface AccessTransition {
	uid: string;
	/** Partitions the note was published to before this publish. */
	from: Partition[];
	/** Partitions it publishes to now; null = unpublished everywhere. */
	to: Partition[] | null;
}

/**
 * Tracks, per profile, which access groups each published note was last
 * published with (`profiles/<id>/access.json`: uid → groups, `[]` = public),
 * and the transitions a publish causes so the uploader can delete copies from
 * partitions a note left.
 *
 * Deliberately NOT stored in the mapping dir: pushMappingAndIndexToS3 used to
 * upload that directory verbatim, and this file names groups and gated uids.
 *
 * Lifecycle: `load` at the start of a publish (re-reads disk, dropping any
 * unsaved state from a failed run), `set`/`markUnpublished` while committing,
 * `consumeTransitions` + `save` in the uploader once S3 reflects the change.
 * A failed publish therefore recomputes the same transitions next time.
 */
export class AccessManager {
	private plugin: CommonplaceNotesPlugin;
	private maps: Map<string, Record<string, string[]>> = new Map();
	private transitions: Map<string, AccessTransition[]> = new Map();
	private loaded: Set<string> = new Set();
	/** Profiles whose home note was unpublished this batch (delete notes/index.json). */
	private homeRemoved: Set<string> = new Set();

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
	}

	private path(profileId: string): string {
		return this.plugin.profileManager.getAccessMapPath(profileId);
	}

	async load(profileId: string): Promise<void> {
		let map: Record<string, string[]> = {};
		const p = this.path(profileId);
		try {
			if (await this.plugin.app.vault.adapter.exists(p)) {
				const parsed = JSON.parse(await this.plugin.app.vault.adapter.read(p)) as unknown;
				if (parsed && typeof parsed === 'object') map = parsed as Record<string, string[]>;
			}
		} catch (err) {
			// A corrupt file must not make gated notes look public: fail the publish.
			Logger.error(`Could not read access map ${p}:`, err);
			throw new Error(`Access map for profile ${profileId} is unreadable (${p}). Fix or delete it, then republish all notes.`);
		}
		this.maps.set(profileId, map);
		this.transitions.set(profileId, []);
		this.homeRemoved.delete(profileId);
		this.loaded.add(profileId);
	}

	/** Load from disk unless this profile was already loaded this session. */
	async ensureLoaded(profileId: string): Promise<void> {
		if (!this.loaded.has(profileId)) await this.load(profileId);
	}

	markHomeRemoved(profileId: string): void {
		this.homeRemoved.add(profileId);
	}

	/** Return and clear whether the home note was unpublished this batch. */
	consumeHomeRemoved(profileId: string): boolean {
		const v = this.homeRemoved.has(profileId);
		this.homeRemoved.delete(profileId);
		return v;
	}

	private map(profileId: string): Record<string, string[]> {
		let m = this.maps.get(profileId);
		if (!m) {
			m = {};
			this.maps.set(profileId, m);
		}
		return m;
	}

	/** The groups a uid was (or is being) published with; [] = public / unknown. */
	getGroups(profileId: string, uid: string): string[] {
		return this.map(profileId)[uid] ?? [];
	}

	/** Snapshot of uid → groups for gated notes only. */
	gatedUids(profileId: string): Record<string, string[]> {
		const out: Record<string, string[]> = {};
		for (const [uid, groups] of Object.entries(this.map(profileId))) {
			if (groups.length > 0) out[uid] = groups;
		}
		return out;
	}

	/** Every group that currently has at least one note. */
	groupsInUse(profileId: string): string[] {
		const set = new Set<string>();
		for (const groups of Object.values(this.map(profileId))) groups.forEach((g) => set.add(g));
		return [...set].sort();
	}

	/**
	 * Record that `uid` publishes with `groups` now. `wasPublished` says whether
	 * the note already had a live copy (so an unrecorded prior state means public).
	 */
	set(profileId: string, uid: string, groups: string[], wasPublished: boolean): void {
		const m = this.map(profileId);
		const prior = m[uid];
		const from: Partition[] = prior !== undefined ? partitionsFor(prior) : (wasPublished ? [null] : []);
		const to = partitionsFor(groups);
		m[uid] = [...groups];
		if (removedPartitions(from, to).length > 0) {
			this.push(profileId, { uid, from, to });
		}
	}

	/** Record that `uid` must be removed from every partition it was in. */
	markUnpublished(profileId: string, uid: string, wasPublished: boolean): void {
		const m = this.map(profileId);
		const prior = m[uid];
		const from: Partition[] = prior !== undefined ? partitionsFor(prior) : (wasPublished ? [null] : []);
		delete m[uid];
		if (from.length > 0) this.push(profileId, { uid, from, to: null });
	}

	/** Forget a uid without recording a transition (the caller deletes its copies). */
	remove(profileId: string, uid: string): void {
		delete this.map(profileId)[uid];
	}

	private push(profileId: string, t: AccessTransition): void {
		const list = this.transitions.get(profileId) ?? [];
		// Keep one entry per uid, preserving the earliest `from`.
		const existing = list.find((x) => x.uid === t.uid);
		if (existing) existing.to = t.to;
		else list.push(t);
		this.transitions.set(profileId, list);
	}

	/** Pending transitions for this publish (not cleared). */
	peekTransitions(profileId: string): AccessTransition[] {
		return [...(this.transitions.get(profileId) ?? [])];
	}

	/** Return and clear the pending transitions. */
	consumeTransitions(profileId: string): AccessTransition[] {
		const list = this.transitions.get(profileId) ?? [];
		this.transitions.set(profileId, []);
		return list;
	}

	async save(profileId: string): Promise<void> {
		await this.plugin.app.vault.adapter.write(this.path(profileId), JSON.stringify(this.map(profileId)));
	}
}
