import { App, DropdownComponent, PluginSettingTab, Setting } from 'obsidian';
import CommonplaceNotesPlugin from './main';
import { PublishingProfile, AWSProfileSettings, IndicatorStyle } from './types';
import { Logger } from './utils/logging';

export class CommonplaceNotesSettingTab extends PluginSettingTab {
    plugin: CommonplaceNotesPlugin;
    private activeProfileIndex: number = 0;
    private profileDropdown: DropdownComponent | null = null;
    private profileContainerEl: HTMLElement | null = null;

    constructor(app: App, plugin: CommonplaceNotesPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
		const {containerEl} = this;
		containerEl.empty();

		containerEl.createEl('h2', {text: 'Publishing profiles'});

		// Profile selector dropdown
		new Setting(containerEl)
			.setName('Active profile')
			.addDropdown(dropdown => {
				this.profileDropdown = dropdown;
				const profiles = this.plugin.settings.publishingProfiles;
				profiles.forEach((profile, index) => {
					dropdown.addOption(String(index), profile.name);
				});
				this.activeProfileIndex = this.clampProfileIndex(this.activeProfileIndex);
				dropdown.setValue(String(this.activeProfileIndex));
				dropdown.onChange(value => {
					this.activeProfileIndex = parseInt(value, 10);
					this.renderActiveProfile();
				});
			});

		// Add new profile button
		new Setting(containerEl)
			.setName('Add new profile')
			.addButton(button => button
				.setButtonText('Add profile')
				.onClick(async () => {
					await this.addNewProfile();
				}));

		// Profile settings container (single profile at a time)
		this.profileContainerEl = containerEl.createDiv({ cls: 'cpn-active-profile-container' });
		this.renderActiveProfile();
	}

	private renderActiveProfile(): void {
		if (!this.profileContainerEl) return;
		this.profileContainerEl.empty();

		const profiles = this.plugin.settings.publishingProfiles;
		if (profiles.length === 0) {
			this.profileContainerEl.createEl('p', {
				text: 'No profiles configured. Click "Add profile" to create one.',
				cls: 'cpn-no-profiles-message'
			});
			return;
		}

		this.activeProfileIndex = this.clampProfileIndex(this.activeProfileIndex);
		const profile = profiles[this.activeProfileIndex];
		const index = this.activeProfileIndex;

		try {
			this.displayProfileSettings(this.profileContainerEl, profile, index);
		} catch (error) {
			Logger.error(`Error displaying profile ${profile.name}:`, error);
		}
	}

	private clampProfileIndex(index: number): number {
		const length = this.plugin.settings.publishingProfiles.length;
		if (length === 0) return 0;
		return Math.max(0, Math.min(index, length - 1));
	}

