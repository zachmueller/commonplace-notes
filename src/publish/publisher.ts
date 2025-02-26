import { Notice, TFile, SuggestModal, App } from 'obsidian';
import CommonplaceNotesPlugin from '../main';
import { PublishingProfile, NoteConnection, CloudFrontInvalidationScheme } from '../types';
import { pushLocalJsonsToS3 } from './awsUpload';
import { PathUtils } from '../utils/path';
import { Logger } from '../utils/logging';

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
		const contexts = this.plugin.frontmatterManager.getFrontmatterValue(file, 'cpn-publish-contexts');
		return Array.isArray(contexts) ? contexts : [];
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
				new Notice('No valid publishing profiles available');
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
					const uid = await this.plugin.frontmatterManager.getNoteUID(connectedFile);
					if (uid === null) continue;
					connections.set(path, {
						file: connectedFile,
						isBacklink: false,
						isOutgoingLink: true,
						uid,
						slug: PathUtils.slugifyFilePath(connectedFile.path),
						title: connectedFile.basename
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
						const uid = await this.plugin.frontmatterManager.getNoteUID(connectedFile);
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
								title: connectedFile.basename
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
			// Queue all notes for processing
			for (const file of files) {
				await this.plugin.noteManager.queueNote(file, profile.id);
			}
			new Notice(`${files.length} notes processed`);

			// Commit all queued notes to staging
			await this.plugin.noteManager.commitPendingNotes(profile.id);

			// Upload to destination
			if (profile.publishMechanism === 'AWS CLI') {
				const awsUpload = await pushLocalJsonsToS3(this.plugin, profile.id, triggerCloudFrontInvalidation);
				// TODO::instead should prompt user whether to delete local copies of processed notes::
				// (for now just stopping here to not delete anything)
				if (!awsUpload) {
					new Notice('Upload failed. Staged files preserved for retry.');
					return;
				}
			} else {
				// Handle local publishing when implemented
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

			new Notice(`Successfully published ${files.length} note(s)`);
		} catch (error) {
			new Notice(`Error during publishing: ${error.message}`);
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

			new Notice(`Publish failed. Error details saved to ${errorSessionDir}`);
		} catch (moveError) {
			Logger.error('Error handling publish failure:', moveError);
			new Notice('Failed to save error details. Check console for more information.');
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
			new Notice('No publishing contexts defined for this note');
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
			new Notice('No publishing contexts defined for this note');
			return;
		}

		const profile = await this.promptForProfile(contexts);
		if (!profile) return;

		if (this.isFileExcluded(file, profile)) {
			new Notice('This note is in an excluded directory and cannot be published');
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
			new Notice('No updates found since last full publish');
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
			new Notice('No publishable notes found for this profile');
			return;
		}

		const triggerInvalidation = this.shouldInvalidateCloudFront(profile, 'all');
		await this.publishNotes(allNotes, profile, true, triggerInvalidation);
	}
}