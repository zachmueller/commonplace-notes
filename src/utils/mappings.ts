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
		const errorDir = this.plugin.profileManager.getStagedErrorDir(profileId);
		await PathUtils.ensureDirectory(this.plugin, mappingDir);

		const slugToUidPath = `${mappingDir}/slug-to-uid.json`;
		const uidToHashPath = `${mappingDir}/uid-to-hash.json`;

		try {
			let slugToUid = {};
			let uidToHash = {};
			const timestamp = Date.now();

			// Try to load slug-to-uid mapping
			try {
				const slugToUidContent = await this.plugin.app.vault.adapter.read(slugToUidPath);
				slugToUid = JSON.parse(slugToUidContent);
			} catch (e) {
				// If file exists but is corrupted, back it up
				if (await this.plugin.app.vault.adapter.exists(slugToUidPath)) {
					const backupPath = `${errorDir}/${timestamp}-slug-to-uid.json`;
					NoticeManager.showNotice(`Corrupted slug-to-uid mapping backed up to the error directory. Check the console for details.`);
					Logger.warn(`Failed to parse slug-to-uid mapping for profile ${profileId}, backing up to ${backupPath}`);

					try {
						// Ensure error directory exists
						await PathUtils.ensureDirectory(this.plugin, errorDir);

						// Copy the corrupted file
						const corruptedContent = await this.plugin.app.vault.adapter.read(slugToUidPath);
						await this.plugin.app.vault.adapter.write(backupPath, corruptedContent);

						// Also save error details
						await this.plugin.app.vault.adapter.write(
							`${errorDir}/${timestamp}-slug-to-uid-error.json`,
							JSON.stringify({
								timestamp,
								file: 'slug-to-uid.json',
								error: e.message,
								stack: e.stack
							})
						);
					} catch (backupError) {
						Logger.error(`Failed to backup corrupted slug-to-uid mapping:`, backupError);
					}
				}
			}

			// Try to load uid-to-hash mapping
			try {
				const uidToHashContent = await this.plugin.app.vault.adapter.read(uidToHashPath);
				uidToHash = JSON.parse(uidToHashContent);
			} catch (e) {
				// If file exists but is corrupted, back it up
				if (await this.plugin.app.vault.adapter.exists(uidToHashPath)) {
					const backupPath = `${errorDir}/${timestamp}-uid-to-hash.json`;
					NoticeManager.showNotice(`Corrupted uid-to-hash mapping backed up to the error directory. Check the console for details.`);
					Logger.warn(`Failed to parse uid-to-hash mapping for profile ${profileId}, backing up to ${backupPath}`);

					try {
						// Ensure error directory exists
						await PathUtils.ensureDirectory(this.plugin, errorDir);

						// Copy the corrupted file
						const corruptedContent = await this.plugin.app.vault.adapter.read(uidToHashPath);
						await this.plugin.app.vault.adapter.write(backupPath, corruptedContent);

						// Also save error details
						await this.plugin.app.vault.adapter.write(
							`${errorDir}/${timestamp}-uid-to-hash-error.json`,
							JSON.stringify({
								timestamp,
								file: 'uid-to-hash.json',
								error: e.message,
								stack: e.stack
							})
						);
					} catch (backupError) {
						Logger.error(`Failed to backup corrupted uid-to-hash mapping:`, backupError);
					}
				}
			}

			// Store mapping data in memory
			this.mappingData[profileId] = { slugToUid, uidToHash };
		} catch (error) {
			Logger.error(`Critical error loading mappings for profile ${profileId}:`, error);
			throw error;
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

		Logger.debug(`Writing updates to slug-to-uid file for profile '${profileId}'`);
		await this.plugin.app.vault.adapter.write(
			`${mappingDir}/slug-to-uid.json`,
			JSON.stringify(data.slugToUid)
		);

		Logger.debug(`Writing updates to uid-to-hash file for profile '${profileId}'`);
		await this.plugin.app.vault.adapter.write(
			`${mappingDir}/uid-to-hash.json`,
			JSON.stringify(data.uidToHash)
		);
	}

	updateMappings(profileId: string, slug: string, uid: string, hash: string) {
		Logger.debug(`Updating mappings for profile ${profileId}: ${slug} -> ${uid} -> ${hash}`);

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