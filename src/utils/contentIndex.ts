import { TFile } from 'obsidian';
import { PathUtils } from './path';
import CommonplaceNotesPlugin from '../main';
import { convertMarkdownToPlaintext } from './formatting';

interface ContentEntry {
	title: string;
	content: string;
}

interface ContentIndex {
	[uid: string]: ContentEntry;
}

export class ContentIndexManager {
	private plugin: CommonplaceNotesPlugin;
	private contentDir: string;
	private pendingUpdates: Map<string, Map<string, ContentEntry>>;
	private loadedIndices: Map<string, ContentIndex>;

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
		this.contentDir = `${plugin.manifest.dir}/content`;
		this.pendingUpdates = new Map();
		this.loadedIndices = new Map();
	}

	private getProfileContentDir(profileId: string): string {
		return `${this.contentDir}/${profileId}`;
	}

	private getIndexPath(profileId: string): string {
		return `${this.getProfileContentDir(profileId)}/contentIndex.json`;
	}

	async loadIndex(profileId: string): Promise<ContentIndex> {
		if (this.loadedIndices.has(profileId)) {
			return this.loadedIndices.get(profileId)!;
		}

		const indexPath = this.getIndexPath(profileId);
		try {
			await PathUtils.ensureDirectory(this.plugin, this.getProfileContentDir(profileId));
			const content = await this.plugin.app.vault.adapter.read(indexPath);
			const index = JSON.parse(content);
			this.loadedIndices.set(profileId, index);
			return index;
		} catch (e) {
			// Initialize empty index if file doesn't exist
			const emptyIndex = {};
			this.loadedIndices.set(profileId, emptyIndex);
			return emptyIndex;
		}
	}

	async queueUpdate(profileId: string, file: TFile, uid: string) {
		try {
			// Get plaintext content
			let content;
			try {
				content = await convertMarkdownToPlaintext(file);
			} catch (conversionError) {
				console.warn(`Failed to convert content for ${file.path}, using fallback:`, conversionError);
				content = file.basename; // Fallback to just using the title
			}
			
			// Create entry
			const entry: ContentEntry = {
				title: file.basename,
				content: content
			};

			// Queue the update
			if (!this.pendingUpdates.has(profileId)) {
				this.pendingUpdates.set(profileId, new Map());
			}
			this.pendingUpdates.get(profileId)!.set(uid, entry);
		} catch (error) {
			// Log the error but don't throw it - allow the process to continue
			console.error(`Error queuing content update for ${file.path}:`, error);
			// Add a minimal entry so we don't completely skip this file
			const fallbackEntry: ContentEntry = {
				title: file.basename,
				content: file.basename
			};
			if (!this.pendingUpdates.has(profileId)) {
				this.pendingUpdates.set(profileId, new Map());
			}
			this.pendingUpdates.get(profileId)!.set(uid, fallbackEntry);
		}
	}

	async applyQueuedUpdates(profileId: string): Promise<void> {
		try {
			const index = await this.loadIndex(profileId);
			const updates = this.pendingUpdates.get(profileId);
			
			if (!updates) return;

			// Apply all queued updates
			for (const [uid, entry] of updates) {
				index[uid] = entry;
			}

			// Save the updated index
			await this.saveIndex(profileId, index);

			// Clear the queue for this profile
			this.pendingUpdates.delete(profileId);
		} catch (error) {
			console.error(`Error applying queued updates for profile ${profileId}:`, error);
			throw error;
		}
	}

	private async saveIndex(profileId: string, index: ContentIndex): Promise<void> {
		const indexPath = this.getIndexPath(profileId);
		await this.plugin.app.vault.adapter.write(
			indexPath,
			JSON.stringify(index)
		);
		this.loadedIndices.set(profileId, index);
	}

	getContentIndexPath(profileId: string): string {
		return this.getIndexPath(profileId);
	}
}