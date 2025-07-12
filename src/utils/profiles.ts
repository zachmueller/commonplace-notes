import path from 'path';
import { PathUtils } from './path';
import CommonplaceNotesPlugin from '../main';
import { PublishingProfile } from '../types';
import { Logger } from './logging';

export class ProfileManager {
	private plugin: CommonplaceNotesPlugin;
	private baseDir: string;

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
		this.baseDir = `${plugin.manifest.dir}/profiles`;
	}

	async initialize() {
		// Ensure base profiles directory exists
		await PathUtils.ensureDirectory(this.plugin, this.baseDir);

		// Ensure templates directory exists
		await PathUtils.ensureDirectory(this.plugin, this.getTemplateDir());

		// Initialize directories for each profile
		for (const profile of this.plugin.settings.publishingProfiles) {
			await this.initializeProfileDirectories(profile.id);
		}
	}

	public async initializeProfileDirectories(profileId: string) {
		const dirs = [
			this.getProfileDir(profileId),
			this.getMappingDir(profileId),
			this.getStagedNotesDir(profileId),
			this.getStagedErrorDir(profileId)
		];

		for (const dir of dirs) {
			Logger.debug(`Ensuring directory: ${dir}`);
			await PathUtils.ensureDirectory(this.plugin, dir);
		}

		// Also ensure publish history file exists with at least empty JSON
		const historyPath = this.getPublishHistoryPath(profileId);
		Logger.debug(`Verifying ${historyPath} exists`);
		if (!(await this.plugin.app.vault.adapter.exists(historyPath))) {
			await this.plugin.app.vault.adapter.write(
				historyPath,
				JSON.stringify({})
			);
			Logger.debug(`Created empty publish history file: ${historyPath}`);
		}
	}

	getProfileDir(profileId: string): string {
		return `${this.baseDir}/${profileId}`;
	}

	getMappingDir(profileId: string): string {
		return `${this.getProfileDir(profileId)}/mapping`;
	}

	getContentIndexPath(profileId: string): string {
		return `${this.getProfileDir(profileId)}/contentIndex.json`;
	}

	getCombinedLocalNotesPath(profileId: string): string {
		return `${this.getProfileDir(profileId)}/combinedNotes.json`;
	}

	getPublishHistoryPath(profileId: string): string {
		return `${this.getProfileDir(profileId)}/publish-history.json`;
	}

	getStagedNotesDir(profileId: string): string {
		return `${this.getProfileDir(profileId)}/staged-notes`;
	}

	getStagedErrorDir(profileId: string): string {
		return `${this.getProfileDir(profileId)}/staged-error`;
	}

	getTemplateDir(): string {
		return `${this.plugin.manifest.dir}/templates`;
	}

	getLocalTemplateHtmlPath(): string {
		return `${this.getTemplateDir()}/local-template.html`;
	}

	getPublishedHtmlPath(profileId: string): string {
		return `${this.getProfileDir(profileId)}/published-notes.html`;
	}
}