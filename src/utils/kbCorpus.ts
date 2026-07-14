import CommonplaceNotesPlugin from '../main';
import { PathUtils } from './path';
import { convertMarkdownToPlaintext } from './formatting';
import { Logger } from './logging';

/**
 * Manages the per-UID `kb/{uid}.md` chat corpus — the latest-only plaintext
 * artifacts a Bedrock Knowledge Base ingests. Mirrors ContentIndexManager's
 * freshness/pruning semantics (keyed by stable UID, overwritten in place,
 * deleted on note removal) so the corpus is *always* exactly the current set of
 * latest note versions — never the accumulating `notes/{hash}.json` iterations.
 *
 * Unlike the single-blob content index, each note is its own file so ingestion
 * can chunk per note. Because objects are per-UID, the upload path is
 * incremental (only UIDs changed this publish) and the delete path must issue an
 * explicit per-object S3 delete — a wholesale re-push cannot orphan-remove a
 * now-deleted object. `consumeChangedUids` exposes the changed set to the
 * uploader for that incremental push.
 */
export class KbCorpusManager {
	private plugin: CommonplaceNotesPlugin;
	/** profileId → (uid → staged markdown body), awaiting applyQueuedUpdates. */
	private pendingUpdates: Map<string, Map<string, string>>;
	/** profileId → uids whose local artifact changed since the last upload. */
	private changedUids: Map<string, Set<string>>;

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
		this.pendingUpdates = new Map();
		this.changedUids = new Map();
	}

	/**
	 * Convert a note to its whole-note corpus body (title as H1 + plaintext) and
	 * stage it. Never throws — falls back to the title on conversion failure, so a
	 * single bad note can't abort the publish (mirrors ContentIndexManager).
	 */
	async queueUpdate(profileId: string, uid: string, title: string, rawMarkdown: string): Promise<void> {
		try {
			let content: string;
			try {
				content = await convertMarkdownToPlaintext(rawMarkdown, this.plugin);
			} catch (conversionError) {
				Logger.warn(`Failed to convert KB corpus for ${title} (${uid}), using fallback:`, conversionError);
				content = title;
			}

			const body = this.buildBody(title, content);
			if (!this.pendingUpdates.has(profileId)) {
				this.pendingUpdates.set(profileId, new Map());
			}
			this.pendingUpdates.get(profileId)!.set(uid, body);
		} catch (error) {
			Logger.error(`Error queuing KB corpus update for ${title} (${uid}):`, error);
			const fallback = this.buildBody(title, title);
			if (!this.pendingUpdates.has(profileId)) {
				this.pendingUpdates.set(profileId, new Map());
			}
			this.pendingUpdates.get(profileId)!.set(uid, fallback);
		}
	}

	/** Whole-note body: title as an H1 followed by the plaintext content (Q3). */
	private buildBody(title: string, content: string): string {
		return `# ${title}\n\n${content}\n`;
	}

	/**
	 * Write every staged artifact to its local `kb/{uid}.md`, recording each UID
	 * as changed for the incremental uploader, then clear the queue.
	 */
	async applyQueuedUpdates(profileId: string): Promise<void> {
		const updates = this.pendingUpdates.get(profileId);
		if (!updates || updates.size === 0) {
			this.pendingUpdates.delete(profileId);
			return;
		}

		try {
			const dir = this.plugin.profileManager.getKbCorpusDir(profileId);
			await PathUtils.ensureDirectory(this.plugin, dir);

			for (const [uid, body] of updates) {
				const filePath = this.plugin.profileManager.getKbCorpusPath(profileId, uid);
				await this.plugin.app.vault.adapter.write(filePath, body);
				this.markChanged(profileId, uid);
				Logger.debug(`Wrote KB corpus artifact for ${uid} in profile ${profileId}`);
			}

			this.pendingUpdates.delete(profileId);
		} catch (error) {
			Logger.error(`Error applying KB corpus updates for profile ${profileId}:`, error);
			throw error;
		}
	}

	/** Delete a note's local corpus artifact (called on note removal/unpublish). */
	async removeEntry(profileId: string, uid: string): Promise<void> {
		const filePath = this.plugin.profileManager.getKbCorpusPath(profileId, uid);
		try {
			if (await this.plugin.app.vault.adapter.exists(filePath)) {
				await this.plugin.app.vault.adapter.remove(filePath);
				Logger.debug(`Removed KB corpus artifact for UID ${uid} in profile ${profileId}`);
			}
		} catch (error) {
			Logger.error(`Error removing KB corpus artifact for ${uid} in profile ${profileId}:`, error);
			throw error;
		}
		// Drop any pending/changed bookkeeping for this UID.
		this.pendingUpdates.get(profileId)?.delete(uid);
		this.changedUids.get(profileId)?.delete(uid);
	}

	private markChanged(profileId: string, uid: string): void {
		if (!this.changedUids.has(profileId)) {
			this.changedUids.set(profileId, new Set());
		}
		this.changedUids.get(profileId)!.add(uid);
	}

	/**
	 * Return and clear the set of UIDs whose artifact changed since the last call.
	 * The uploader consumes this to push only changed objects incrementally.
	 */
	consumeChangedUids(profileId: string): string[] {
		const set = this.changedUids.get(profileId);
		if (!set || set.size === 0) return [];
		const uids = [...set];
		this.changedUids.delete(profileId);
		return uids;
	}
}
