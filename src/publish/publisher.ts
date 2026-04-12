import { TFile, SuggestModal, App } from 'obsidian';
import CommonplaceNotesPlugin from '../main';
import { PublishingProfile, NoteConnection, CloudFrontInvalidationScheme } from '../types';
import { pushLocalJsonsToS3, deleteNoteHashesFromS3, pushMappingAndIndexToS3, createCloudFrontInvalidation } from './awsUpload';
import { publishLocalNotes } from './local';
import { PathUtils } from '../utils/path';
import { Logger } from '../utils/logging';
import { NoticeManager } from '../utils/notice';

class ProfileSuggestModal extends SuggestModal<PublishingProfile> {
	profiles: PublishingProfile[];
	onChoose: (profile: PublishingProfile) => void;

	constructor(app: App, profiles: PublishingProfile[], onChoose: (profile: PublishingProfile) => void) {
		super(app);
		this.profiles = profiles;
		this.onChoose = onChoose;
	}

	getSuggestions(query: string): PublishingProfile[] {
		return this.profiles.filter(profile => 
			profile.name.toLowerCase().includes(query.toLowerCase())
		);
	}

	renderSuggestion(profile: PublishingProfile, el: HTMLElement) {
		el.createEl("div", { text: profile.name });
	}

	onChooseSuggestion(profile: PublishingProfile, evt: MouseEvent | KeyboardEvent) {
		this.onChoose(profile);
	}
}

interface NoteEntry {
	slug: string;
	uid: string;
}

class NoteSuggestModal extends SuggestModal<NoteEntry> {
	entries: NoteEntry[];
	onChoose: (entry: NoteEntry) => void;

	constructor(app: App, slugToUid: Record<string, string>, onChoose: (entry: NoteEntry) => void) {
		super(app);
		this.entries = Object.entries(slugToUid).map(([slug, uid]) => ({ slug, uid }));
		this.onChoose = onChoose;
		this.setPlaceholder('Search for a published note to delete...');
	}

	getSuggestions(query: string): NoteEntry[] {
		return this.entries.filter(entry =>
			entry.slug.toLowerCase().includes(query.toLowerCase())
		);
	}

	renderSuggestion(entry: NoteEntry, el: HTMLElement) {
		el.createEl("div", { text: entry.slug });
		el.createEl("small", { text: entry.uid, cls: 'suggestion-note' });
	}

	onChooseSuggestion(entry: NoteEntry, evt: MouseEvent | KeyboardEvent) {
		this.onChoose(entry);
	}
}

class ConfirmSuggestModal extends SuggestModal<string> {
	options: string[];
	onChoose: (choice: string) => void;

	constructor(app: App, slug: string, onChoose: (choice: string) => void) {
		super(app);
		this.options = ['No', 'Yes'];
		this.onChoose = onChoose;
		this.setPlaceholder(`Type 'yes' to confirm deletion of: ${slug}`);
	}

	getSuggestions(query: string): string[] {
		return this.options.filter(opt =>
			opt.toLowerCase().includes(query.toLowerCase())
		);
	}

	renderSuggestion(option: string, el: HTMLElement) {
		el.createEl("div", { text: option });
	}

	onChooseSuggestion(option: string, evt: MouseEvent | KeyboardEvent) {
		this.onChoose(option);
	}
}

