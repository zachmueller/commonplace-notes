import { Notice, TFile, SuggestModal, App } from 'obsidian';
import CommonplaceNotesPublisherPlugin from '../main';
import { PublishingProfile } from '../types';
import { convertNotetoJSON } from '../convert/html';
import { pushLocalJsonsToS3 } from './awsUpload';
import { PathUtils } from '../utils/path';

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
	private plugin: CommonplaceNotesPublisherPlugin;

	constructor(plugin: CommonplaceNotesPublisherPlugin) {
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

	// TODO::extend this to allow for no filtering by profileId::
	async getConnectedNotes(file: TFile, profileId: string): Promise<TFile[]> {
		const resolvedLinks = this.plugin.app.metadataCache.resolvedLinks;
		const connected = new Set<string>();

		// Add outgoing links
		const outgoing = resolvedLinks[file.path] || {};
		Object.keys(outgoing).forEach(path => connected.add(path));

		// Add incoming links (backlinks)
		Object.entries(resolvedLinks).forEach(([sourcePath, links]) => {
			if (links[file.path]) {
				connected.add(sourcePath);
			}
		});

		// Convert paths to files and filter for publishing context
		const connectedFiles: TFile[] = [];
		for (const path of connected) {
			const connectedFile = this.plugin.app.vault.getAbstractFileByPath(path);
			if (connectedFile instanceof TFile) {
				const contexts = await this.getPublishContextsForFile(connectedFile);
				if (contexts.includes(profileId)) {
					connectedFiles.push(connectedFile);
				}
			}
		}

		return connectedFiles;
	}

	async publishNotes(files: TFile[], profile: PublishingProfile, updatePublishTimestamp: boolean = false) {
		try {
			// Convert all notes
			for (const file of files) {
				await convertNotetoJSON(this.plugin, file, profile.id);
			}

			// Upload to destination
			if (profile.publishMechanism === 'AWS CLI') {
				await pushLocalJsonsToS3(this.plugin, profile.id);
			} else {
				// Handle local publishing when implemented
			}

			// Clean up local files
			const notesDir = `${this.plugin.manifest.dir}/notes`; //TODO::centralize definition of this dir::
			await new PathUtils().deleteFilesInDirectory(this.plugin, notesDir);

			// Update timestamp for full publishes
			if (updatePublishTimestamp) {
				const profileIndex = this.plugin.settings.publishingProfiles.findIndex(p => p.id === profile.id);
				if (profileIndex !== -1) {
					this.plugin.settings.publishingProfiles[profileIndex].lastFullPublishTimestamp = Date.now();
					await this.plugin.saveSettings();
				}
			}

			new Notice(`Successfully published ${files.length} note(s)`);
		} catch (error) {
			new Notice(`Error during publishing: ${error.message}`);
			console.error('Publishing error:', error);
		}
	}

	async getAllPublishableNotes(profileId: string): Promise<TFile[]> {
		const files: TFile[] = [];

		const allFiles = this.plugin.app.vault.getFiles();
		for (const file of allFiles) {
			if (file.extension === 'md') {
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

	async publishSingle(file: TFile) {
		const contexts = await this.getPublishContextsForFile(file);
		if (contexts.length === 0) {
			new Notice('No publishing contexts defined for this note');
			return;
		}

		const profile = await this.promptForProfile(contexts);
		if (!profile) return;

		await this.publishNotes([file], profile);
	}

	async publishConnected(file: TFile) {
		const contexts = await this.getPublishContextsForFile(file);
		if (contexts.length === 0) {
			new Notice('No publishing contexts defined for this note');
			return;
		}

		const profile = await this.promptForProfile(contexts);
		if (!profile) return;

		const connectedNotes = await this.getConnectedNotes(file, profile.id);
		connectedNotes.push(file); // Include the active note

		await this.publishNotes(connectedNotes, profile);
	}

	async publishUpdates() {
		const profile = await this.promptForProfile();
		if (!profile) return;

		const updatedNotes = await this.getUpdatedNotes(profile.id);
		if (updatedNotes.length === 0) {
			new Notice('No updates found since last full publish');
			return;
		}

		await this.publishNotes(updatedNotes, profile, true);
	}

	async publishAll() {
		const profile = await this.promptForProfile();
		if (!profile) return;

		const allNotes = await this.getAllPublishableNotes(profile.id);
		if (allNotes.length === 0) {
			new Notice('No publishable notes found for this profile');
			return;
		}

		await this.publishNotes(allNotes, profile, true);
	}
}