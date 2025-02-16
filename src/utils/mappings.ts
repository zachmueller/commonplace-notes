import path from 'path';
import { PathUtils } from '../utils/path';
import CommonplaceNotesPublisherPlugin from '../main';

interface MappingData {
	slugToUid: Record<string, string>;
	uidToHash: Record<string, string>;
}

export class MappingManager {
	private plugin: CommonplaceNotesPublisherPlugin;
	private mappingData: MappingData;
	public mappingDir: string;

	constructor(plugin: CommonplaceNotesPublisherPlugin) {
		this.plugin = plugin;
		this.mappingDir = `${plugin.manifest.dir}/mapping`;
		this.mappingData = {
			slugToUid: {},
			uidToHash: {}
		};
	}

	async loadMappings() {
		try {
			await PathUtils.ensureDirectory(this.plugin, this.mappingDir);
			
			const slugToUidPath = `${this.mappingDir}/slug-to-uid.json`;
			const uidToHashPath = `${this.mappingDir}/uid-to-hash.json`;

			try {
				const slugToUidContent = await this.plugin.app.vault.adapter.read(slugToUidPath);
				this.mappingData.slugToUid = JSON.parse(slugToUidContent);
			} catch (e) {
				this.mappingData.slugToUid = {};
			}

			try {
				const uidToHashContent = await this.plugin.app.vault.adapter.read(uidToHashPath);
				this.mappingData.uidToHash = JSON.parse(uidToHashContent);
			} catch (e) {
				this.mappingData.uidToHash = {};
			}
		} catch (error) {
			console.error('Error loading mappings:', error);
			throw error;
		}


		console.log(this.mappingData);


	}

	async saveMappings() {
		try {
			await PathUtils.ensureDirectory(this.plugin, this.mappingDir);
			
			await this.plugin.app.vault.adapter.write(
				`${this.mappingDir}/slug-to-uid.json`,
				JSON.stringify(this.mappingData.slugToUid)
			);

			await this.plugin.app.vault.adapter.write(
				`${this.mappingDir}/uid-to-hash.json`,
				JSON.stringify(this.mappingData.uidToHash)
			);
		} catch (error) {
			console.error('Error saving mappings:', error);
			throw error;
		}
	}

	updateMappings(slug: string, uid: string, hash: string) {
		this.mappingData.slugToUid[slug] = uid;
		this.mappingData.uidToHash[uid] = hash;
	}

	getPriorHash(uid: string): string | null {
		return this.mappingData.uidToHash[uid] || null;
	}
}