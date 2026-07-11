import { App, DropdownComponent, PluginSettingTab, Setting } from 'obsidian';
import CommonplaceNotesPlugin from '../main';
import { PublishingProfile } from '../types';
import { Logger } from '../utils/logging';
import { SettingsContext, ProfileContext } from './context';
import { renderGeneralTab } from './tabs/generalTab';
import { renderParserTab } from './tabs/parserTab';
import { renderRoutingTab } from './tabs/routingTab';
import { renderIdentitySection } from './profile/identity';
import { renderContentSection } from './profile/content';
import { renderDestinationSection } from './profile/destination';
import { renderDangerZone } from './profile/dangerZone';

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
		const { containerEl } = this;
		containerEl.empty();

		const ctx = this.buildContext();

		// General
		new Setting(containerEl).setName('General').setHeading();
		renderGeneralTab(ctx, containerEl);

		// Markdown parser
		new Setting(containerEl).setName('Markdown parser').setHeading();
		renderParserTab(ctx, containerEl);

		// Note routing
		new Setting(containerEl).setName('Note routing').setHeading();
		renderRoutingTab(ctx, containerEl);

		// Publishing profiles
		new Setting(containerEl).setName('Publishing profiles').setHeading();
		this.renderProfilesTab(ctx, containerEl);
	}

	/** Base context shared by every renderer. */
	private buildContext(): SettingsContext {
		return {
			app: this.app,
			plugin: this.plugin,
			rerenderAll: () => this.display(),
			rerenderProfile: () => this.renderActiveProfile(),
			createSection: (parent, title, opts) => this.createSection(parent, title, opts),
			updateProfileDropdownLabel: (index, name) => {
				if (this.profileDropdown) {
					const option = this.profileDropdown.selectEl.options[index];
					if (option) option.text = name;
				}
			},
		};
	}

	private renderProfilesTab(ctx: SettingsContext, containerEl: HTMLElement): void {
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

	private createSection(parent: HTMLElement, title: string, _opts?: { defaultCollapsed?: boolean }): HTMLElement {
		const section = parent.createDiv({ cls: 'cpn-settings-section' });
		new Setting(section).setName(title).setHeading();
		return section;
	}

	private displayProfileSettings(containerEl: HTMLElement, profile: PublishingProfile, index: number) {
		const profileContainer = containerEl.createDiv({ cls: 'cpn-profile-container' });

		const ctx: ProfileContext = { ...this.buildContext(), profile, index };

		const lastUpdated = profile.lastFullPublishTimestamp ? new Date(profile.lastFullPublishTimestamp).toLocaleString() : 'n/a';
		profileContainer.createEl('div', {
			cls: 'cpn-profile-last-publish',
			text: `Last full publish: ${lastUpdated}`
		});

		// --- Profile Identity ---
		const identitySection = this.createSection(profileContainer, 'Profile Identity');
		renderIdentitySection(ctx, identitySection);

		// --- Content ---
		const contentSection = this.createSection(profileContainer, 'Content');
		renderContentSection(ctx, contentSection);

		// --- Destination (spawns AWS Infrastructure / Auth / Site sections) ---
		const destSection = this.createSection(profileContainer, 'Destination');
		renderDestinationSection(ctx, destSection, profileContainer);

		// --- Danger Zone ---
		const dangerSection = this.createSection(profileContainer, 'Danger Zone');
		renderDangerZone(ctx, dangerSection, profileContainer);
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
			obscureRawWikilinks: true,
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
