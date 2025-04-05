import { TFile } from 'obsidian';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import CommonplaceNotesPlugin from '../main';
import { PathUtils } from './path';
import remarkObsidianLinks, { ResolvedNoteInfo } from './remarkObsidianLinks';
import remarkLineNumbers from './remarkLineNumbers';
import { Logger } from './logging';

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
}

interface BacklinkInfo {
	uid: string;
	slug: string;
	title: string;
}

export class NoteManager {
	private pendingNotes: Map<string, NoteState>;
	private publishHistory: Map<string, Record<string, string[]>>;
	private plugin: CommonplaceNotesPlugin;

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
		this.pendingNotes = new Map();
		this.publishHistory = new Map();
	}

	private async loadPublishHistory(profileId: string): Promise<Record<string, string[]>> {
		if (this.publishHistory.has(profileId)) {
			return this.publishHistory.get(profileId)!;
		}

		const historyPath = this.plugin.profileManager.getPublishHistoryPath(profileId);
		try {
			const content = await this.plugin.app.vault.adapter.read(historyPath);
			const history = JSON.parse(content);
			this.publishHistory.set(profileId, history);
			return history;
		} catch (e) {
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

		// Filter to only include backlinks
		return connections
			.filter(connection => connection.isBacklink)
			.map(connection => ({
				uid: connection.uid,
				slug: connection.slug,
				title: connection.title
			}));
	}

	async markdownToHtml(markdown: string, currentFile: TFile, profileId: string): Promise<string> {
		const processor = unified()
			.use(remarkParse)
			.use(remarkLineNumbers)
			.use(remarkObsidianLinks, {
				frontmatterManager: this.plugin.frontmatterManager,
				resolveInternalLinks: async (linkText: string): Promise<ResolvedNoteInfo | null> => {
					const [link, alias] = linkText.split('|');
					const targetFile = this.plugin.app.metadataCache.getFirstLinkpathDest(link, currentFile.path);

					if (targetFile instanceof TFile && targetFile.extension === 'md') {
						try {
							const uid = this.plugin.frontmatterManager.getNoteUID(targetFile);
							if (uid === null) return null;
							const contexts = await this.plugin.publisher.getPublishContextsForFile(targetFile);

							if (contexts.includes(profileId)) {
								return {
									uid,
									title: this.plugin.frontmatterManager.getNoteTitle(targetFile),
									displayText: alias || link,
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
			})
			.use(remarkRehype, { allowDangerousHtml: true })
			.use(rehypeStringify, { allowDangerousHtml: true });

		const result = await processor.process(markdown);
		return result.toString();
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

			// Calculate current hash
			const title = this.plugin.frontmatterManager.getNoteTitle(file);
			const currentHash = await this.getSHA1Hash(`${uid}::${title}::${raw}`);

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
				content: await this.markdownToHtml(raw, file, profileId),
				raw,
				lastModified: file.stat.mtime
			};

			const key = `${profileId}:${uid}`;
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

				// Update mappings
				this.plugin.mappingManager.updateMappings(
					profileId,
					noteState.slug,
					noteState.uid,
					noteState.currentHash
				);

				// Update content index if enabled
				if (this.plugin.settings.publishingProfiles.find(p => p.id === profileId)?.publishContentIndex) {
					Logger.debug(`Queuing contentIndex update for file ${noteState.file.basename} (${noteState.uid}) under profile ${profileId}`);
					await this.plugin.contentIndexManager.queueUpdate(
						profileId,
						noteState.uid,
						noteState.title,
						noteState.raw
					);
				}

				// Write note JSON to staging directory
				await this.writeNoteToStaging(profileId, noteState);

				// Remove from pending queue
				this.pendingNotes.delete(key);
			}

			// Save all changes
			await this.savePublishHistory(profileId);
			await this.plugin.mappingManager.saveMappings();
			await this.plugin.contentIndexManager.applyQueuedUpdates(profileId);

			NoticeManager.showNotice(`Notes successfully committed for profile ${profileId}`);
		} catch (error) {
			Logger.error(`Error committing pending notes for profile ${profileId}:`, error);
			// TODO: Handle error state, possibly move failed notes to error staging
			NoticeManager.showNotice(`Error committing notes: ${error.message}`);
			throw error;
		}
	}

	private async writeNoteToStaging(profileId: string, noteState: NoteState) {
		// Ensure directory exists before writing
		const stagedNotesDir = this.plugin.profileManager.getStagedNotesDir(profileId);
		await PathUtils.ensureDirectory(this.plugin, stagedNotesDir);
		
		// Get backlinks
		const backlinks = await this.getBacklinks(noteState.file, profileId);

		// Prepare note JSON
		const noteJson = {
			uid: noteState.uid,
			slug: noteState.slug,
			title: noteState.title,
			content: noteState.content,
			raw: noteState.raw,
			backlinks,
			hash: noteState.currentHash,
			priorHash: noteState.priorHash,
			lastUpdated: noteState.lastModified
		};

		// Write to staging directory
		const outputPath = `${stagedNotesDir}/${noteState.currentHash}.json`;
		await this.plugin.app.vault.adapter.write(
			outputPath,
			JSON.stringify(noteJson)
		);

		// If this is the home page for the profile, also write as index.json
		const profile = this.plugin.settings.publishingProfiles.find(p => p.id === profileId);
		if (profile && profile.homeNotePath === noteState.file.path) {
			const indexPath = `${stagedNotesDir}/index.json`;
			await this.plugin.app.vault.adapter.write(
				indexPath,
				JSON.stringify(noteJson)
			);
		}
	}
}