import path from 'path';
import { PathUtils } from '../utils/path';
import CommonplaceNotesPlugin from '../main';

interface MappingData {
	slugToUid: Record<string, string>;
	uidToHash: Record<string, string>;
}

export class MappingManager {
	private plugin: CommonplaceNotesPlugin;
	private mappingData: Record<string, MappingData>;
	public mappingDir: string;

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
		this.mappingDir = `${plugin.manifest.dir}/mapping`;
		this.mappingData = {};
	}

	private getProfileMappingDir(profileId: string): string {
		return `${this.mappingDir}/${profileId}`;
	}

	async loadMappings() {
		try {
			// Ensure base mapping directory exists
			await PathUtils.ensureDirectory(this.plugin, this.mappingDir);

			// Load mappings for each profile
			for (const profile of this.plugin.settings.publishingProfiles) {
				const profileDir = this.getProfileMappingDir(profile.id);
				
				// Ensure profile directory exists
				await PathUtils.ensureDirectory(this.plugin, profileDir);
				
				await this.loadProfileMappings(profile.id);
			}
		} catch (error) {
			console.error('Error loading mappings:', error);
			throw error;
		}
	}

	private async loadProfileMappings(profileId: string) {
		const profileDir = this.getProfileMappingDir(profileId);
		await PathUtils.ensureDirectory(this.plugin, profileDir);

		const slugToUidPath = `${profileDir}/slug-to-uid.json`;
		const uidToHashPath = `${profileDir}/uid-to-hash.json`;

		try {
			const slugToUidContent = await this.plugin.app.vault.adapter.read(slugToUidPath);
			const uidToHashContent = await this.plugin.app.vault.adapter.read(uidToHashPath);

			this.mappingData[profileId] = {
				slugToUid: JSON.parse(slugToUidContent),
				uidToHash: JSON.parse(uidToHashContent)
			};
		} catch (e) {
			// Initialize empty mappings and create files
			this.mappingData[profileId] = {
				slugToUid: {},
				uidToHash: {}
			};
			await this.saveProfileMappings(profileId);
		}
	}

	async saveMappings() {
		try {
			// Save mappings for each profile
			for (const profileId of Object.keys(this.mappingData)) {
				await this.saveProfileMappings(profileId);
			}
		} catch (error) {
			console.error('Error saving mappings:', error);
			throw error;
		}
	}

	private async saveProfileMappings(profileId: string) {
		const profileDir = this.getProfileMappingDir(profileId);
		await PathUtils.ensureDirectory(this.plugin, profileDir);

		const data = this.mappingData[profileId];
		if (!data) return;

		await this.plugin.app.vault.adapter.write(
			`${profileDir}/slug-to-uid.json`,
			JSON.stringify(data.slugToUid)
		);

		await this.plugin.app.vault.adapter.write(
			`${profileDir}/uid-to-hash.json`,
			JSON.stringify(data.uidToHash)
		);
	}

	updateMappings(profileId: string, slug: string, uid: string, hash: string) {
		// Initialize profile mappings if they don't exist
		if (!this.mappingData[profileId]) {
			this.mappingData[profileId] = {
				slugToUid: {},
				uidToHash: {}
			};
		}

		this.mappingData[profileId].slugToUid[slug] = uid;
		this.mappingData[profileId].uidToHash[uid] = hash;
	}

	getPriorHash(profileId: string, uid: string): string | null {
		return this.mappingData[profileId]?.uidToHash[uid] || null;
	}

	getUidFromSlug(profileId: string, slug: string): string | null {
		return this.mappingData[profileId]?.slugToUid[slug] || null;
	}
}