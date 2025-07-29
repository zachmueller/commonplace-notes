import { TFile, SuggestModal, App } from 'obsidian';
import CommonplaceNotesPlugin from '../main';
import { PublishingProfile, NoteConnection, CloudFrontInvalidationScheme } from '../types';
import { pushLocalJsonsToS3 } from './awsUpload';
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
}