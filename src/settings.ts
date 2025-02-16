import { App, PluginSettingTab, Setting } from 'obsidian';
import CommonplaceNotesPublisherPlugin from './main';
import { PublishingProfile, AWSProfileSettings } from './types';

export class CommonplaceNotesPublisherSettingTab extends PluginSettingTab {
    plugin: CommonplaceNotesPublisherPlugin;

    constructor(app: App, plugin: CommonplaceNotesPublisherPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();

		containerEl.createEl('h2', {text: 'Publishing profiles'});

		// Add button to create new profile
		new Setting(containerEl)
			.setName('Add new profile')
			.addButton(button => button
				.setButtonText('Add profile')
				.onClick(async () => {
					await this.addNewProfile();
				}));

		// Display existing profiles
		this.plugin.settings.publishingProfiles.forEach((profile, index) => {
			this.displayProfileSettings(containerEl, profile, index);
		});
	}

	private displayProfileSettings(containerEl: HTMLElement, profile: PublishingProfile, index: number) {
		const profileContainer = containerEl.createDiv();
		profileContainer.createEl('h3', {text: profile.name});

		// container for header and delete button
		const headerContainer = profileContainer.createDiv({
			cls: 'profile-header'
		});
		headerContainer.style.display = 'flex';
		headerContainer.style.justifyContent = 'space-between';
		headerContainer.style.alignItems = 'center';
		headerContainer.style.marginBottom = '1em';

		// Create the delete button
		// TODO::clean up the CSS/etc to make this button less obnoxious::
		const deleteButton = new Setting(headerContainer)
			.addButton(button => button
				.setButtonText('Delete profile')
				.setClass('mod-warning') // This gives it a red color to indicate destructive action
				.onClick(async () => {
					// Show a confirmation dialog
					const confirmDelete = confirm(`Are you sure you want to delete the profile "${profile.name}"?`);
					if (confirmDelete) {
						// Remove the profile from the array
						this.plugin.settings.publishingProfiles.splice(index, 1);

						// Save settings and refresh the display
						await this.plugin.saveSettings();
						this.display();
					}
				}));

		// Don't allow deletion of the last profile
		if (this.plugin.settings.publishingProfiles.length <= 1) {
			deleteButton.setDisabled(true);
			deleteButton.setTooltip('Cannot delete the last remaining profile');
		}

		new Setting(profileContainer)
			.setName('Profile name')
			.addText(text => text
				.setValue(profile.name)
				.onChange(async (value) => {
					this.plugin.settings.publishingProfiles[index].name = value;
					await this.plugin.saveSettings();
					// Refresh display to update name
					this.display();
				}));

		new Setting(profileContainer)
			.setName('Profile ID')
			.setDesc('Unique identifier used in frontmatter')
			.addText(text => text
				.setValue(profile.id)
				.onChange(async (value) => {
					this.plugin.settings.publishingProfiles[index].id = value;
					await this.plugin.saveSettings();
				}));

		new Setting(profileContainer)
			.setName('Publish mechanism')
			.addDropdown(dropdown => dropdown
				.addOption('AWS CLI', 'AWS CLI')
				.addOption('Local', 'Local')
				.setValue(profile.publishMechanism)
				.onChange(async (value: 'AWS CLI' | 'Local') => {
					this.plugin.settings.publishingProfiles[index].publishMechanism = value;
					await this.plugin.saveSettings();
					// Refresh the settings display to show/hide mechanism-specific settings
					this.display();
				}));

		new Setting(profileContainer)
			.setName('Base URL')
			.setDesc('Base URL for published notes')
			.addText(text => text
				.setValue(profile.baseUrl)
				.onChange(async (value) => {
					this.plugin.settings.publishingProfiles[index].baseUrl = value;
					await this.plugin.saveSettings();
				}));

		new Setting(profileContainer)
			.setName('Excluded directories')
			.setDesc('One directory per line (e.g., private/)')
			.addTextArea(text => text
				.setValue(profile.excludedDirectories.join('\n'))
				.onChange(async (value) => {
					this.plugin.settings.publishingProfiles[index].excludedDirectories = 
						value.split('\n').filter(line => line.trim() !== '');
					await this.plugin.saveSettings();
				}));

		if (profile.publishMechanism === 'AWS CLI') {
			this.displayAWSSettings(profileContainer, profile, index);
		} else {
			this.displayLocalSettings(profileContainer, profile, index);
		}
    }

