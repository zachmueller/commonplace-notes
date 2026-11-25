import { TFile } from 'obsidian';
import CommonplaceNotesPlugin from '../main';
import { PathUtils } from './path';
import { ResolvedNoteInfo } from './remarkObsidianLinks';
import { Logger } from './logging';
import { UrlScheme } from './urlScheme';
import type { ParserContext } from './parser/types';
import { scrubRawWikilinks, type ResolvedTarget } from './rewriteRawWikilinks';
import type { PublishingProfile } from '../types';
import { linkVisibleFrom, partitionsFor, validateNoteAccess, visibleInPartition } from './access';
import { NoticeManager } from './notice';
import { attachmentHashSegment, noteJsonAttachments, type AttachmentRef } from './attachments';
import type { PublishedNote } from './attachmentChangeNotice';

/** A note's resolved access: its groups, and whether it may publish with them. */
export interface NoteAccess {
	groups: string[];
	ok: boolean;
	/** Why the note can't publish (when !ok). */
	reason?: string;
}

/** A note skipped this publish because its access groups can't be honored. */
interface BlockedNote {
	file: TFile;
	uid: string;
	reason: string;
	isHome: boolean;
}

interface NoteState {
	file: TFile;
	uid: string;
	currentHash: string;
	priorHash: string | null;
	slug: string;
	title: string;
	content: string;  // HTML content
	raw: string;	  // Raw Markdown
	lastModified: number;
	style: string | null;  // `cpn-style` frontmatter value, resolved client-side per profile
	access: string[];      // `cpn-access-groups` ([] = public; else only restricted/<group>/ partitions)
	/** Files this revision publishes with (attachment spec P2 §3); [] when none. */
	attachments: AttachmentRef[];
}

interface BacklinkInfo {
	uid: string;
	slug: string;
	title: string;
	/** The backlinking note's access groups (used to filter per partition; not published). */
	access: string[];
}

