import { TFile, App } from 'obsidian';
import { generateUID } from './uid';
import CommonplaceNotesPlugin from '../main';
import { Logger } from './logging';
import { NoticeManager } from '../utils/notice';

export class FrontmatterManager {
    private queue: Map<string, Record<string, any>> = new Map();
    private app: App;
	private cachedUIDs: Map<string, string> = new Map();
	private misconfiguredContexts: Set<string> = new Set();
	private lastNoticeTime: number = 0;
	private readonly NOTICE_COOLDOWN = 30000; // 30 seconds

    constructor(app: App) {
        this.app = app;
    }

	getFrontmatter(file: TFile): any {
		const fileCache = this.app.metadataCache.getCache(file.path);
		return fileCache?.frontmatter;
	}

	getFrontmatterValue(file: TFile, key: string): any {
		const fm = this.getFrontmatter(file);
		return fm ? fm[key] : null;
	}

	hasFrontmatter(file: TFile): boolean {
		return this.getFrontmatter(file) !== undefined;
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
			return rawContexts;
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

	getNoteUID(file: TFile): string|null {
		try {
			// First check if there's already a cached UID. This helps handle cases
			// for new notes without UIDs to have a single UID generated when the
			// same note is referenced multiple times in a single publish
            const cachedUID = this.cachedUIDs.get(file.path);
            if (cachedUID) {
                Logger.debug(`Using cached UID for ${file.basename}: ${cachedUID}`);
                return cachedUID;
            }

			// Check if there's any frontmatter at all
			if (!this.hasFrontmatter(file)) {
				return null;
			}

			const existingUID = this.getFrontmatterValue(file, 'cpn-uid');
			if (existingUID) {
				return existingUID;
			}

			// Only add new UID if cpn-publish-contexts contains a value
			const publishContexts = this.normalizePublishContexts(file);
			if (publishContexts.length > 0) {
				const newUID = generateUID();
				this.add(file, {"cpn-uid": newUID});
				this.cachedUIDs.set(file.path, newUID);
				Logger.debug(`Queuing frontmatter update to add UID ${newUID} to ${file.basename}`);
				return newUID;
			}

			return null;
		} catch (error) {
			console.error('Error getting or setting note UID:', error);
			throw error;
		}
	}

	getNoteTitle(file: TFile): string {
		try {
			const title = this.getFrontmatterValue(file, 'cpn-title') || file.basename;
			return title;
		} catch (error) {
			console.error('Error getting note title:', error);
			throw error;
		}
	}

    add(file: TFile, updates: Record<string, any>) {
        const path = file.path;
        if (!this.queue.has(path)) {
            this.queue.set(path, {});
        }
        const fileUpdates = this.queue.get(path)!;
        Object.assign(fileUpdates, updates);
    }

    async process() {
        for (const [path, updates] of this.queue) {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                Logger.debug(`Commit frontmatter edits to ${file.basename}: ${JSON.stringify(updates)}`);
				await this.updateFrontmatter(file, updates);
            }
        }
        this.queue.clear();
		this.cachedUIDs.clear();
		Logger.debug('Frontmatter queue and cachedUIDs cleared after processing frontmatter');
    }

	async updateFrontmatter(file: TFile, updates: Record<string, any>) {
		return new Promise<void>((resolve, reject) => {
			try {
				this.app.fileManager.processFrontMatter(file, (frontmatter) => {
					Object.entries(updates).forEach(([key, value]) => {
						if (value === undefined) {
							delete frontmatter[key];
						} else {
							frontmatter[key] = value;
						}
					});
					resolve();
				});
			} catch (error) {
				reject(error);
			}
		});
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
		this.cachedUIDs.clear();
	}
}