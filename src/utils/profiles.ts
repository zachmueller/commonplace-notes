import path from 'path';
import { PathUtils } from './path';
import CommonplaceNotesPlugin from '../main';
import { PublishingProfile } from '../types';

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

		// Initialize directories for each profile
		for (const profile of this.plugin.settings.publishingProfiles) {
			await this.initializeProfileDirectories(profile.id);
		}
	}

	private async initializeProfileDirectories(profileId: string) {
		const dirs = [
			this.getProfileDir(profileId),
			this.getMappingDir(profileId),
			this.getStagedNotesDir(profileId),
			this.getStagedErrorDir(profileId)
		];

		for (const dir of dirs) {
			await PathUtils.ensureDirectory(this.plugin, dir);
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

	getPublishHistoryPath(profileId: string): string {
		return `${this.getProfileDir(profileId)}/publish-history.json`;
	}

	getStagedNotesDir(profileId: string): string {
		return `${this.getProfileDir(profileId)}/staged-notes`;
	}

	getStagedErrorDir(profileId: string): string {
		return `${this.getProfileDir(profileId)}/staged-error`;
	}
}