export class Publisher {
	private plugin: CommonplaceNotesPlugin;

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
	}

	async getPublishContextsForFile(file: TFile): Promise<string[]> {
		return this.plugin.frontmatterManager.normalizePublishContexts(file);
	}

	async promptForProfile(availableProfiles?: string[]): Promise<PublishingProfile | null> {
		// default to grabbing all profiles in plugin settings
		if (!availableProfiles) {
			availableProfiles = this.plugin.settings.publishingProfiles.map(p => p.id);
		}
		
		return new Promise((resolve) => {
			const profiles = this.plugin.settings.publishingProfiles.filter(
				p => availableProfiles.includes(p.id)
			);

			if (profiles.length === 0) {
				NoticeManager.showNotice('No valid publishing profiles available');
				resolve(null);
				return;
			}

			if (profiles.length === 1) {
				resolve(profiles[0]);
				return;
			}

			new ProfileSuggestModal(this.plugin.app, profiles, (profile) => {
				resolve(profile);
			}).open();
		});
	}

	public isFileExcluded(file: TFile, profile: PublishingProfile): boolean {
		const filePath = file.path;
		return profile.excludedDirectories.some(dir => 
			filePath.startsWith(dir) || filePath.includes('/' + dir + '/')
		);
	}

	// TODO::extend this to allow for no filtering by profileId::
	async getConnectedNotes(file: TFile, profileId: string): Promise<NoteConnection[]> {
		const resolvedLinks = this.plugin.app.metadataCache.resolvedLinks;
		const connections = new Map<string, NoteConnection>();
		const profile = this.plugin.settings.publishingProfiles.find(p => p.id === profileId);

		if (!profile) {
			Logger.error(`No profile found with id ${profileId}`);
			return [];
		}

		// Process outgoing links
		const outgoing = resolvedLinks[file.path] || {};
		for (const path of Object.keys(outgoing)) {
			const connectedFile = this.plugin.app.vault.getAbstractFileByPath(path);
			if (connectedFile instanceof TFile && !this.isFileExcluded(connectedFile, profile)) {
				const contexts = await this.getPublishContextsForFile(connectedFile);
				if (contexts.includes(profileId)) {
					const uid = this.plugin.frontmatterManager.getNoteUID(connectedFile);
					if (uid === null) continue;
					connections.set(path, {
						file: connectedFile,
						isBacklink: false,
						isOutgoingLink: true,
						uid,
						slug: PathUtils.slugifyFilePath(connectedFile.path),
						title: this.plugin.frontmatterManager.getNoteTitle(connectedFile)
					});
				}
			}
		}

		// Process incoming links (backlinks)
		for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
			if (links[file.path]) {
				const connectedFile = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
				if (connectedFile instanceof TFile && !this.isFileExcluded(connectedFile, profile)) {
					const contexts = await this.getPublishContextsForFile(connectedFile);
					if (contexts.includes(profileId)) {
						const uid = this.plugin.frontmatterManager.getNoteUID(connectedFile);
						if (uid === null) continue;
						if (connections.has(sourcePath)) {
							// Update existing connection to mark it as both incoming and outgoing
							connections.get(sourcePath)!.isBacklink = true;
						} else {
							connections.set(sourcePath, {
								file: connectedFile,
								isBacklink: true,
								isOutgoingLink: false,
								uid,
								slug: PathUtils.slugifyFilePath(connectedFile.path),
								title: this.plugin.frontmatterManager.getNoteTitle(connectedFile)
							});
						}
					}
				}
			}
		}

		return Array.from(connections.values());
	}

	async publishNotes(
		files: TFile[],
		profile: PublishingProfile,
		updatePublishTimestamp: boolean = false,
		triggerCloudFrontInvalidation: boolean = false
	) {
		try {
			await NoticeManager.showProgress(
				`Processing ${files.length} notes`,
				(async () => {
					// Ensure all required directories exist before processing
					await this.plugin.profileManager.initializeProfileDirectories(profile.id);

					// Load existing mappings and content index for profile
					await this.plugin.mappingManager.loadProfileMappings(profile.id);
					await this.plugin.contentIndexManager.loadIndex(profile.id);

					// Queue all notes for processing
					for (const file of files) {
						await this.plugin.noteManager.queueNote(file, profile.id);
					}

					Logger.debug(`${files.length} notes processed`);
				})(),
				`${files.length} notes processed`
			);

			// Commit any pending frontmatter updates
			if (this.plugin.frontmatterManager.hasUpdates()) {
				Logger.debug(`Processing frontmatter updates`);
				await this.plugin.frontmatterManager.process();
			}

			// Commit all queued notes to staging
			await this.plugin.noteManager.commitPendingNotes(profile.id);

			// Upload to destination
			let uploadSuccess = false;
			if (profile.publishMechanism === 'AWS CLI') {
				uploadSuccess = await pushLocalJsonsToS3(this.plugin, profile.id, triggerCloudFrontInvalidation);
			} else if (profile.publishMechanism === 'Local') {
				uploadSuccess = await publishLocalNotes(this.plugin, profile.id);
			}

			// TODO::instead should prompt user whether to delete local copies of processed notes::
			// (for now just stopping here to not delete anything)
			if (!uploadSuccess) {
				NoticeManager.showNotice('Publishing failed. Staged files preserved for retry.');
				return;
			}

			// Clean up staged files
			await this.cleanupStagedFiles(profile.id);

			// Update timestamp for full publishes
			if (updatePublishTimestamp) {
				const profileIndex = this.plugin.settings.publishingProfiles
					.findIndex(p => p.id === profile.id);
				if (profileIndex !== -1) {
					this.plugin.settings.publishingProfiles[profileIndex]
						.lastFullPublishTimestamp = Date.now();
					await this.plugin.saveSettings();
				}
			}

			NoticeManager.showNotice(`Successfully published ${files.length} note(s)`);
		} catch (error) {
			NoticeManager.showNotice(`Error during publishing: ${error.message}`);
			Logger.error('Publishing error:', error);

			// Move staged files to error directory
			await this.handlePublishError(profile.id, error);
		}
	}

	private async cleanupStagedFiles(profileId: string) {
		const stagedDir = this.plugin.profileManager.getStagedNotesDir(profileId);
		await new PathUtils().deleteFilesInDirectory(this.plugin, stagedDir);
	}

	private async handlePublishError(profileId: string, error: Error) {
		const stagedDir = this.plugin.profileManager.getStagedNotesDir(profileId);
		const errorDir = this.plugin.profileManager.getStagedErrorDir(profileId);

		// Create timestamp for error session
		const errorTimestamp = Date.now();
		const errorSessionDir = `${errorDir}/${errorTimestamp}`;

		try {
			// Ensure error session directory exists
			await PathUtils.ensureDirectory(this.plugin, errorSessionDir);

			// Move staged files to error directory
			const stagedFiles = await this.plugin.app.vault.adapter.list(stagedDir);
			for (const file of stagedFiles.files) {
				const fileName = file.split('/').pop();
				await this.plugin.app.vault.adapter.copy(
					file,
					`${errorSessionDir}/${fileName}`
				);
			}

			// Write error details
			await this.plugin.app.vault.adapter.write(
				`${errorSessionDir}/error.json`,
				JSON.stringify({
					timestamp: errorTimestamp,
					error: error.message,
					stack: error.stack
				})
			);

			// Clean up staged directory
			await this.cleanupStagedFiles(profileId);

			NoticeManager.showNotice(`Publish failed. Error details saved to ${errorSessionDir}`);
		} catch (moveError) {
			Logger.error('Error handling publish failure:', moveError);
			NoticeManager.showNotice('Failed to save error details. Check console for more information.');
		}
	}

	async getAllPublishableNotes(profileId: string): Promise<TFile[]> {
		const files: TFile[] = [];
		const profile = this.plugin.settings.publishingProfiles.find(p => p.id === profileId);

		if (!profile) {
			Logger.error(`No profile found with id ${profileId}`);
			return files;
		}

		const allFiles = this.plugin.app.vault.getMarkdownFiles();
		for (const file of allFiles) {
			if (file.extension === 'md' && !this.isFileExcluded(file, profile)) {
				const contexts = await this.getPublishContextsForFile(file);
				if (contexts.includes(profileId)) {
					files.push(file);
				}
			}
		}

		return files;
	}

	async getUpdatedNotes(profileId: string): Promise<TFile[]> {
		const profile = this.plugin.settings.publishingProfiles.find(p => p.id === profileId);
		if (!profile) return [];

		const allPublishable = await this.getAllPublishableNotes(profileId);
		return allPublishable.filter(file => 
			file.stat.mtime > (profile.lastFullPublishTimestamp || 0)
		);
	}

	private shouldInvalidateCloudFront(profile: PublishingProfile, publishType: CloudFrontInvalidationScheme): boolean {
		if (!profile.awsSettings?.cloudFrontDistributionId) return false;
		if (profile.awsSettings.cloudFrontInvalidationScheme === 'manual') return false;
		
		// Define hierarchy of publish types
		const hierarchyLevels = {
			'individual': 1,
			'connected': 2,
			'sinceLast': 3,
			'all': 4,
			'manual': 5,
		};

		// Get the level of the current publish type
		const currentLevel = hierarchyLevels[publishType];
		
		// Get the level set in the profile settings
		const configuredLevel = hierarchyLevels[profile.awsSettings.cloudFrontInvalidationScheme];

		// Return true if the current publish level is at or above the configured level
		return currentLevel >= configuredLevel;
	}

	async publishSingle(file: TFile) {
		const contexts = await this.getPublishContextsForFile(file);
		if (contexts.length === 0) {
			NoticeManager.showNotice('No publishing contexts defined for this note');
			return;
		}

		const profile = await this.promptForProfile(contexts);
		if (!profile) return;

		if (this.isFileExcluded(file, profile)) {
			Logger.debug(`Note ${file.path} is in an excluded directory and cannot be published`);
			return;
		}

		const triggerInvalidation = this.shouldInvalidateCloudFront(profile, 'individual');
		await this.publishNotes([file], profile, false, triggerInvalidation);
	}

	async publishConnected(file: TFile) {
		const contexts = await this.getPublishContextsForFile(file);
		if (contexts.length === 0) {
			NoticeManager.showNotice('No publishing contexts defined for this note');
			return;
		}

		const profile = await this.promptForProfile(contexts);
		if (!profile) return;

		if (this.isFileExcluded(file, profile)) {
			NoticeManager.showNotice('This note is in an excluded directory and cannot be published');
			return;
		}

		const connections = await this.getConnectedNotes(file, profile.id);
		const connectedFiles = connections.map(conn => conn.file);
		connectedFiles.push(file); // Include the active note

		const triggerInvalidation = this.shouldInvalidateCloudFront(profile, 'connected');
		await this.publishNotes(connectedFiles, profile, false, triggerInvalidation);
	}

	async publishUpdates() {
		const profile = await this.promptForProfile();
		if (!profile) return;

		const updatedNotes = await this.getUpdatedNotes(profile.id);
		if (updatedNotes.length === 0) {
			NoticeManager.showNotice('No updates found since last full publish');
			return;
		}

		const triggerInvalidation = this.shouldInvalidateCloudFront(profile, 'sinceLast');
		await this.publishNotes(updatedNotes, profile, true, triggerInvalidation);
	}

	async publishAll() {
		const profile = await this.promptForProfile();
		if (!profile) return;

		const allNotes = await this.getAllPublishableNotes(profile.id);
		if (allNotes.length === 0) {
			NoticeManager.showNotice('No publishable notes found for this profile');
			return;
		}

		const triggerInvalidation = this.shouldInvalidateCloudFront(profile, 'all');
		await this.publishNotes(allNotes, profile, true, triggerInvalidation);
	}

	async deletePublishedNote() {
		// Step 1: Select profile
		const profile = await this.promptForProfile();
		if (!profile) return;

		if (profile.publishMechanism !== 'AWS CLI' || !profile.awsSettings) {
			NoticeManager.showNotice('Delete is only supported for AWS CLI publishing profiles');
			return;
		}

		// Step 2: Load mappings and present note selection
		await this.plugin.mappingManager.loadProfileMappings(profile.id);
		const slugToUid = this.plugin.mappingManager.getSlugToUidMap(profile.id);

		if (Object.keys(slugToUid).length === 0) {
			NoticeManager.showNotice('No published notes found for this profile');
			return;
		}

		const selectedNote = await new Promise<NoteEntry | null>((resolve) => {
			new NoteSuggestModal(this.plugin.app, slugToUid, (entry) => {
				resolve(entry);
			}).open();
		});
		if (!selectedNote) return;

		// Step 3: Confirmation
		const confirmed = await new Promise<boolean>((resolve) => {
			new ConfirmSuggestModal(this.plugin.app, selectedNote.slug, (choice) => {
				resolve(choice === 'Yes');
			}).open();
		});
		if (!confirmed) {
			NoticeManager.showNotice('Deletion cancelled');
			return;
		}

		try {
			// Step 4: Collect all hashes to delete
			const history = await this.plugin.noteManager.loadPublishHistory(profile.id);
			const hashSet = new Set<string>();

			// Add all historical hashes
			const historyHashes = history[selectedNote.uid] || [];
			for (const h of historyHashes) {
				hashSet.add(h);
			}

			// Add current hash from uid-to-hash mapping (in case it diverges from history)
			const currentHash = this.plugin.mappingManager.getPriorHash(profile.id, selectedNote.uid);
			if (currentHash) {
				hashSet.add(currentHash);
			}

			if (hashSet.size === 0) {
				Logger.warn(`No hashes found for UID ${selectedNote.uid}, skipping S3 deletes`);
			} else {
				// Step 5: Delete from S3 (stop on permission error)
				const deleteSuccess = await NoticeManager.showProgress(
					`Deleting ${hashSet.size} note version(s) from S3`,
					deleteNoteHashesFromS3(this.plugin, profile.id, [...hashSet]),
					`Note versions deleted from S3`,
					`Failed to delete note versions from S3`
				);

				if (!deleteSuccess.success || !deleteSuccess.result) {
					// Permission error or failure — stop without modifying local files
					return;
				}
			}

			// Step 6: Update local mapping files (keep publish-history.json intact)
			this.plugin.mappingManager.removeUidFromMappings(profile.id, selectedNote.uid);
			await this.plugin.mappingManager.saveMappings();

			// Step 7: Update content index
			await this.plugin.contentIndexManager.removeEntry(profile.id, selectedNote.uid);

			// Step 8: Push updated mappings and content index to S3
			await pushMappingAndIndexToS3(this.plugin, profile.id);

			// Step 9: Trigger CloudFront invalidation
			await createCloudFrontInvalidation(this.plugin, profile.id);

			NoticeManager.showNotice(`Successfully deleted published note: ${selectedNote.slug}`);
		} catch (error) {
			Logger.error('Error deleting published note:', error);
			NoticeManager.showNotice(`Error deleting note: ${error.message}`);
		}
	}
}