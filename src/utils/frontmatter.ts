import { TFile, App } from 'obsidian';
import { generateUID } from './uid';
import CommonplaceNotesPublisherPlugin from '../main';

export class FrontmatterManager {
    private queue: Map<string, Record<string, any>> = new Map();
    private app: App;

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

	async getNoteUID(file: TFile): Promise<string> {
		try {
			const existingUID = this.getFrontmatterValue(file, 'cpn-uid');
			if (!existingUID) {
				const newUID = generateUID();
				this.add(file, {"cpn-uid": newUID});
				await this.process();
				return newUID;
			}
			return existingUID;
		} catch (error) {
			console.error('Error getting or setting note UID:', error);
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
                await this.updateFrontmatter(file, updates);
            }
        }
        this.queue.clear();
    }

	private async updateFrontmatter(file: TFile, updates: Record<string, any>) {
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