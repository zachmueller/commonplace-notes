import { Plugin, MarkdownView, Notice, App, TFile } from 'obsidian';
import { execAsync } from './utils/shell';
import { CommonplaceNotesSettingTab } from './settings';
import { PathUtils } from './utils/path';
import { FrontmatterManager } from './utils/frontmatter';
import { pushLocalJsonsToS3 } from './publish/awsUpload';
import { refreshCredentials } from './publish/awsCredentials';
import { CommonplaceNotesSettings } from './types';
import { MappingManager } from './utils/mappings';
import { Publisher } from './publish/publisher';

const DEFAULT_SETTINGS: CommonplaceNotesSettings = {
    publishingProfiles: [{
        name: 'Default AWS Profile',
        id: 'default',
		lastFullPublishTimestamp: 0,
        excludedDirectories: ['private/'],
        baseUrl: '',
		homeNotePath: '',
        isPublic: false,
		publishContentIndex: true,
        publishMechanism: 'AWS CLI',
        awsSettings: {
            awsAccountId: '123456789012',
            awsProfile: 'notes',
            bucketName: 'my-bucket',
            region: 'us-east-1',
            cloudFrontInvalidationScheme: 'individual',
            credentialRefreshCommands: ''
        }
    }]
};

export default class CommonplaceNotesPlugin extends Plugin {
	settings: CommonplaceNotesSettings;
	frontmatterManager: FrontmatterManager;
	mappingManager: MappingManager;
	publisher: Publisher;

	async onload() {
		// Initialize settings
		await this.loadSettings();
		this.addSettingTab(new CommonplaceNotesSettingTab(this.app, this));

		// Initialize classes
		this.frontmatterManager = new FrontmatterManager(this.app);
		this.mappingManager = new MappingManager(this);
		await this.mappingManager.loadMappings();
		this.publisher = new Publisher(this);

		this.addCommand({
			id: 'refresh-credentials',
			name: 'Refresh credentials',
			callback: async () => {
				const profile = await this.publisher.promptForProfile();
				if (!profile) {
					throw new Error('No valid profile selected');
				}
				await refreshCredentials(this, profile.id);
			}
		});

		this.addCommand({
			id: 'publish-current-note',
			name: 'Publish current note',
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!activeView?.file) return false;
				if (checking) return true;
				
				this.publisher.publishSingle(activeView.file);
				return true;
			}
		});

		this.addCommand({
			id: 'publish-connected-notes',
			name: 'Publish active and connected notes',
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!activeView?.file) return false;
				if (checking) return true;
				
				this.publisher.publishConnected(activeView.file);
				return true;
			}
		});

		this.addCommand({
			id: 'publish-updates',
			name: 'Publish updates since last full publish',
			callback: async () => {
				await this.publisher.publishUpdates();
			}
		});

		this.addCommand({
			id: 'publish-all',
			name: 'Publish all notes',
			callback: async () => {
				await this.publisher.publishAll();
			}
		});

		this.addCommand({
			id: 'copy-active-note-published-url',
			name: 'Copy link to current note URL',
			callback: async () => {
				// check that file is active
				const file = this.app.workspace.getActiveFile();
				if (!file) {
					new Notice('No active file');
					return;
				}

				// check publishing contexts
				const contexts = await this.publisher.getPublishContextsForFile(file);
				if (contexts.length === 0) {
					new Notice('No publishing contexts defined for this note');
					return;
				}

				// prompt to select profile, if needed
				const profile = await this.publisher.promptForProfile(contexts);
				if (!profile) return;

				// check for baseUrl setting
				if (!profile.baseUrl) {
					new Notice(`No baseUrl defined for profile ${profile.id}`);
					return;
				}

				// craft URL
				const uid = await this.frontmatterManager.getNoteUID(file);
				if (!uid) {
					new Notice(`Did not find UID for note '${file.basename}'`);
					return;
				}
				const base = profile.baseUrl.replace(/\/?$/, '/');
				const url = `${base}#u=${encodeURIComponent(uid)}`;
				try {
					await navigator.clipboard.writeText(url);
					new Notice('Note URL copied');
				} catch (error) {
					console.error('Error copying note URL:', error);
					throw new Error('Error copying note URL, check console');
				}
			}
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async rebuildContentIndex(): Promise<void> {
		/*
		Access this in the Obsidian console via:
const cpn = app.plugins.plugins['commonplace-notes'];
cpn.rebuildContentIndex();
		*/
		// Process each note
		const profile = await this.publisher.promptForProfile();
		if (!profile) return;
		const files = await this.publisher.getAllPublishableNotes(profile.id);
		for (const file of files) {
			if (profile.publishContentIndex) {
				const uid = await this.frontmatterManager.getNoteUID(file);
				if (uid) {
					console.log(`Processing ${file.basename}`);
					await this.publisher.contentIndexManager.queueUpdate(profile.id, file, uid);
				}
			}
		}

		// apply queued updates
		await this.publisher.contentIndexManager.applyQueuedUpdates(profile.id);
		new Notice(`Reprocessed contentIndex.json for profile ${profile.id}`);
	}

	onunload() {
		console.log('Unloading CommonplaceNotesPlugin');
	}
}