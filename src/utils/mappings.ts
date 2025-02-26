import path from 'path';
import { PathUtils } from '../utils/path';
import CommonplaceNotesPlugin from '../main';
import { Logger } from './logging';

interface MappingData {
	slugToUid: Record<string, string>;
	uidToHash: Record<string, string>;
}

export class MappingManager {
	private plugin: CommonplaceNotesPlugin;
	private mappingData: Record<string, MappingData>;

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
		this.mappingData = {};
	}

	async loadMappings() {
		try {
			// Load mappings for each profile
			for (const profile of this.plugin.settings.publishingProfiles) {
				await this.loadProfileMappings(profile.id);
			}
		} catch (error) {
			Logger.error('Error loading mappings:', error);
			throw error;
		}
	}

	async loadProfileMappings(profileId: string) {
		const mappingDir = this.plugin.profileManager.getMappingDir(profileId);
		await PathUtils.ensureDirectory(this.plugin, mappingDir);

		const slugToUidPath = `${mappingDir}/slug-to-uid.json`;
		const uidToHashPath = `${mappingDir}/uid-to-hash.json`;

		try {
			Logger.debug(`Loading mapping from ${slugToUidPath}`);
			const slugToUidContent = await this.plugin.app.vault.adapter.read(slugToUidPath);
			Logger.debug(`Loading mapping from ${uidToHashPath}`);
			const uidToHashContent = await this.plugin.app.vault.adapter.read(uidToHashPath);

			this.mappingData[profileId] = {
				slugToUid: JSON.parse(slugToUidContent),
				uidToHash: JSON.parse(uidToHashContent)
			};
			Logger.debug(`Found ${Object.keys(slugToUidContent).length} Slug to UID mappings`);
			Logger.debug(`Found ${Object.keys(uidToHashContent).length} UID to hash mappings`);
		} catch (e) {
			// Initialize empty mappings and create files
			Logger.warn(`Failed to load mappings for profile ${profileId}, falling back to empty mapping`);
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
			Logger.error('Error saving mappings:', error);
			throw error;
		}
	}

	private async saveProfileMappings(profileId: string) {
		Logger.debug(`Saving mappings for profile ${profileId} to file`);
		const mappingDir = this.plugin.profileManager.getMappingDir(profileId);
		await PathUtils.ensureDirectory(this.plugin, mappingDir);

		const data = this.mappingData[profileId];
		if (!data) return;

		await this.plugin.app.vault.adapter.write(
			`${mappingDir}/slug-to-uid.json`,
			JSON.stringify(data.slugToUid)
		);

		await this.plugin.app.vault.adapter.write(
			`${mappingDir}/uid-to-hash.json`,
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