	private displayAWSSettings(containerEl: HTMLElement, profile: PublishingProfile, index: number) {
		// Display AWS-specific settings...
		if (!profile.awsSettings) {
			profile.awsSettings = {
				awsAccountId: '',
				awsProfile: '',
				region: '',
				bucketName: '',
				cloudFrontInvalidationScheme: 'individual',
				credentialRefreshCommands: ''
			};
		}

		new Setting(containerEl)
			.setName('AWS account ID')
			.setDesc('The AWS account ID to use for authentication')
			.addText(text => text
				.setPlaceholder('123456789012')
				.setValue(profile.awsSettings?.awsAccountId || '')
				.onChange(async (value) => {
					if (profile.awsSettings) {
						profile.awsSettings.awsAccountId = value;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('AWS profile')
			.setDesc('The AWS profile to use for authentication')
			.addText(text => text
				.setPlaceholder('notes')
				.setValue(profile.awsSettings?.awsProfile || '')
				.onChange(async (value) => {
					if (profile.awsSettings) {
						profile.awsSettings.awsProfile = value;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('S3 bucket name')
			.setDesc('The name of the S3 bucket to upload to')
			.addText(text => text
				.setPlaceholder('my-notes-bucket')
				.setValue(profile.awsSettings?.bucketName || '')
				.onChange(async (value) => {
					if (profile.awsSettings) {
						profile.awsSettings.bucketName = value;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('AWS region')
			.setDesc('The AWS region where your bucket is located')
			.addText(text => text
				.setPlaceholder('us-east-1')
				.setValue(profile.awsSettings?.region || '')
				.onChange(async (value) => {
					if (profile.awsSettings) {
						profile.awsSettings.region = value;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('CloudFront invalidation scheme')
			.setDesc('When to trigger CloudFront invalidations')
			.addDropdown(dropdown => dropdown
				.addOption('individual', 'Individual note')
				.addOption('connected', 'Active & Connected')
				.addOption('sinceLast', 'Since last full publish')
				.addOption('all', 'Publish all')
				.addOption('manual', 'Manual')
				.setValue(profile.awsSettings?.cloudFrontInvalidationScheme || 'individual')
				.onChange(async (value: any) => {
					if (profile.awsSettings) {
						profile.awsSettings.cloudFrontInvalidationScheme = value;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Credential refresh commands')
			.setDesc('Enter the commands to refresh AWS credentials (one per line). You can use ${awsAccountId} and ${awsProfile} as variables.')
			.addTextArea(text => text
				.setPlaceholder('aws sso login --profile notes')
				.setValue(profile.awsSettings?.credentialRefreshCommands || '')
				.onChange(async (value) => {
					if (profile.awsSettings) {
						profile.awsSettings.credentialRefreshCommands = value;
						await this.plugin.saveSettings();
					}
				}));
	}

	private displayLocalSettings(containerEl: HTMLElement, profile: PublishingProfile, index: number) {
		// Display Local-specific settings when implemented
	}

	private async addNewProfile() {
		const newProfile: PublishingProfile = {
			name: 'New profile',
			id: `profile-${Date.now()}`,
			excludedDirectories: [],
			baseUrl: '',
			isPublic: false,
			publishMechanism: 'AWS CLI',
			awsSettings: {
				awsAccountId: '',
				awsProfile: '',
				region: '',
				bucketName: '',
				cloudFrontInvalidationScheme: 'individual',
				credentialRefreshCommands: ''
			}
		};

		this.plugin.settings.publishingProfiles.push(newProfile);
		await this.plugin.saveSettings();
		this.display();
	}
}