export class NoteManager {
	private pendingNotes: Map<string, NoteState>;
	/** `${profileId}:${uid}` → notes skipped for access reasons in the current batch. */
	private blockedNotes: Map<string, BlockedNote> = new Map();
	private publishHistory: Map<string, Record<string, string[]>>;
	private plugin: CommonplaceNotesPlugin;

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
		this.pendingNotes = new Map();
		this.publishHistory = new Map();
	}

	async loadPublishHistory(profileId: string): Promise<Record<string, string[]>> {
		if (this.publishHistory.has(profileId)) {
			return this.publishHistory.get(profileId)!;
		}

		const historyPath = this.plugin.profileManager.getPublishHistoryPath(profileId);
		try {
			const content = await this.plugin.app.vault.adapter.read(historyPath);
			const history = JSON.parse(content) as Record<string, string[]>;
			this.publishHistory.set(profileId, history);
			return history;
		} catch {
			const emptyHistory = {};
			this.publishHistory.set(profileId, emptyHistory);
			return emptyHistory;
		}
	}

	private async savePublishHistory(profileId: string) {
		const history = this.publishHistory.get(profileId);
		if (!history) return;

		const historyPath = this.plugin.profileManager.getPublishHistoryPath(profileId);
		await this.plugin.app.vault.adapter.write(
			historyPath,
			JSON.stringify(history)
		);
	}

	private getMostRecentPriorHash(history: Record<string, string[]>, uid: string, currentHash: string): string | null {
		const hashes = history[uid] || [];

		// If no history exists
		if (hashes.length === 0) {
			return null;
		}

		// If the last hash matches current, get the second-to-last hash
		if (hashes[hashes.length - 1] === currentHash) {
			return hashes.length > 1 ? hashes[hashes.length - 2] : null;
		}

		// Otherwise return the most recent hash
		return hashes[hashes.length - 1];
	}

	private shouldAddHashToHistory(history: Record<string, string[]>, uid: string, newHash: string): boolean {
		const hashes = history[uid] || [];
		// Only add if it's different from the last hash in history
		return hashes.length === 0 || hashes[hashes.length - 1] !== newHash;
	}

	async getSHA1Hash(content: string): Promise<string> {
		const msgUint8 = new TextEncoder().encode(content);
		const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	}

	async stripFrontmatter(file: TFile, content: string): Promise<string> {
		const cache = this.plugin.app.metadataCache.getFileCache(file);
		if (cache?.frontmatter && cache.frontmatterPosition) {
			const frontmatterEnd = cache.frontmatterPosition.end.offset;
			return content.slice(frontmatterEnd).trim();
		}
		return content;
	}

	async getBacklinks(targetFile: TFile, profileId: string): Promise<BacklinkInfo[]> {
		const connections = await this.plugin.publisher.getConnectedNotes(targetFile, profileId);

		// Backlinks from notes that have a UID (a note without one has never
		// been published, so there is no page to link to).
		const backlinks: BacklinkInfo[] = [];
		for (const connection of connections) {
			if (!connection.isBacklink || connection.uid === null) continue;
			backlinks.push({
				uid: connection.uid,
				slug: connection.slug,
				title: connection.title,
				access: connection.access,
			});
		}
		return backlinks;
	}

	/**
	 * Resolve a note's access groups for a profile and whether it can publish
	 * with them (fail closed: undefined groups, a non-group-aware read gate, the
	 * home note, or a malformed value all block publishing). See src/utils/access.ts.
	 */
	resolveNoteAccess(file: TFile, profile: PublishingProfile): NoteAccess {
		const normalized = this.plugin.frontmatterManager.getNoteAccessGroups(file);
		const isHome = !!profile.homeNotePath && profile.homeNotePath === file.path;
		const check = validateNoteAccess(profile, normalized, isHome);
		return check.ok
			? { groups: normalized.groups, ok: true }
			: { groups: normalized.groups, ok: false, reason: check.reason };
	}

	/**
	 * `attachments` is the note's attachment list (§3). The renderer only
	 * publishes files in it; every other link to a non-Markdown vault file
	 * renders as an unpublished span (always so with the mode off and on
	 * Local profiles, where the list is empty).
	 */
	async markdownToHtml(
		markdown: string,
		currentFile: TFile,
		profileId: string,
		sourceGroups: string[] = [],
		attachments: readonly AttachmentRef[] = [],
	): Promise<string> {
		const urlScheme: UrlScheme = this.plugin.settings.urlScheme || 'current';
		const profile = this.plugin.settings.publishingProfiles.find(p => p.id === profileId);

		// Per-note context handed to every parser stage. The resolveInternalLinks
		// closure (formerly inline in this method) is lifted here so the built-in
		// `remark-obsidian-links` stage — and any user override of it — consumes it
		// from `context` without behavior change.
		const context: ParserContext = {
			file: currentFile,
			profileId,
			frontmatterManager: this.plugin.frontmatterManager,
			urlScheme,
			noteStyle: this.plugin.frontmatterManager.getNoteStyle(currentFile),
			resolveAttachment: this.plugin.attachmentManager.resolverFor(currentFile.path, attachments, profile),
			resolveInternalLinks: async (notePath: string): Promise<ResolvedNoteInfo | null> => {
				const targetFile = this.plugin.app.metadataCache.getFirstLinkpathDest(notePath, currentFile.path);

				if (targetFile instanceof TFile && targetFile.extension === 'md') {
					try {
						const uid = this.plugin.frontmatterManager.getNoteUID(targetFile);
						if (uid === null) return null;
						const contexts = await this.plugin.publisher.getPublishContextsForFile(targetFile);

						if (contexts.includes(profileId)) {
							// Per-note access: this HTML is shared by every partition copy
							// of the current note, so only resolve the link when the target
							// is visible in all of them. Otherwise it renders like a link to
							// an unpublished note (no uid, no title leak). With no matching
							// profile the target's access can't be checked, so fail closed.
							if (!profile) return null;
							const targetAccess = this.resolveNoteAccess(targetFile, profile);
							if (!targetAccess.ok || !linkVisibleFrom(sourceGroups, targetAccess.groups)) {
								return null;
							}
							return {
								uid,
								title: this.plugin.frontmatterManager.getNoteTitle(targetFile),
								published: true
							};
						}
						return null;
					} catch (error) {
						Logger.error(`Failed to get UID for file ${targetFile.path}:`, error);
						return null;
					}
				}
				return null;
			}
		};

		// The manager merges built-in scaffolds with any vault overrides, sorts by
		// order, and returns a ready unified() processor for this note. Stages are
		// compiled once per publish batch (see Publisher.publishNotes →
		// parserExtensionManager.loadExtensions); this only assembles the chain.
		const processor = await this.plugin.parserExtensionManager.assemblePipeline(profileId, context);
		const result = await processor.process(markdown);
		return result.toString();
	}

	/**
	 * Scrub the published `raw` for a profile. The one helper behind both the
	 * publish (queueNote) and the content-index rebuild, so the index can't drift
	 * from the published `raw`. Two independent per-profile settings (both
	 * default on):
	 *
	 * - **Obscure wikilinks** (`obscureRawWikilinks`): a wikilink's note path is
	 *   replaced by the target note's UID, with the title carried as an inline
	 *   alias — e.g. `[[Some Title]]` → `[[ABCD1234|Some Title]]`.
	 * - **Obscure attachment names** (`obscureRawAttachments`): links to
	 *   non-Markdown vault files, wikilink or inline Markdown, get the file's
	 *   content hash as their target, or `null` when it doesn't publish
	 *   (`![[Media/song.mp3]]` → `![[null.mp3]]`). A file in the note's
	 *   attachment list (`attachments`) gets `<sha256>.<ext>`.
	 *
	 * Returns `raw` unchanged when both are off.
	 *
	 * IMPORTANT — this output is for the published `raw` field and the content
	 * hash ONLY. It must NOT be fed back into {@link markdownToHtml}: the HTML
	 * renderer resolves links by note PATH (getFirstLinkpathDest), so a UID-form
	 * wikilink would fail to resolve and render as an unpublished span. The HTML
	 * `content` is always built from the original (path-form) raw.
	 *
	 * The parse/splice mechanics live in the pure {@link scrubRawWikilinks} core
	 * (unit-testable without Obsidian); this wrapper supplies the lookup.
	 * UID resolution goes through FrontmatterManager.getNoteUID (NOT a fresh
	 * generateUID) so a target lacking a UID is minted exactly once and cached —
	 * the same value the HTML path and the eventual frontmatter write all see.
	 * A wikilink whose target is missing gets the note sentinel `null`, as it
	 * always has; a Markdown link whose target is missing is left as written.
	 */
	async rewriteRawWikilinks(
		raw: string,
		currentFile: TFile,
		profile: PublishingProfile | undefined,
		attachments: readonly AttachmentRef[] = [],
	): Promise<string> {
		const published = new Map(attachments.map(r => [r.vaultPath, r.sha256]));
		const opts = {
			notes: profile?.obscureRawWikilinks ?? true,
			attachments: profile?.obscureRawAttachments ?? true
		};
		if (!opts.notes && !opts.attachments) return raw;
		return scrubRawWikilinks(raw, (linkPath: string): ResolvedTarget => {
			const target = this.plugin.app.metadataCache.getFirstLinkpathDest(linkPath, currentFile.path);
			if (target instanceof TFile) {
				if (target.extension === 'md') {
					return { kind: 'note', uid: this.plugin.frontmatterManager.getNoteUID(target) };
				}
				// Files in the note's attachment list publish under their hash.
				return { kind: 'file', sha256: published.get(target.path) ?? null, ext: target.extension };
			}
			return { kind: 'note', uid: null };
		}, opts);
	}

	/**
	 * Drop notes queued (or blocked) for a profile by an earlier publish that
	 * stopped before committing them, so a later publish can't commit them
	 * under a UID they no longer have.
	 */
	/** The queued notes of a profile with attachments, for the pre-staging re-check (P2 §7, item 1). */
	queuedWithAttachments(profileId: string): Array<{ file: TFile; attachments: AttachmentRef[] }> {
		const prefix = `${profileId}:`;
		return [...this.pendingNotes.entries()]
			.filter(([key, n]) => key.startsWith(prefix) && n.attachments.length > 0)
			.map(([, n]) => ({ file: n.file, attachments: n.attachments }));
	}

	/**
	 * Every queued note of a profile with the files its revision uses (none
	 * for a note without attachments), for the change notice (P4 §1).
	 */
	queuedRefs(profileId: string): PublishedNote[] {
		const prefix = `${profileId}:`;
		return [...this.pendingNotes.entries()]
			.filter(([key]) => key.startsWith(prefix))
			.map(([, n]) => ({
				notePath: n.file.path,
				uid: n.uid,
				refs: n.attachments.map(r => ({ vaultPath: r.vaultPath, sha256: r.sha256 })),
			}));
	}

	discardQueued(profileId: string): void {
		const prefix = `${profileId}:`;
		for (const key of [...this.pendingNotes.keys()]) {
			if (key.startsWith(prefix)) this.pendingNotes.delete(key);
		}
		for (const key of [...this.blockedNotes.keys()]) {
			if (key.startsWith(prefix)) this.blockedNotes.delete(key);
		}
	}

	async queueNote(file: TFile, profileId: string) {
		try {
			// Get raw content and strip frontmatter
			// (grabbing prior to accessing UID since updating the frontmatter
			//  while processing in-flight causes offset issues with below trimming)
			const rawWithFrontmatter = await this.plugin.app.vault.read(file);
			const raw = await this.stripFrontmatter(file, rawWithFrontmatter);

			// grab UID of the note
			const uid = this.plugin.frontmatterManager.getNoteUID(file);
			if (!uid) return;

			// Per-note access groups. A note that can't publish with its groups is
			// skipped AND unpublished from wherever it was (fail closed), rather
			// than left live in the public partition.
			const queueProfile = this.plugin.settings.publishingProfiles.find(p => p.id === profileId);
			const access: NoteAccess = queueProfile
				? this.resolveNoteAccess(file, queueProfile)
				: { groups: [], ok: true };
			const key = `${profileId}:${uid}`;
			if (!access.ok) {
				this.pendingNotes.delete(key);
				this.blockedNotes.set(key, {
					file,
					uid,
					reason: access.reason || 'access groups cannot be honored',
					isHome: !!queueProfile && queueProfile.homeNotePath === file.path,
				});
				return;
			}
			this.blockedNotes.delete(key);

			// The files this revision publishes with, from the metadata cache
			// only (attachment spec P2 §3). Before the scrub and the hash: the
			// obscured raw needs each published file's hash.
			const attachments = await this.plugin.attachmentManager.collect(file, queueProfile);

			// Optionally scrub note paths and attachment paths out of the published
			// raw Markdown (per-profile, both default on). This scrubbed text feeds
			// the content hash and the stored `raw`/content-index — but NOT the
			// HTML render, which must keep the original path-form links to resolve.
			const scrubbedRaw = await this.rewriteRawWikilinks(raw, file, queueProfile, attachments);

			// Calculate current hash over the scrubbed raw so toggling the setting
			// or a target gaining/losing a UID correctly re-publishes the note.
			// The `cpn-style` value is appended only when present, so notes without
			// a style keep their existing hash (no mass re-publish on rollout) while
			// changing/setting a style still re-stages that note.
			const title = this.plugin.frontmatterManager.getNoteTitle(file);
			const style = this.plugin.frontmatterManager.getNoteStyle(file);
			// Access groups likewise join the hash only when present, so an
			// access-only edit is recorded as a new revision.
			const currentHash = await this.getSHA1Hash(
				`${uid}::${title}::${scrubbedRaw}${style ? `::style=${style}` : ''}`
				+ (access.groups.length ? `::access=${access.groups.join(',')}` : '')
				// Attachment keys join only when there are any, so a note pins the
				// exact bytes it was published with (P2 §5).
				+ attachmentHashSegment(attachments)
			);

			// Load publish history to determine prior hash
			const history = await this.loadPublishHistory(profileId);
			const priorHash = this.getMostRecentPriorHash(history, uid, currentHash);

			const noteState: NoteState = {
				file,
				uid,
				currentHash,
				priorHash: priorHash,
				slug: PathUtils.slugifyFilePath(file.path),
				title: title,
				// HTML is rendered from the ORIGINAL raw (path-form wikilinks) so
				// resolveInternalLinks can resolve them; see rewriteRawWikilinks.
				content: await this.markdownToHtml(raw, file, profileId, access.groups, attachments),
				raw: scrubbedRaw,
				lastModified: file.stat.mtime,
				style,
				access: access.groups,
				attachments,
			};

			this.pendingNotes.set(key, noteState);
		} catch (error) {
			Logger.error(`Error queuing note ${file.path}:`, error);
			throw error;
		}
	}

	async commitPendingNotes(profileId: string) {
		try {
			// Process all queued notes for this profile
			const history = await this.loadPublishHistory(profileId);
			const notesToProcess = Array.from(this.pendingNotes.entries())
				.filter(([key]) => key.startsWith(`${profileId}:`));

			for (const [key, noteState] of notesToProcess) {
				// Only update history if hash is different from last recorded
				if (this.shouldAddHashToHistory(history, noteState.uid, noteState.currentHash)) {
					if (!history[noteState.uid]) {
						history[noteState.uid] = [];
					}
					history[noteState.uid].push(noteState.currentHash);
					Logger.debug(`Added hash ${noteState.currentHash} to history for ${noteState.uid}`);
				} else {
					Logger.debug(`Skipped adding duplicate hash ${noteState.currentHash} for ${noteState.uid}`);
				}

				// Record the note's access partitions (before updateMappings, so
				// "was it already live?" reflects the prior publish).
				const wasPublished = this.plugin.mappingManager.getPriorHash(profileId, noteState.uid) !== null;
				this.plugin.accessManager.set(profileId, noteState.uid, noteState.access, wasPublished);
				const gated = noteState.access.length > 0;

				// Update mappings
				this.plugin.mappingManager.updateMappings(
					profileId,
					noteState.slug,
					noteState.uid,
					noteState.currentHash
				);

				// Update content index if enabled
				const commitProfile = this.plugin.settings.publishingProfiles.find(p => p.id === profileId);
				// Gated notes never enter the search index or chat corpus (v1): both
				// are site-wide and readable by every reader.
				if (gated) {
					await this.plugin.contentIndexManager.removeEntry(profileId, noteState.uid);
					await this.plugin.kbCorpusManager.removeEntry(profileId, noteState.uid);
				} else if (commitProfile?.publishContentIndex) {
					Logger.debug(`Queuing contentIndex update for file ${noteState.file.basename} (${noteState.uid}) under profile ${profileId}`);
					await this.plugin.contentIndexManager.queueUpdate(
						profileId,
						noteState.uid,
						noteState.title,
						noteState.raw
					);
				}

				// Stage the per-UID chat corpus artifact when chat is enabled. Reuses
				// the same scrubbed `raw` as the content index so freshness matches.
				if (!gated && commitProfile?.chat?.enabled) {
					Logger.debug(`Queuing KB corpus update for file ${noteState.file.basename} (${noteState.uid}) under profile ${profileId}`);
					await this.plugin.kbCorpusManager.queueUpdate(
						profileId,
						noteState.uid,
						noteState.title,
						noteState.raw
					);
				}

				// Write note JSON to staging directory
				await this.writeNoteToStaging(profileId, noteState);

				// Its attachment refs, and the (area, key) entries it needs uploaded.
				this.plugin.attachmentManager.stageRevision(profileId, noteState.currentHash, noteState.access, noteState.attachments);

				// Remove from pending queue
				this.pendingNotes.delete(key);
			}

			await this.commitBlockedNotes(profileId);

			// Save all changes. attachments.json (refs) is saved beside the
			// history, before anything uploads.
			await this.plugin.attachmentManager.flushStaged(profileId);
			await this.plugin.attachmentManager.saveState(profileId);
			await this.savePublishHistory(profileId);
			await this.plugin.mappingManager.saveMappings();
			await this.plugin.contentIndexManager.applyQueuedUpdates(profileId);
			await this.plugin.kbCorpusManager.applyQueuedUpdates(profileId);
		} catch (error) {
			Logger.error(`Error committing pending notes for profile ${profileId}:`, error);
			// TODO: Handle error state, possibly move failed notes to error staging
			// Success/error Notices are owned by the showProgress wrapper in publishNotes;
			// rethrow so the caller renders the error Notice and runs handlePublishError.
			throw error;
		}
	}

	/**
	 * Unpublish notes skipped for access reasons: drop them from the local
	 * mappings / search index / chat corpus and record a transition so the
	 * uploader deletes their live copies. Notifies the author once per batch.
	 */
	private async commitBlockedNotes(profileId: string): Promise<void> {
		const blocked = [...this.blockedNotes.entries()].filter(([key]) => key.startsWith(`${profileId}:`));
		if (blocked.length === 0) return;
		for (const [key, note] of blocked) {
			const wasPublished = this.plugin.mappingManager.getPriorHash(profileId, note.uid) !== null;
			this.plugin.accessManager.markUnpublished(profileId, note.uid, wasPublished);
			if (note.isHome) this.plugin.accessManager.markHomeRemoved(profileId);
			this.plugin.mappingManager.removeUidFromMappings(profileId, note.uid);
			await this.plugin.contentIndexManager.removeEntry(profileId, note.uid);
			await this.plugin.kbCorpusManager.removeEntry(profileId, note.uid);
			Logger.warn(`Not publishing ${note.file.path}: ${note.reason}`);
			this.blockedNotes.delete(key);
		}
		const names = blocked.map(([, n]) => `• ${n.file.basename}: ${n.reason}`).slice(0, 5).join('\n');
		const more = blocked.length > 5 ? `\n…and ${blocked.length - 5} more (see console)` : '';
		NoticeManager.showNotice(
			`${blocked.length} note(s) with access groups were not published (and removed from the site if they were live):\n${names}${more}`,
			15000,
		);
	}

	private async writeNoteToStaging(profileId: string, noteState: NoteState) {
		// Ensure directory exists before writing
		const stagedNotesDir = this.plugin.profileManager.getStagedNotesDir(profileId);
		await PathUtils.ensureDirectory(this.plugin, stagedNotesDir);

		// Backlinks carry each source note's access groups so every partition copy
		// lists only backlinks visible inside that partition.
		const allBacklinks = await this.getBacklinks(noteState.file, profileId);
		const gated = noteState.access.length > 0;

		for (const partition of partitionsFor(noteState.access)) {
			const backlinks = allBacklinks
				.filter(b => visibleInPartition(partition, b.access))
				.map(({ uid, slug, title }) => ({ uid, slug, title }));

			const noteJson: Record<string, unknown> = {
				uid: noteState.uid,
				slug: noteState.slug,
				title: noteState.title,
				content: noteState.content,
				raw: noteState.raw,
				backlinks,
				hash: noteState.currentHash,
				priorHash: noteState.priorHash,
				lastUpdated: noteState.lastModified,
				style: noteState.style
			};
			// Tells the SPA to show a lock badge and skip comments. Deliberately a
			// boolean, not the group list, so members of one group don't learn the
			// names of the note's other groups.
			if (gated) noteJson.gated = true;
			// Same in every area copy, keys relative to the area (P2 §5).
			const attachmentList = noteJsonAttachments(noteState.attachments);
			if (attachmentList) noteJson.attachments = attachmentList;

			const dir = partition === null
				? stagedNotesDir
				: this.plugin.profileManager.getStagedRestrictedDir(profileId, partition);
			if (partition !== null) await PathUtils.ensureDirectory(this.plugin, dir);
			await this.plugin.app.vault.adapter.write(
				`${dir}/${noteState.currentHash}.json`,
				JSON.stringify(noteJson)
			);

			// If this is the home page for the profile, also write as index.json
			// (public partition only; a gated home note is blocked in queueNote).
			const profile = this.plugin.settings.publishingProfiles.find(p => p.id === profileId);
			if (partition === null && profile && profile.homeNotePath === noteState.file.path) {
				await this.plugin.app.vault.adapter.write(
					`${stagedNotesDir}/index.json`,
					JSON.stringify(noteJson)
				);
			}
		}
	}
}
