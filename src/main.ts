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
			name: 'Refresh AWS credentials',
			callback: async () => {
				// TODO::update this to prompt user for the profile::
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
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	onunload() {
		console.log('Unloading CommonplaceNotesPlugin');
	}
}