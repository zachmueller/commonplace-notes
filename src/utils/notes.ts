import { Notice, TFile } from 'obsidian';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import CommonplaceNotesPlugin from '../main';
import { PathUtils } from './path';
import remarkObsidianLinks, { ResolvedNoteInfo } from './remarkObsidianLinks';
import { Logger } from './logging';

interface NoteState {
	file: TFile;
	uid: string;
	currentHash: string;
	priorHash: string | null;
	slug: string;
	title: string;
	content: string;  // HTML content
	raw: string;      // Raw Markdown content
	lastModified: number;
}

interface BacklinkInfo {
	uid: string;
	slug: string;
	title: string;
}

export class NoteManager {
	private pendingNotes: Map<string, NoteState>;
	private plugin: CommonplaceNotesPlugin;

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
		this.pendingNotes = new Map();
	}

    async getSHA1Hash(content: string): Promise<string> {
        const msgUint8 = new TextEncoder().encode(content);
        const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

	private async stripFrontmatter(file: TFile, content: string): Promise<string> {
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
            .use(remarkObsidianLinks, {
                frontmatterManager: this.plugin.frontmatterManager,
                resolveInternalLinks: async (linkText: string): Promise<ResolvedNoteInfo | null> => {
                    const [link, alias] = linkText.split('|');
                    const targetFile = this.plugin.app.metadataCache.getFirstLinkpathDest(link, currentFile.path);

                    if (targetFile instanceof TFile && targetFile.extension === 'md') {
                        try {
                            const uid = await this.plugin.frontmatterManager.getNoteUID(targetFile);
                            if (uid === null) return null;
                            const contexts = await this.plugin.publisher.getPublishContextsForFile(targetFile);

                            if (contexts.includes(profileId)) {
                                return {
                                    uid,
                                    title: targetFile.basename,
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
            const uid = await this.plugin.frontmatterManager.getNoteUID(file);
            if (!uid) return;

            // Get raw content and strip frontmatter
            const rawWithFrontmatter = await this.plugin.app.vault.read(file);
            const raw = await this.stripFrontmatter(file, rawWithFrontmatter);

            // Convert to HTML
            const content = await this.markdownToHtml(raw, file, profileId);

            // Calculate hash using raw content
            const currentHash = await this.getSHA1Hash(`${uid}::${raw}`);
            const priorHash = this.plugin.frontmatterManager.getFrontmatterValue(file, 'cpn-prior-hash');

            // Update prior hash in frontmatter if needed
            if (!priorHash || priorHash !== currentHash) {
                await this.plugin.frontmatterManager.add(file, {'cpn-prior-hash': currentHash});
                await this.plugin.frontmatterManager.process();
            }

            const noteState: NoteState = {
                file,
                uid,
                currentHash,
                priorHash: (priorHash === currentHash) ? null : priorHash,
                slug: PathUtils.slugifyFilePath(file.path),
                title: file.basename,
                content,
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
			const notesToProcess = Array.from(this.pendingNotes.entries())
				.filter(([key]) => key.startsWith(`${profileId}:`));

			for (const [key, noteState] of notesToProcess) {
				// Update mappings
				this.plugin.mappingManager.updateMappings(
					profileId,
					noteState.slug,
					noteState.uid,
					noteState.currentHash
				);

				// Update content index if enabled
				if (this.plugin.settings.publishingProfiles.find(p => p.id === profileId)?.publishContentIndex) {
					await this.plugin.contentIndexManager.queueUpdate(
						profileId,
						noteState.file,
						noteState.uid
					);
				}

				// Write note JSON to staged directory
				await this.writeNoteToStaging(profileId, noteState);

				// Remove from pending queue
				this.pendingNotes.delete(key);
			}

			// Commit all changes
			await this.plugin.mappingManager.saveMappings();
			await this.plugin.contentIndexManager.applyQueuedUpdates(profileId);
			new Notice(`Notes successfully committed for profile ${profileId}`);
		} catch (error) {
			Logger.error(`Error committing pending notes for profile ${profileId}:`, error);
			// TODO: Handle error state, possibly move failed notes to error staging
			new Notice(`Error committing notes: ${error.message}`);
			throw error;
		}
	}

	private async writeNoteToStaging(profileId: string, noteState: NoteState) {
		const stagedNotesDir = this.plugin.profileManager.getStagedNotesDir(profileId);
		
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