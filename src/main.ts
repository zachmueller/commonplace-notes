import { Plugin, MarkdownView, Notice, App, TFile } from 'obsidian';
import { execAsync } from './utils/shell';
import { CommonplaceNotesPublisherSettingTab } from './settings';
import { PathUtils } from './utils/path';
import { FrontmatterManager } from './utils/frontmatter';
import { pushLocalJsonsToS3 } from './publish/awsUpload';
import { getBacklinks, convertCurrentNote, markdownToHtml } from './convert/html';
import { refreshCredentials } from './publish/awsCredentials';
import { CommonplaceNotesPublisherSettings } from './types';

const DEFAULT_SETTINGS: CommonplaceNotesPublisherSettings = {
    publishingProfiles: [{
        name: 'Default AWS Profile',
        id: 'default',
        excludedDirectories: ['private/'],
        baseUrl: '',
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
    }],
    defaultProfileId: 'default'
};

export default class CommonplaceNotesPublisherPlugin extends Plugin {
	settings: CommonplaceNotesPublisherSettings;
	frontmatterManager: FrontmatterManager;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new CommonplaceNotesPublisherSettingTab(this.app, this));

		this.frontmatterManager = new FrontmatterManager(this.app);

		this.addCommand({
			id: 'testing-stuff',
			name: 'Testing stuff',
			callback: async () => {
				await this.test();
			}
		});

		this.addCommand({
			id: 'convert-note-to-html',
			name: 'Convert current note to HTML',
			callback: async () => {
				await convertCurrentNote(this);
			}
		});

		this.addCommand({
			id: 'refresh-credentials',
			name: 'Refresh AWS credentials',
			callback: async () => {
				// TODO::update this to prompt user for the profile::
				await refreshCredentials(this, this.settings.publishingProfiles[0].id);
			}
		});

		this.addCommand({
			id: 'publish-note',
			name: 'Publish note to S3',
			callback: async () => {
				// TODO::update this to extract the profile from the note itself::
				await pushLocalJsonsToS3(this, this.settings.publishingProfiles[0].id);
			}
		});
	}

	private test() {
		//console.log(getBacklinks());
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	onunload() {
		console.log('Unloading CommonplaceNotesPublisherPlugin');
	}
}