	private displayProfileSettings(containerEl: HTMLElement, profile: PublishingProfile, index: number) {
		const profileContainer = containerEl.createDiv({cls: 'cpn-profile-container'});
		profileContainer.createEl('h3', {text: profile.name});

		// Add last publish timestamp info
		const lastUpdated = profile.lastFullPublishTimestamp ? new Date(profile.lastFullPublishTimestamp).toLocaleString() : 'n/a';
		const timestampDiv = profileContainer.createEl('div', {
			cls: 'cpn-profile-last-publish',
			text: `Last full publish: ${lastUpdated}`
		});

		// Add simple styling
		timestampDiv.style.fontSize = '0.8em';
		timestampDiv.style.color = 'var(--text-muted)';
		timestampDiv.style.marginBottom = '1em';

		// Create delete button in its own container
		const deleteButtonContainer = profileContainer.createDiv({
			cls: 'cpn-profile-delete-container'
		});

		new Setting(deleteButtonContainer)
			.addButton(button => {
				let isConfirmState = false;

				button
					.setButtonText('Delete profile')
					.setClass('mod-warning')
					.onClick(async (evt: MouseEvent) => {
						evt.preventDefault();

						if (!isConfirmState) {
							// First click - show confirmation state
							button.setButtonText('Click again to confirm deletion');
							button.setClass('mod-error');
							isConfirmState = true;

							// Reset after 3 seconds if not clicked
							setTimeout(() => {
								if (isConfirmState) {
									button.setButtonText('Delete profile');
									button.setClass('mod-warning');
									isConfirmState = false;
								}
							}, 3000);
						} else { // Second click - perform deletion
							profileContainer.addClass('removing');

							setTimeout(async () => {
								this.plugin.settings.publishingProfiles.splice(index, 1);
								await this.plugin.saveSettings();
								this.plugin.registerProfileCommands();
								this.activeProfileIndex = this.clampProfileIndex(this.activeProfileIndex);
								this.display();
							}, 200);
						}
					});
				return button;
			});

		if (this.plugin.settings.publishingProfiles.length <= 1) {
			deleteButtonContainer.querySelector('button')?.setAttribute('disabled', 'true');
			deleteButtonContainer.setAttribute('title', 'Cannot delete the last remaining profile');
		}

		// container for header and delete button
		const headerContainer = profileContainer.createDiv({
			cls: 'profile-header'
		});
		headerContainer.style.display = 'flex';
		headerContainer.style.justifyContent = 'space-between';
		headerContainer.style.alignItems = 'center';
		headerContainer.style.marginBottom = '1em';

		new Setting(profileContainer)
			.setName('Profile name')
			.addText(text => text
				.setValue(profile.name)
				.onChange(async (value) => {
					this.plugin.settings.publishingProfiles[index].name = value;
					await this.plugin.saveSettings();
				})
				.inputEl.addEventListener('blur', () => {
					this.plugin.registerProfileCommands();
					if (this.profileDropdown) {
						const option = this.profileDropdown.selectEl.options[index];
						if (option) option.text = this.plugin.settings.publishingProfiles[index].name;
					}
				}));

		new Setting(profileContainer)
			.setName('Profile ID')
			.setDesc('Unique identifier used in frontmatter')
			.addText(text => text
				.setValue(profile.id)
				.onChange(async (value) => {
					this.plugin.settings.publishingProfiles[index].id = value;
					await this.plugin.saveSettings();
					this.plugin.registerProfileCommands();
				}));

		this.displayIndicatorSettings(profileContainer, profile, index);

		new Setting(profileContainer)
			.setName('Publish mechanism')
			.addDropdown(dropdown => dropdown
				.addOption('AWS', 'AWS')
				.addOption('Local', 'Local')
				.setValue(profile.publishMechanism)
				.onChange(async (value: 'AWS' | 'Local') => {
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
			.setName('Home Page')
			.setDesc('Path to the note that should serve as the home page')
			.addText(text => text
				.setPlaceholder('path/to/home-page.md')
				.setValue(profile.homeNotePath || '')
				.onChange(async (value) => {
					this.plugin.settings.publishingProfiles[index].homeNotePath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(profileContainer)
			.setName('Include site-wide content search')
			.setDesc('Choose whether to upload central content index data set to enable search on your published notes')
			.addToggle(toggle => toggle
				.setValue(profile.publishContentIndex ?? false)
				.onChange(async (value) => {
					this.plugin.settings.publishingProfiles[index].publishContentIndex = value;
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

		if (profile.publishMechanism === 'AWS') {
			this.displayAWSSettings(profileContainer, profile, index);
		} else {
			this.displayLocalSettings(profileContainer, profile, index);
		}
    }

	private displayIndicatorSettings(containerEl: HTMLElement, profile: PublishingProfile, index: number) {
		// Initialize indicator if it doesn't exist
		if (!profile.indicator) {
			profile.indicator = {
				style: 'color',
				color: '#000000'
			};
		}

		// Style selector
		new Setting(containerEl)
			.setName('Indicator style')
			.setDesc('Choose how to display this profile\'s indicator')
			.addDropdown(dropdown => dropdown
				.addOption('color', 'Color block')
				.addOption('emoji', 'Emoji')
				.setValue(profile.indicator.style)
				.onChange(async (value: IndicatorStyle) => {
					profile.indicator.style = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (profile.indicator.style === 'color') {
			const colorSetting = new Setting(containerEl)
				.setName('Indicator color')
				.setDesc('Choose the color for this profile\'s indicator')
				.addText(text => {
					text.inputEl.type = 'color';
					text.setValue(profile.indicator.color || '#000000')
						.onChange(async (value) => {
							profile.indicator.color = value;
							await this.plugin.saveSettings();
						});
					return text;
				});
		} else {
			new Setting(containerEl)
				.setName('Indicator emoji')
				.setDesc('Choose an emoji for this profile\'s indicator')
				.addText(text => text
					.setValue(profile.indicator.emoji || '📝')
					.onChange(async (value) => {
						profile.indicator.emoji = value;
						await this.plugin.saveSettings();
					}));
		}
	}

	private displayAWSSettings(containerEl: HTMLElement, profile: PublishingProfile, index: number) {
		if (!profile.awsSettings) {
			profile.awsSettings = {
				awsAccountId: '',
				awsProfile: '',
				region: '',
				bucketName: '',
				cloudFrontInvalidationScheme: 'individual',
				credentialMode: 'sdk',
				credentialRefreshCommands: '',
				awsCliPath: ''
			};
		}

		if (profile.awsSettings.awsCliPath) {
			new Setting(containerEl)
				.setName('AWS CLI Path (deprecated)')
				.setDesc('This setting is no longer used. The plugin now uses the AWS SDK directly. You can clear this field.')
				.addText(text => text
					.setValue(profile.awsSettings?.awsCliPath || '')
					.setDisabled(true));
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
			.setName('S3 prefix')
			.setDesc('Optional prefix path in the S3 bucket (e.g., "site/"). Leave empty to use bucket root.')
			.addText(text => text
				.setPlaceholder('notes/')
				.setValue(profile.awsSettings?.s3Prefix || '')
				.onChange(async (value) => {
					if (profile.awsSettings) {
						// Ensure the prefix ends with a forward slash if not empty
						profile.awsSettings.s3Prefix = value ?
							(value.endsWith('/') ? value : `${value}/`) :
							'';
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
			.setName('CloudFront Distribution ID')
			.setDesc('The ID of your CloudFront distribution for cache invalidation')
			.addText(text => text
				.setPlaceholder('E1234ABCDEF5GH')
				.setValue(profile.awsSettings?.cloudFrontDistributionId || '')
				.onChange(async (value) => {
					if (profile.awsSettings) {
						profile.awsSettings.cloudFrontDistributionId = value;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Credential mode')
			.setDesc('SDK uses the standard credential chain (env vars, shared credentials, SSO). Custom command runs shell commands to refresh credentials.')
			.addDropdown(dropdown => dropdown
				.addOption('sdk', 'SDK (default)')
				.addOption('custom-command', 'Custom command')
				.setValue(profile.awsSettings?.credentialMode || 'sdk')
				.onChange(async (value: 'sdk' | 'custom-command') => {
					if (profile.awsSettings) {
						profile.awsSettings.credentialMode = value;
						await this.plugin.saveSettings();
						this.display();
					}
				}));

		if (profile.awsSettings.credentialMode === 'custom-command') {
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
	}

	private displayLocalSettings(containerEl: HTMLElement, profile: PublishingProfile, index: number) {
		// Display Local-specific settings when implemented
	}

	private async addNewProfile() {
		const newProfile: PublishingProfile = {
			name: 'New profile',
			id: `profile-${Date.now()}`,
			lastFullPublishTimestamp: 0,
			excludedDirectories: [],
			baseUrl: '',
			homeNotePath: '',
			isPublic: false,
			publishContentIndex: true,
			publishMechanism: 'AWS',
			indicator: {
				style: 'color',
				color: '#3366cc'
			},
			awsSettings: {
				awsAccountId: '',
				awsProfile: '',
				region: '',
				bucketName: '',
				cloudFrontInvalidationScheme: 'individual',
				credentialMode: 'sdk',
				credentialRefreshCommands: '',
				awsCliPath: ''
			}
		};

		this.plugin.settings.publishingProfiles.push(newProfile);
		await this.plugin.saveSettings();
		this.activeProfileIndex = this.plugin.settings.publishingProfiles.length - 1;
		this.display();
	}
}