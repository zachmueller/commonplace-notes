import { App, DropdownComponent, Modal, Notice, PluginSettingTab, Setting, SuggestModal, TFile } from 'obsidian';
import CommonplaceNotesPlugin from './main';
import { PublishingProfile, IndicatorStyle, SiteCustomization, HeaderLink, NamedStyle, ThemeColors } from './types';
import { Logger } from './utils/logging';
import { DeploymentWizardModal, sha256Hex } from './infrastructure/deploymentWizardModal';
import type { DeploymentConfig } from './infrastructure/types';
import { DnsAssistantModal } from './infrastructure/dnsAssistantModal';
import { ImportStackModal } from './infrastructure/importStackModal';
import { googleOAuthUrls } from './infrastructure/cognitoUrls';
import { pushSiteAssetsToS3, createCloudFrontInvalidation } from './publish/awsUpload';

class HomeNoteSuggestModal extends SuggestModal<TFile> {
	private files: TFile[];
	private onChoose: (file: TFile) => void;

	constructor(app: App, files: TFile[], onChoose: (file: TFile) => void) {
		super(app);
		this.files = files;
		this.onChoose = onChoose;
		this.setPlaceholder('Search for a publishable note...');
	}

	getSuggestions(query: string): TFile[] {
		const lower = query.toLowerCase();
		return this.files.filter(f => f.path.toLowerCase().includes(lower));
	}

	renderSuggestion(file: TFile, el: HTMLElement) {
		el.createEl('div', { text: file.path });
	}

	onChooseSuggestion(file: TFile) {
		this.onChoose(file);
	}
}

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

		// Global (non-profile) settings
		new Setting(containerEl).setName('General').setHeading();

		new Setting(containerEl)
			.setName('UID length')
			.setDesc('Number of characters for newly generated note UIDs (Crockford Base32). 8 characters provides ~1 trillion unique IDs. Most users should leave this at the default. Only affects newly generated UIDs — existing notes are unchanged.')
			.addText(text => text
				.setPlaceholder('8')
				.setValue(String(this.plugin.settings.uidLength ?? 8))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 4 && num <= 26) {
						this.plugin.settings.uidLength = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Debug mode')
			.setDesc('Enable verbose debug logging to the developer console.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugMode ?? false)
				.onChange(async (value) => {
					this.plugin.settings.debugMode = value;
					Logger.setDebugMode(value);
					await this.plugin.saveSettings();
				}));

		// NOTE: The URL scheme ('current' vs 'original') is intentionally not
		// exposed in the UI. It defaults to 'current' and only existed as a
		// dropdown to bridge a one-time migration. Power users can still override
		// it by setting `urlScheme` directly in the plugin's data.json.

		new Setting(containerEl)
			.setName('URL stack window (seconds)')
			.setDesc('When using "Copy link to current note URL" repeatedly, each invocation within this window appends the active note to a growing stacked URL on the clipboard. The window resets on every copy. Only applies under the "Current" URL scheme.')
			.addText(text => text
				.setPlaceholder('10')
				.setValue(String(this.plugin.settings.urlStackWindowSeconds ?? 10))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num >= 1 && num <= 120) {
						this.plugin.settings.urlStackWindowSeconds = num;
						await this.plugin.saveSettings();
					}
				}));

		this.renderParserSettings(containerEl);

		this.renderRoutingSettings(containerEl);

		new Setting(containerEl).setName('Publishing profiles').setHeading();

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

	/**
	 * "Markdown parser" section: the CPN directory field plus a per-stage row for
	 * each built-in stage with open/materialize and reset controls (mirrors
	 * Notor's per-tool settings wiring). Stage edits take effect on next publish.
	 */
	private renderParserSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Markdown parser').setHeading();

		new Setting(containerEl)
			.setName('CPN directory')
			.setDesc('Vault folder for CPN extension files. Parser stages live in <dir>/parsers/. Default: cpn')
			.addText(text => text
				.setPlaceholder('cpn')
				.setValue(this.plugin.settings.cpnDirectory ?? 'cpn')
				.onChange(async (value) => {
					this.plugin.settings.cpnDirectory = value.trim() || 'cpn';
					await this.plugin.saveSettings();
				}));

		const manager = this.plugin.parserExtensionManager;

		// Surface load errors from the most recent publish, if any.
		const loadErrors = manager.getLoadErrors();
		if (loadErrors.length > 0) {
			new Setting(containerEl)
				.setName('Parser extension errors')
				.setDesc(`${loadErrors.length} stage(s) failed to load on the last publish. See the developer console for details.`)
				.setClass('cpn-parser-errors');
		}

		const section = this.createSection(containerEl, 'Built-in stages');
		section.createEl('p', {
			text: 'Each stage can be materialized to your vault and edited. The built-in runs until you override it; deleting the file restores the default. Changes apply on the next publish.',
			cls: 'cpn-settings-hint'
		});

		for (const name of manager.getBuiltinParserNames()) {
			const scaffold = manager.getBuiltinScaffold(name);
			if (!scaffold) continue;
			const exists = manager.builtinVaultFileExists(name);

			const setting = new Setting(section)
				.setName(name)
				.setDesc(`${scaffold.stage} · order ${scaffold.order}${exists ? ' · overridden' : ''} — ${scaffold.description}`);

			// Open (materialize on demand, then open) — mirrors Notor tools.ts.
			setting.addExtraButton(btn => btn
				.setIcon('square-arrow-out-up-right')
				.setTooltip(exists ? 'Open stage definition' : 'Create & open stage definition')
				.onClick(async () => {
					try {
						const path = await manager.ensureBuiltinParserVaultFile(name);
						await this.app.workspace.openLinkText(path, '', true);
						if (!exists) {
							new Notice(`Created ${path} — re-publish to apply.`);
							this.display();
						}
					} catch (e) {
						new Notice(`Failed to create stage file: ${e instanceof Error ? e.message : String(e)}`);
					}
				}));

			// Reset (delete the vault file → fall back to built-in) — only if present.
			if (exists) {
				setting.addExtraButton(btn => btn
					.setIcon('rotate-ccw')
					.setTooltip('Reset to built-in default (deletes the vault file)')
					.onClick(async () => {
						try {
							await manager.resetBuiltinParserToDefault(name);
							new Notice(`Reset "${name}" to built-in default.`);
							this.display();
						} catch (e) {
							new Notice(`Failed to reset stage: ${e instanceof Error ? e.message : String(e)}`);
						}
					}));
			}
		}

		new Setting(section)
			.setName('Export all built-in stages')
			.setDesc('Materialize every built-in stage to the vault at once for tinkering.')
			.addButton(button => button
				.setButtonText('Export all')
				.onClick(async () => {
					try {
						const paths = await manager.exportAllScaffolds();
						new Notice(`Exported ${paths.length} parser stage(s) to ${this.plugin.settings.cpnDirectory ?? 'cpn'}/parsers/`);
						this.display();
					} catch (e) {
						new Notice(`Failed to export stages: ${e instanceof Error ? e.message : String(e)}`);
					}
				}));
	}

	/**
	 * "Note routing" section: the global title-prompt default plus a per-item row
	 * for each built-in routing action and option, with open/materialize and reset
	 * controls. Clones `renderParserSettings`. Definitions load on the next route.
	 */
	private renderRoutingSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName('Note routing').setHeading();

		new Setting(containerEl)
			.setName('Title prompt')
			.setDesc('When routing prompts to (re)name the note. Options can override this. Actions & options live in <cpn-dir>/routes/.')
			.addDropdown(dropdown => dropdown
				.addOption('always', 'Always prompt')
				.addOption('only-if-Untitled', 'Only if named "Untitled…"')
				.addOption('off', 'Never prompt')
				.setValue(this.plugin.settings.routingTitlePrompt ?? 'only-if-Untitled')
				.onChange(async (value) => {
					this.plugin.settings.routingTitlePrompt = value as 'always' | 'only-if-Untitled' | 'off';
					await this.plugin.saveSettings();
				}));

		const manager = this.plugin.routingManager;

		const loadErrors = manager.getLoadErrors();
		if (loadErrors.length > 0) {
			new Setting(containerEl)
				.setName('Routing errors')
				.setDesc(`${loadErrors.length} routing file(s) failed to load on the last run. See the developer console for details.`)
				.setClass('cpn-routing-errors');
		}

		// --- Built-in actions ---
		const actionSection = this.createSection(containerEl, 'Built-in actions');
		actionSection.createEl('p', {
			text: 'Reusable building blocks composed by options. Materialize to your vault to edit; deleting the file restores the default.',
			cls: 'cpn-settings-hint'
		});
		for (const name of manager.getBuiltinActionNames()) {
			const scaffold = manager.getBuiltinActionScaffold(name);
			if (!scaffold) continue;
			const exists = manager.builtinActionFileExists(name);

			const setting = new Setting(actionSection)
				.setName(name)
				.setDesc(`${scaffold.kind}${exists ? ' · overridden' : ''} — ${scaffold.description}`);

			setting.addExtraButton(btn => btn
				.setIcon('square-arrow-out-up-right')
				.setTooltip(exists ? 'Open action definition' : 'Create & open action definition')
				.onClick(async () => {
					try {
						const path = await manager.ensureBuiltinActionVaultFile(name);
						await this.app.workspace.openLinkText(path, '', true);
						if (!exists) this.display();
					} catch (e) {
						new Notice(`Failed to create action file: ${e instanceof Error ? e.message : String(e)}`);
					}
				}));

			if (exists) {
				setting.addExtraButton(btn => btn
					.setIcon('rotate-ccw')
					.setTooltip('Reset to built-in default (deletes the vault file)')
					.onClick(async () => {
						try {
							await manager.resetBuiltinActionToDefault(name);
							new Notice(`Reset "${name}" to built-in default.`);
							this.display();
						} catch (e) {
							new Notice(`Failed to reset action: ${e instanceof Error ? e.message : String(e)}`);
						}
					}));
			}
		}

		// --- Built-in options ---
		const optionSection = this.createSection(containerEl, 'Built-in options');
		optionSection.createEl('p', {
			text: 'The choices shown in the routing suggester. Materialize to your vault to edit or add your own.',
			cls: 'cpn-settings-hint'
		});
		for (const name of manager.getBuiltinOptionNames()) {
			const scaffold = manager.getBuiltinOptionScaffold(name);
			if (!scaffold) continue;
			const exists = manager.builtinOptionFileExists(name);

			const setting = new Setting(optionSection)
				.setName(name)
				.setDesc(`${exists ? 'overridden — ' : ''}${scaffold.description}`);

			setting.addExtraButton(btn => btn
				.setIcon('square-arrow-out-up-right')
				.setTooltip(exists ? 'Open option definition' : 'Create & open option definition')
				.onClick(async () => {
					try {
						const path = await manager.ensureBuiltinOptionVaultFile(name);
						await this.app.workspace.openLinkText(path, '', true);
						if (!exists) this.display();
					} catch (e) {
						new Notice(`Failed to create option file: ${e instanceof Error ? e.message : String(e)}`);
					}
				}));

			if (exists) {
				setting.addExtraButton(btn => btn
					.setIcon('rotate-ccw')
					.setTooltip('Reset to built-in default (deletes the vault file)')
					.onClick(async () => {
						try {
							await manager.resetBuiltinOptionToDefault(name);
							new Notice(`Reset "${name}" to built-in default.`);
							this.display();
						} catch (e) {
							new Notice(`Failed to reset option: ${e instanceof Error ? e.message : String(e)}`);
						}
					}));
			}
		}

		new Setting(optionSection)
			.setName('Export all routing files')
			.setDesc('Materialize every built-in action and option to the vault at once.')
			.addButton(button => button
				.setButtonText('Export all')
				.onClick(async () => {
					try {
						const paths = await manager.exportAllScaffolds();
						new Notice(`Exported ${paths.length} routing file(s) to ${this.plugin.settings.cpnDirectory ?? 'cpn'}/routes/`);
						this.display();
					} catch (e) {
						new Notice(`Failed to export routing files: ${e instanceof Error ? e.message : String(e)}`);
					}
				}));
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

	private createSection(parent: HTMLElement, title: string): HTMLElement {
		const section = parent.createDiv({ cls: 'cpn-settings-section' });
		new Setting(section).setName(title).setHeading();
		return section;
	}

	private displayProfileSettings(containerEl: HTMLElement, profile: PublishingProfile, index: number) {
		const profileContainer = containerEl.createDiv({cls: 'cpn-profile-container'});

		const lastUpdated = profile.lastFullPublishTimestamp ? new Date(profile.lastFullPublishTimestamp).toLocaleString() : 'n/a';
		profileContainer.createEl('div', {
			cls: 'cpn-profile-last-publish',
			text: `Last full publish: ${lastUpdated}`
		});

		// --- Profile Identity ---
		const identitySection = this.createSection(profileContainer, 'Profile Identity');

		new Setting(identitySection)
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

		new Setting(identitySection)
			.setName('Profile ID')
			.setDesc('Unique identifier used in frontmatter')
			.addText(text => text
				.setValue(profile.id)
				.onChange(async (value) => {
					this.plugin.settings.publishingProfiles[index].id = value;
					await this.plugin.saveSettings();
					this.plugin.registerProfileCommands();
				}));

		this.displayIndicatorSettings(identitySection, profile, index);

		// --- Content ---
		const contentSection = this.createSection(profileContainer, 'Content');

		new Setting(contentSection)
			.setName('Home Page')
			.setDesc('Path to the note that should serve as the home page')
			.addText(text => {
				text.setPlaceholder('path/to/home-page.md')
					.setValue(profile.homeNotePath || '')
					.onChange(async (value) => {
						this.plugin.settings.publishingProfiles[index].homeNotePath = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.setAttribute('data-home-input', profile.id);
				return text;
			})
			.addButton(button => button
				.setButtonText('Browse')
				.onClick(async () => {
					const files = await this.plugin.publisher.getAllPublishableNotes(profile.id);
					new HomeNoteSuggestModal(this.app, files, async (file) => {
						this.plugin.settings.publishingProfiles[index].homeNotePath = file.path;
						await this.plugin.saveSettings();
						const input = containerEl.querySelector(`[data-home-input="${profile.id}"]`) as HTMLInputElement | null;
						if (input) input.value = file.path;
					}).open();
				}));

		new Setting(contentSection)
			.setName('Include site-wide content search')
			.setDesc('Choose whether to upload central content index data set to enable search on your published notes')
			.addToggle(toggle => toggle
				.setValue(profile.publishContentIndex ?? false)
				.onChange(async (value) => {
					this.plugin.settings.publishingProfiles[index].publishContentIndex = value;
					await this.plugin.saveSettings();
				}));

		new Setting(contentSection)
			.setName('Obscure wikilinks in published Markdown')
			.setDesc('Replace note paths in wikilinks with UIDs in the published raw Markdown (e.g. [[Note]] → [[UID|Note]]) to keep note titles private. Rendered HTML and search are unaffected. Turn off if your own tooling consumes the raw Markdown and needs literal titles.')
			.addToggle(toggle => toggle
				.setValue(profile.obscureRawWikilinks ?? true)
				.onChange(async (value) => {
					this.plugin.settings.publishingProfiles[index].obscureRawWikilinks = value;
					await this.plugin.saveSettings();
				}));

		new Setting(contentSection)
			.setName('Excluded directories')
			.setDesc('One directory per line (e.g., private/)')
			.addTextArea(text => text
				.setValue(profile.excludedDirectories.join('\n'))
				.onChange(async (value) => {
					this.plugin.settings.publishingProfiles[index].excludedDirectories =
						value.split('\n').filter(line => line.trim() !== '');
					await this.plugin.saveSettings();
				}));

		// --- Destination ---
		const destSection = this.createSection(profileContainer, 'Destination');

		new Setting(destSection)
			.setName('Publish mechanism')
			.addDropdown(dropdown => dropdown
				.addOption('AWS', 'AWS')
				.addOption('Local', 'Local')
				.setValue(profile.publishMechanism)
				.onChange(async (value: 'AWS' | 'Local') => {
					this.plugin.settings.publishingProfiles[index].publishMechanism = value;
					await this.plugin.saveSettings();
					this.renderActiveProfile();
				}));

		new Setting(destSection)
			.setName('Base URL')
			.setDesc('Base URL for published notes')
			.addText(text => text
				.setValue(profile.baseUrl)
				.onChange(async (value) => {
					this.plugin.settings.publishingProfiles[index].baseUrl = value;
					await this.plugin.saveSettings();
				}));

		if (profile.publishMechanism === 'AWS') {
			this.displayAWSDestinationSettings(destSection, profile, index);

			// --- Infrastructure ---
			const infraSection = this.createSection(profileContainer, 'Infrastructure');
			this.displayInfrastructureSettings(infraSection, profile, index);

			// --- Authentication & Delivery ---
			const authSection = this.createSection(profileContainer, 'Authentication & Delivery');
			this.displayAWSAuthSettings(authSection, profile, index);

			// --- Site Customization ---
			const siteSection = this.createSection(profileContainer, 'Site Customization');
			this.displaySiteCustomizationSettings(siteSection, profile, index);
		} else {
			this.displayLocalSettings(destSection, profile, index);
		}

		// --- Danger Zone ---
		const dangerSection = this.createSection(profileContainer, 'Danger Zone');

		this.displayDestroyInfrastructure(dangerSection, profile);
		this.displayForceCleanLeftovers(dangerSection, profile);
		this.displayOrphanedEdgeCleanup(dangerSection, profile);

		const deleteButtonContainer = dangerSection.createDiv({ cls: 'cpn-profile-delete-container' });

		new Setting(deleteButtonContainer)
			.addButton(button => {
				let isConfirmState = false;

				button
					.setButtonText('Delete profile')
					.setClass('mod-warning')
					.onClick(async (evt: MouseEvent) => {
						evt.preventDefault();

						if (!isConfirmState) {
							button.setButtonText('Click again to confirm deletion');
							button.setClass('mod-error');
							isConfirmState = true;

							window.setTimeout(() => {
								if (isConfirmState) {
									button.setButtonText('Delete profile');
									button.setClass('mod-warning');
									isConfirmState = false;
								}
							}, 3000);
						} else {
							profileContainer.addClass('removing');

							window.setTimeout(async () => {
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

	private initAWSSettings(profile: PublishingProfile): void {
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
	}

	private displayAWSDestinationSettings(containerEl: HTMLElement, profile: PublishingProfile, index: number) {
		this.initAWSSettings(profile);

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
						profile.awsSettings.s3Prefix = value ?
							(value.endsWith('/') ? value : `${value}/`) :
							'';
						await this.plugin.saveSettings();
					}
				}));
	}

	private displayAWSAuthSettings(containerEl: HTMLElement, profile: PublishingProfile, index: number) {
		this.initAWSSettings(profile);

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
						this.renderActiveProfile();
					}
				}));

		if (profile.awsSettings!.credentialMode === 'custom-command') {
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
		} else {
			new Setting(containerEl)
				.setName('AWS CLI path (optional)')
				.setDesc('Full path to the aws binary (e.g. /opt/homebrew/bin/aws). Used as a fallback to run "aws sso login" when SDK-native renewal cannot refresh an expired SSO session.')
				.addText(text => text
					.setPlaceholder('/opt/homebrew/bin/aws')
					.setValue(profile.awsSettings?.awsCliPath || '')
					.onChange(async (value) => {
						if (profile.awsSettings) {
							profile.awsSettings.awsCliPath = value;
							await this.plugin.saveSettings();
						}
					}));
		}

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
	}

	private displayInfrastructureSettings(containerEl: HTMLElement, profile: PublishingProfile, index: number) {
		const state = profile.infrastructureState;
		const status = state?.status || 'none';

		const statusLabels: Record<string, string> = {
			'none': 'Not deployed',
			'cert-deploying': 'Deploying certificate...',
			'cert-deployed': 'Certificate deployed',
			'waiting-dns': 'Waiting for DNS validation',
			'deploying': 'Deploying...',
			'deployed': 'Deployed',
			'failed': 'Failed',
			'destroying': 'Destroying...',
		};

		const statusSetting = new Setting(containerEl)
			.setName('Status')
			.setDesc(statusLabels[status] || status);

		const badgeEl = statusSetting.nameEl.createSpan({ cls: 'cpn-infra-status-badge' });
		if (status === 'deployed') badgeEl.addClass('cpn-infra-status-deployed');
		else if (status === 'failed') badgeEl.addClass('cpn-infra-status-failed');
		else if (status === 'none') badgeEl.addClass('cpn-infra-status-none');
		else badgeEl.addClass('cpn-infra-status-pending');

		if (status === 'deployed' && state) {
			if (state.fullStackName) {
				new Setting(containerEl)
					.setName('Stack')
					.setDesc(`${state.fullStackName} (${state.region || 'unknown region'})`);
			}
			if (state.customDomain) {
				new Setting(containerEl)
					.setName('Domain')
					.setDesc(state.customDomain);
			}
			new Setting(containerEl)
				.setName('Origin Access')
				.setDesc(state.originAccessMethod === 'oac' ? 'OAC (Modern)' : 'OAI (Legacy)');

			new Setting(containerEl)
				.setName('Auth Lambda@Edge')
				.setDesc(state.authLambdaEdgeArn || 'Not configured')
				.addButton(btn => btn
					.setButtonText(state.authLambdaEdgeArn ? 'Update' : 'Configure')
					.onClick(() => {
						this.openAuthLambdaModal(profile);
					}));

			// Password read-gate: offer an in-place upgrade to the S3-asset edge
			// packaging (escapes the 4096-byte inline cap and Safari ITP cookie
			// limits). Shown only for password-gated sites.
			if (state.readGateMode === 'password' && state.passwordAuth?.stackName) {
				new Setting(containerEl)
					.setName('Password gate')
					.setDesc('Rebuild the password gate on the latest edge function (S3-asset packaging).')
					.addButton(btn => btn
						.setButtonText('Upgrade')
						.onClick(() => {
							this.openUpgradePasswordGateModal(profile);
						}));
			}

			// Google sign-in: the Cognito Hosted UI URLs the user must register
			// in their Google OAuth client. Persisted from the deploy, shown here
			// (with copy buttons) so they're always retrievable — otherwise the
			// user has no in-plugin way to see what Google needs.
			if (state.cognitoAuth?.hostedUiDomain) {
				const { jsOrigin, redirectUri } = googleOAuthUrls(state.cognitoAuth.hostedUiDomain);
				new Setting(containerEl)
					.setName('Google authorized JavaScript origin')
					.setDesc(jsOrigin)
					.addButton(btn => btn
						.setButtonText('Copy')
						.onClick(() => {
							navigator.clipboard.writeText(jsOrigin);
							new Notice('Copied!');
						}));
				new Setting(containerEl)
					.setName('Google authorized redirect URI')
					.setDesc(redirectUri)
					.addButton(btn => btn
						.setButtonText('Copy')
						.onClick(() => {
							navigator.clipboard.writeText(redirectUri);
							new Notice('Copied!');
						}));

				// Re-sync the Cognito OAuth callback URL to the current site domain.
				// The wizard sets this callback only once, at initial deploy; if the
				// site domain / baseUrl changes afterward (e.g. a custom domain added
				// later), the published sign-in link sends a redirect_uri the app
				// client no longer trusts, and Cognito rejects it with
				// "redirect_mismatch" before ever reaching Google. This button
				// re-points the app client callback (and the callback Lambda's
				// REDIRECT_URI) at baseUrl + /auth/callback, preserving the Google
				// secret via UsePreviousValue.
				if (profile.baseUrl) {
					const callbackUrl = profile.baseUrl.replace(/\/+$/, '') + '/auth/callback';
					new Setting(containerEl)
						.setName('Sync Google sign-in with site domain')
						.setDesc(`Points Cognito's OAuth callback at ${callbackUrl}. `
							+ 'Run this after changing the custom domain or site URL — otherwise '
							+ 'sign-in fails with a "redirect_mismatch" error.')
						.addButton(btn => btn
							.setButtonText('Sync callback URL')
							.onClick(async () => {
								btn.setDisabled(true);
								btn.setButtonText('Syncing...');
								try {
									const cfManager = this.plugin.cloudFormationManager;
									const stackName = cfManager.getStackName(state.variantName || '', 'cognito');
									await cfManager.updateCognitoCallbackUrl(stackName, callbackUrl, profile);
									const finalStatus = await cfManager.pollStackUntilComplete(
										stackName,
										profile,
										() => {},
										'us-east-1',
									);
									if (finalStatus === 'UPDATE_COMPLETE') {
										new Notice(`Google sign-in callback synced to ${callbackUrl}.`);
									} else {
										new Notice(`Stack update ended with status: ${finalStatus}`);
									}
								} catch (err: any) {
									Logger.error('Error syncing Cognito callback URL:', err);
									new Notice(`Sync failed: ${err.message}`);
								} finally {
									btn.setDisabled(false);
									btn.setButtonText('Sync callback URL');
								}
							}));
				}
			}

			// Commenting: the widget only renders on published note pages, so a
			// deployed-but-empty site shows nothing. Point the user at the action
			// that makes comments appear.
			if (profile.commenting?.enabled && state.cognitoAuth?.commentIdentity) {
				new Setting(containerEl)
					.setName('Commenting')
					.setDesc('Enabled. The comment box appears on published note pages — '
						+ 'run "Publish all notes" and open a note to see it.');

				// The commenter [[ ]] note-link autocomplete + rendering is powered
				// by the published content index (see "Include site-wide content
				// search" under Content). Surface that dependency here so it is
				// discoverable from the commenting section.
				new Setting(containerEl)
					.setName('Note links in comments')
					.setDesc(profile.publishContentIndex
						? 'Enabled. Commenters can autocomplete and link to other notes '
							+ 'with [[ ]]; links are stored as note UIDs so they survive renames.'
						: 'Turn on "Include site-wide content search" (under Content) to let '
							+ 'commenters autocomplete and link to other notes with [[ ]]. '
							+ 'Without it, autocomplete is unavailable and existing [[ ]] links '
							+ 'render greyed-out.');

				new Setting(containerEl)
					.setName('Recent comments to load per refresh')
					.setDesc('How many recent comments the Recent Comments panel pulls from DynamoDB '
						+ 'on each refresh. Default 25.')
					.addText(text => text
						.setPlaceholder('25')
						.setValue(String(profile.commentsFeedLimit ?? 25))
						.onChange(async (value) => {
							const num = parseInt(value, 10);
							if (!isNaN(num) && num >= 1 && num <= 200) {
								this.plugin.settings.publishingProfiles[index].commentsFeedLimit = num;
								await this.plugin.saveSettings();
							}
						}));

				if (profile.commentsLastRefreshed) {
					new Setting(containerEl)
						.setName('Recent comments last refreshed')
						.setDesc(new Date(profile.commentsLastRefreshed).toLocaleString());
				}
			}

			if (state.imported) {
				new Setting(containerEl)
					.setDesc('This stack was imported and is managed externally via CDK.');
			}

			new Setting(containerEl)
				.addButton(btn => btn
					.setButtonText('Sync settings from stack')
					.onClick(async () => {
						try {
							const outputs = await this.plugin.cloudFormationManager.getStackOutputs(
								state.fullStackName!,
								profile,
								state.region,
							);
							profile.awsSettings!.bucketName = outputs.bucketName;
							profile.awsSettings!.cloudFrontDistributionId = outputs.distributionId;
							profile.baseUrl = `https://${outputs.siteUrl}/`;
							await this.plugin.saveSettings();
							this.renderActiveProfile();
						} catch (err: any) {
							Logger.error('Error syncing stack outputs:', err);
						}
					}));

			if ((state.status === 'waiting-dns' || state.certificateArn) && !state.certificateReused) {
				// A reused cert is already ISSUED — DNS validation is not applicable.
				new Setting(containerEl)
					.addButton(btn => btn
						.setButtonText('Manage DNS')
						.onClick(() => {
							new DnsAssistantModal(
								this.app,
								this.plugin.cloudFormationManager,
								profile,
							).open();
						}));
			}
		}

		if (status === 'none') {
			new Setting(containerEl)
				.addButton(btn => btn
					.setButtonText('Deploy Infrastructure')
					.setCta()
					.onClick(() => {
						new DeploymentWizardModal(
							this.app,
							this.plugin,
							this.plugin.cloudFormationManager,
							profile,
						).open();
					}));

			new Setting(containerEl)
				.setName('Import existing deployment')
				.setDesc('Scan an AWS account and import your deployed stacks (site, certificate, auth, comments)')
				.addButton(btn => btn
					.setButtonText('Import')
					.onClick(() => {
						this.openImportStackModal(profile);
					}));
		}

		// "Unlink from AWS backend" — clears the (re-derivable) backend link so a
		// profile stuck with a partial/broken link (commonly an old, buggy import)
		// can re-run the import. Unlike Destroy, it makes NO AWS calls and works even
		// for imported stacks (no `imported` guard). Shown for every status once
		// there is actually a link to clear.
		const isLinked =
			status !== 'none' ||
			!!state?.fullStackName ||
			!!state?.certStackName ||
			!!profile.awsSettings?.bucketName ||
			!!profile.awsSettings?.cloudFrontDistributionId;
		if (isLinked) {
			new Setting(containerEl)
				.setName('Unlink from AWS backend')
				.setDesc('Disconnect this profile from its AWS backend without deleting anything in AWS. '
					+ 'Your published site, S3 buckets, CloudFront distribution, and any comments keep running '
					+ '(and keep incurring cost). Local publish history and note mappings are preserved. '
					+ 'Use this to recover from a broken import and re-run the import cleanly.')
				.addButton(button => {
					let isConfirmState = false;

					button
						.setButtonText('Unlink')
						.setClass('mod-warning')
						.onClick(async () => {
							if (!isConfirmState) {
								button.setButtonText('Click again to confirm unlink');
								button.setClass('mod-error');
								isConfirmState = true;

								window.setTimeout(() => {
									if (isConfirmState) {
										button.setButtonText('Unlink');
										button.setClass('mod-warning');
										isConfirmState = false;
									}
								}, 3000);
								return;
							}

							button.setDisabled(true);
							button.setButtonText('Unlinking...');
							try {
								await this.plugin.unlinkInfrastructure(profile);
								new Notice('Profile unlinked from backend. AWS resources were left running — you can now re-import or redeploy.');
								this.renderActiveProfile();
							} catch (err) {
								Logger.error('Error unlinking infrastructure:', err);
								new Notice(`Failed to unlink: ${err instanceof Error ? err.message : String(err)}`);
								button.setDisabled(false);
								button.setButtonText('Unlink');
								button.setClass('mod-warning');
								isConfirmState = false;
							}
						});
					return button;
				});
		}
	}

	/**
	 * Append one CloudFormation event as a styled line in a live event log,
	 * colouring failures red and completions green. Shared by the deploy/destroy/
	 * force-clean flows so the styling logic lives in one place.
	 */
	private appendStackEventLine(logEl: HTMLElement, event: { logicalResourceId: string; status: string }): void {
		const line = logEl.createDiv({ cls: 'cpn-wizard-event-line' });
		if (event.status.includes('FAILED') || event.status.includes('ROLLBACK')) {
			line.addClass('cpn-event-error');
		} else if (event.status.includes('COMPLETE')) {
			line.addClass('cpn-event-success');
		}
		line.setText(`${event.logicalResourceId} - ${event.status}`);
	}

	/**
	 * "Destroy infrastructure" action in the Danger Zone. Only rendered for AWS
	 * profiles with a live, non-imported deployment. On confirm it tears down the
	 * stacks via the shared plugin.destroyInfrastructure(), streaming CloudFormation
	 * events into a live log, then refreshes the profile view.
	 */
	private displayDestroyInfrastructure(containerEl: HTMLElement, profile: PublishingProfile): void {
		if (profile.publishMechanism !== 'AWS') return;
		const state = profile.infrastructureState;
		const status = state?.status || 'none';
		if (!state || status === 'none') return;

		if (state.imported) {
			new Setting(containerEl)
				.setName('Destroy infrastructure')
				.setDesc('This stack was imported and is managed externally via CDK. It cannot be destroyed from the plugin.')
				.addButton(btn => btn.setButtonText('Destroy infrastructure').setDisabled(true));
			return;
		}

		const eventLog = containerEl.createDiv({ cls: 'cpn-wizard-event-log' });
		eventLog.hide();

		new Setting(containerEl)
			.setName('Destroy infrastructure')
			.setDesc('Delete the CloudFormation stacks for this profile. The S3 buckets are retained by default; you can opt to delete them in the confirmation dialog. This cannot be undone.')
			.addButton(button => {
				button
					.setButtonText('Destroy infrastructure')
					.setClass('mod-warning')
					.onClick(async () => {
						const choice = await this.plugin.confirmDestroyInfrastructure(profile);
						if (!choice.confirmed) return;

						button.setDisabled(true);
						button.setButtonText('Destroying...');
						eventLog.empty();
						eventLog.show();

						try {
							const result = await this.plugin.destroyInfrastructure(
								profile,
								{ deleteBuckets: choice.deleteBuckets },
								(event) => {
									this.appendStackEventLine(eventLog, event);
								},
							);
							if (result.fullyDestroyed) {
								new Notice('Infrastructure destroyed.');
							} else {
								new Notice(
									`Some stacks could not be deleted yet (${result.leftoverStacks.join(', ')}). ` +
									'Use "Force-clean leftover infrastructure" below to finish.',
								);
							}
							// Re-render either way: on success the section disappears; on
							// partial teardown the status is now 'failed' and the
							// force-clean action appears.
							this.renderActiveProfile();
						} catch (err) {
							Logger.error('Error destroying infrastructure:', err);
							new Notice(`Failed to destroy infrastructure: ${err instanceof Error ? err.message : String(err)}`);
							button.setDisabled(false);
							button.setButtonText('Destroy infrastructure');
						}
					});
				return button;
			});
	}

	/**
	 * "Force-clean leftover infrastructure" action in the Danger Zone. Shown only
	 * when a prior teardown left stacks behind — i.e. status is 'failed' or
	 * 'destroying' and the profile still references stacks. Force-deletes the stuck
	 * stacks (retaining resources CloudFormation can't remove, e.g. still-replicating
	 * Lambda@Edge fns) and, if the user opts in, empties + removes the retained
	 * fixed-name S3 buckets so a redeploy doesn't collide.
	 */
	private displayForceCleanLeftovers(containerEl: HTMLElement, profile: PublishingProfile): void {
		if (profile.publishMechanism !== 'AWS') return;
		const state = profile.infrastructureState;
		if (!state || state.imported) return;

		const hasStackRefs = !!(
			state.fullStackName ||
			state.certStackName ||
			state.comment?.stackName ||
			state.cognitoAuth?.stackName ||
			state.passwordAuth?.stackName
		);
		// Leftovers are likely after a failed/interrupted teardown. A clean 'none'
		// or a healthy 'deployed' profile should not surface this action.
		const likelyLeftovers = hasStackRefs && (state.status === 'failed' || state.status === 'destroying');
		if (!likelyLeftovers) return;

		const eventLog = containerEl.createDiv({ cls: 'cpn-wizard-event-log' });
		eventLog.hide();

		new Setting(containerEl)
			.setName('Force-clean leftover infrastructure')
			.setDesc('This profile has stacks in a failed or in-progress-teardown state (commonly a Lambda@Edge auth stack whose CloudFront edge replicas take time to clear). Force-delete the remaining stacks so you can redeploy cleanly.')
			.addButton(button => {
				button
					.setButtonText('Force-clean')
					.setClass('mod-warning')
					.onClick(async () => {
						const choice = await this.confirmForceClean(profile);
						if (!choice.confirmed) return;

						button.setDisabled(true);
						button.setButtonText('Cleaning...');
						eventLog.empty();
						eventLog.show();

						try {
							const result = await this.plugin.forceCleanInfrastructure(
								profile,
								{ deleteBuckets: choice.deleteBuckets },
								(event) => {
									this.appendStackEventLine(eventLog, event);
								},
							);
							// When edge resources were orphaned to drain a stuck stack, they
							// linger in AWS until CloudFront removes their replicas; the
							// plugin retries their deletion in the background (and via the
							// "Clean up orphaned edge resources" button).
							const orphanNote = result.orphanedEdgeCount > 0
								? ` ${result.orphanedEdgeCount} Lambda@Edge resource(s) were orphaned and will be cleaned up automatically once CloudFront removes their replicas (may take a few hours).`
								: '';
							if (result.fullyCleaned) {
								new Notice('Leftover infrastructure cleaned. You can now redeploy.' + orphanNote);
							} else {
								new Notice(
									`Some stacks still could not be deleted (${result.leftoverStacks.join(', ')}). ` +
									'Lambda@Edge replicas can take up to a few hours to clear — try again later.' + orphanNote,
								);
							}
							this.renderActiveProfile();
						} catch (err) {
							Logger.error('Error force-cleaning infrastructure:', err);
							new Notice(`Force-clean failed: ${err instanceof Error ? err.message : String(err)}`);
							button.setDisabled(false);
							button.setButtonText('Force-clean');
						}
					});
				return button;
			});
	}

	/**
	 * "Clean up orphaned edge resources" action in the Danger Zone. Shown only when a
	 * prior force-clean orphaned Lambda@Edge resources (retained to drain a stuck
	 * stack) that are awaiting deletion. Deletion can only succeed once CloudFront has
	 * removed the replicas (up to a few hours); the plugin also retries automatically
	 * on load, so this button is a manual nudge.
	 */
	private displayOrphanedEdgeCleanup(containerEl: HTMLElement, profile: PublishingProfile): void {
		if (profile.publishMechanism !== 'AWS') return;
		const pending = profile.pendingEdgeCleanup;
		if (!pending || pending.length === 0) return;

		const count = pending.reduce(
			(n, e) => n + (e.functionName ? 1 : 0) + (e.roleName ? 1 : 0),
			0,
		);

		new Setting(containerEl)
			.setName(`Clean up orphaned edge resources (${count} pending)`)
			.setDesc('A force-clean orphaned these Lambda@Edge resources so a stuck stack could be removed. They can only be deleted once CloudFront finishes removing their edge replicas (up to a few hours). The plugin retries automatically on load; use this to retry now.')
			.addButton(button => {
				button
					.setButtonText('Clean up now')
					.setClass('mod-warning')
					.onClick(async () => {
						button.setDisabled(true);
						button.setButtonText('Cleaning...');
						try {
							const result = await this.plugin.cleanupOrphanedEdgeResources(profile);
							if (result.stillPending === 0) {
								new Notice('Orphaned edge resources cleaned up.');
							} else {
								new Notice(
									`Cleaned ${result.cleaned}; ${result.stillPending} still replicating. ` +
									'CloudFront can take a few hours to remove edge replicas — try again later.',
								);
							}
							this.renderActiveProfile();
						} catch (err) {
							Logger.error('Error cleaning orphaned edge resources:', err);
							new Notice(`Cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
							button.setDisabled(false);
							button.setButtonText('Clean up now');
						}
					});
				return button;
			});
	}

	/**
	 * Confirm dialog for force-clean, with an opt-in "also delete S3 data" toggle
	 * (default OFF). Resolves { confirmed, deleteBuckets }.
	 */
	private confirmForceClean(profile: PublishingProfile): Promise<{ confirmed: boolean; deleteBuckets: boolean }> {
		return new Promise(resolve => {
			const modal = new Modal(this.app);
			let deleteBuckets = false;
			let settled = false;
			const finish = (confirmed: boolean) => {
				if (settled) return;
				settled = true;
				resolve({ confirmed, deleteBuckets });
				modal.close();
			};

			modal.onOpen = () => {
				modal.titleEl.setText('Force-clean leftover infrastructure');
				modal.contentEl.createEl('p', {
					text: `This force-deletes the remaining CloudFormation stacks for profile "${profile.name}", orphaning any resources AWS can't remove yet (e.g. replicating Lambda@Edge functions — AWS cleans those up later). This cannot be undone.`,
				});

				new Setting(modal.contentEl)
					.setName('Also delete S3 data (published content + comments)')
					.setDesc('Empty and remove the retained S3 buckets. This permanently deletes your published site content and any stored comments. Leave off to keep the buckets and their data.')
					.addToggle(toggle => toggle
						.setValue(false)
						.onChange(v => { deleteBuckets = v; }));

				new Setting(modal.contentEl)
					.addButton(btn => btn.setButtonText('Cancel').onClick(() => finish(false)))
					.addButton(btn => btn.setButtonText('Force-clean').setWarning().onClick(() => finish(true)));
			};
			modal.onClose = () => finish(false);
			modal.open();
		});
	}

	private openImportStackModal(profile: PublishingProfile): void {
		this.initAWSSettings(profile);
		new ImportStackModal(
			this.app,
			this.plugin,
			this.plugin.cloudFormationManager,
			profile,
			() => this.renderActiveProfile(),
		).open();
	}

	private openAuthLambdaModal(profile: PublishingProfile): void {
		const state = profile.infrastructureState;
		if (!state || !profile.awsSettings) return;

		const modal = new Modal(this.app);
		let arnValue = state.authLambdaEdgeArn || '';

		modal.onOpen = () => {
			modal.titleEl.setText('Update Auth Lambda@Edge');

			modal.contentEl.createEl('p', {
				text: 'Provide the ARN of a Lambda@Edge viewer-request function to gate this site behind authentication. Leave empty to remove authentication.',
				cls: 'cpn-wizard-description',
			});

			new Setting(modal.contentEl)
				.setName('Lambda@Edge ARN')
				.setDesc('Must be a versioned ARN in us-east-1')
				.addText(text => text
					.setValue(arnValue)
					.setPlaceholder('arn:aws:lambda:us-east-1:...:function:name:version')
					.onChange(v => { arnValue = v; }));

			const statusEl = modal.contentEl.createDiv();

			new Setting(modal.contentEl)
				.addButton(btn => btn
					.setButtonText('Cancel')
					.onClick(() => modal.close()))
				.addButton(btn => btn
					.setButtonText('Update Stack')
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						btn.setButtonText('Updating...');
						statusEl.empty();
						try {
							// Targeted update: change ONLY the auth ARN and inherit every
							// other parameter via UsePreviousValue. Rebuilding the full
							// parameter set from this partial config would blank the
							// comment/auth domain params and prune the /auth/*, /comments/*
							// and /api/comments routes off a working site.
							await this.plugin.cloudFormationManager.updateFullStackAuthLambda(
								state.fullStackName!,
								state.originAccessMethod,
								arnValue,
								profile,
								state.region,
							);

							const finalStatus = await this.plugin.cloudFormationManager.pollStackUntilComplete(
								state.fullStackName!,
								profile,
								(event) => {
									const line = statusEl.createDiv({ cls: 'cpn-wizard-event-line' });
									if (event.status.includes('FAILED') || event.status.includes('ROLLBACK')) {
										line.addClass('cpn-event-error');
									} else if (event.status.includes('COMPLETE')) {
										line.addClass('cpn-event-success');
									}
									line.setText(`${event.logicalResourceId} - ${event.status}`);
								},
								state.region,
							);

							if (finalStatus === 'UPDATE_COMPLETE') {
								state.authLambdaEdgeArn = arnValue || undefined;
								await this.plugin.saveSettings();
								modal.close();
								this.renderActiveProfile();
								new Notice('Infrastructure updated successfully.');
							} else {
								new Notice(`Stack update ended with status: ${finalStatus}`);
								btn.setDisabled(false);
								btn.setButtonText('Update Stack');
							}
						} catch (err: any) {
							Logger.error('Error updating auth lambda:', err);
							new Notice(`Update failed: ${err.message}`);
							btn.setDisabled(false);
							btn.setButtonText('Update Stack');
						}
					}));
		};

		modal.open();
	}

	/**
	 * Rebuild the password read-gate on the current (S3-asset) edge packaging.
	 * Delete-and-recreate the cpn-password-<variant> stack (it owns only the edge
	 * fn + role + version — no stateful data), then re-point the site's
	 * AuthLambdaEdgeArn at the new version. Migrates sites deployed on the old
	 * inline template shape and lets any site pick up new edge code.
	 *
	 * The password is re-entered here: it's needed to bake the sha256 hash into
	 * the uploaded zip, and imported sites don't have the hash persisted.
	 */
	private openUpgradePasswordGateModal(profile: PublishingProfile): void {
		const state = profile.infrastructureState;
		if (!state || !profile.awsSettings) return;

		const modal = new Modal(this.app);
		let passwordValue = '';

		modal.onOpen = () => {
			modal.titleEl.setText('Upgrade password gate');

			modal.contentEl.createEl('p', {
				text: 'Rebuilds the password gate on the latest edge function. Re-enter the site password so it can be baked into the new function package. The gate stays active throughout; readers already holding a valid session are unaffected.',
				cls: 'cpn-wizard-description',
			});

			new Setting(modal.contentEl)
				.setName('Password')
				.setDesc('The shared read password for this site')
				.addText(text => {
					text.inputEl.type = 'password';
					text
						.setPlaceholder('Enter the site password')
						.onChange(v => { passwordValue = v; });
				});

			const statusEl = modal.contentEl.createDiv();

			new Setting(modal.contentEl)
				.addButton(btn => btn
					.setButtonText('Cancel')
					.onClick(() => modal.close()))
				.addButton(btn => btn
					.setButtonText('Upgrade')
					.setCta()
					.onClick(async () => {
						if (!passwordValue) {
							new Notice('Enter the site password to continue.');
							return;
						}
						btn.setDisabled(true);
						btn.setButtonText('Upgrading...');
						statusEl.empty();
						const cfm = this.plugin.cloudFormationManager;
						const onEvent = (event: { logicalResourceId: string; status: string }) => {
							const line = statusEl.createDiv({ cls: 'cpn-wizard-event-line' });
							if (event.status.includes('FAILED') || event.status.includes('ROLLBACK')) {
								line.addClass('cpn-event-error');
							} else if (event.status.includes('COMPLETE')) {
								line.addClass('cpn-event-success');
							}
							line.setText(`${event.logicalResourceId} - ${event.status}`);
						};
						try {
							const variantName = state.variantName || '';
							const config: DeploymentConfig = {
								profileId: profile.id,
								variantName,
								s3Prefix: profile.awsSettings!.s3Prefix || '',
								customDomain: state.customDomain || '',
								useRoute53: state.useRoute53,
								hostedZoneId: state.hostedZoneId || '',
								hostedZoneName: state.hostedZoneName || '',
								region: state.region || profile.awsSettings!.region,
								awsProfile: profile.awsSettings!.awsProfile,
								originAccessMethod: state.originAccessMethod,
								readGateMode: 'password',
								passwordHash: await sha256Hex(passwordValue),
							};

							// Delete-and-recreate the password stack so the template-shape
							// change (PasswordHash/Realm params -> AssetsBucket/AssetsKey)
							// is unambiguous. The stack owns no stateful data.
							const pwStackName = cfm.getStackName(variantName, 'password');
							await cfm.forceDeleteStack(pwStackName, profile, 'us-east-1', onEvent);

							const recreated = await cfm.deployPasswordAuthStack(config, profile, onEvent);
							const pwStatus = await cfm.pollStackUntilComplete(recreated, profile, onEvent, 'us-east-1');
							if (pwStatus !== 'CREATE_COMPLETE') {
								throw new Error(`Password stack recreation ended with status: ${pwStatus}`);
							}
							const { edgeFunctionVersionArn } = await cfm.getPasswordAuthOutputs(recreated, profile);

							// Re-point the site distribution at the new edge version.
							await cfm.updateFullStackAuthLambda(
								state.fullStackName!,
								state.originAccessMethod,
								edgeFunctionVersionArn,
								profile,
								state.region,
							);
							const fullStatus = await cfm.pollStackUntilComplete(
								state.fullStackName!, profile, onEvent, state.region,
							);
							if (fullStatus !== 'UPDATE_COMPLETE') {
								throw new Error(`Site update ended with status: ${fullStatus}`);
							}

							state.authLambdaEdgeArn = edgeFunctionVersionArn;
							state.passwordAuth = {
								stackName: recreated,
								edgeFunctionVersionArn,
								passwordHash: config.passwordHash,
							};
							profile.readGate = { mode: 'password', passwordHash: config.passwordHash };
							await this.plugin.saveSettings();
							modal.close();
							this.renderActiveProfile();
							new Notice('Password gate upgraded successfully.');
						} catch (err: any) {
							Logger.error('Error upgrading password gate:', err);
							new Notice(`Upgrade failed: ${err.message}`);
							btn.setDisabled(false);
							btn.setButtonText('Upgrade');
						}
					}));
		};

		modal.open();
	}

	private displaySiteCustomizationSettings(containerEl: HTMLElement, profile: PublishingProfile, index: number) {
		const custom = profile.siteCustomization ?? {
			siteTitle: '',
			headerLinks: [],
			panelWidth: 600,
			fontFamily: '',
			themeOverrides: {},
		};

		new Setting(containerEl)
			.setName('Push site assets')
			.setDesc('Upload index.html, styles, scripts, and config to S3 without re-publishing notes')
			.addButton(button => button
				.setButtonText('Push site assets')
				.onClick(async () => {
					button.setDisabled(true);
					button.setButtonText('Pushing...');
					const success = await pushSiteAssetsToS3(this.plugin, profile.id);
					if (success) {
						await createCloudFrontInvalidation(this.plugin, profile.id);
					}
					button.setDisabled(false);
					button.setButtonText('Push site assets');
				}));

		new Setting(containerEl)
			.setName('Site title')
			.setDesc('Displayed in the browser tab')
			.addText(text => text
				.setPlaceholder('Notes')
				.setValue(custom.siteTitle)
				.onChange(async (value) => {
					this.ensureSiteCustomization(index).siteTitle = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Font family')
			.setDesc('CSS font-family value for the site body')
			.addText(text => text
				.setPlaceholder('"Helvetica Neue", Arial, sans-serif')
				.setValue(custom.fontFamily)
				.onChange(async (value) => {
					this.ensureSiteCustomization(index).fontFamily = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Panel width')
			.setDesc('Width of note panels in pixels')
			.addText(text => text
				.setPlaceholder('600')
				.setValue(custom.panelWidth ? String(custom.panelWidth) : '')
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num > 0) {
						this.ensureSiteCustomization(index).panelWidth = num;
						await this.plugin.saveSettings();
					}
				}));

		// Header links
		const linksContainer = containerEl.createDiv({ cls: 'cpn-header-links-container' });
		new Setting(linksContainer)
			.setName('Header links')
			.setDesc('Additional navigation links in the site header');

		for (let i = 0; i < custom.headerLinks.length; i++) {
			const link = custom.headerLinks[i];
			new Setting(linksContainer)
				.addText(text => text
					.setPlaceholder('Label')
					.setValue(link.label)
					.onChange(async (value) => {
						this.ensureSiteCustomization(index).headerLinks[i].label = value;
						await this.plugin.saveSettings();
					}))
				.addText(text => text
					.setPlaceholder('URL')
					.setValue(link.url)
					.onChange(async (value) => {
						this.ensureSiteCustomization(index).headerLinks[i].url = value;
						await this.plugin.saveSettings();
					}))
				.addButton(button => button
					.setButtonText('Remove')
					.onClick(async () => {
						this.ensureSiteCustomization(index).headerLinks.splice(i, 1);
						await this.plugin.saveSettings();
						this.renderActiveProfile();
					}));
		}

		new Setting(linksContainer)
			.addButton(button => button
				.setButtonText('Add link')
				.onClick(async () => {
					this.ensureSiteCustomization(index).headerLinks.push({ label: '', url: '' });
					await this.plugin.saveSettings();
					this.renderActiveProfile();
				}));

		// Theme overrides
		const themeContainer = containerEl.createDiv({ cls: 'cpn-theme-overrides-container' });
		const themeDetails = themeContainer.createEl('details');
		themeDetails.createEl('summary', { text: 'Theme color overrides' });

		const lightSection = themeDetails.createDiv();
		new Setting(lightSection).setName('Light mode').setHeading();
		this.displayThemeColorInputs(lightSection, 'light', custom.themeOverrides.light ?? {},
			() => this.ensureSiteCustomization(index).themeOverrides);

		const darkSection = themeDetails.createDiv();
		new Setting(darkSection).setName('Dark mode').setHeading();
		this.displayThemeColorInputs(darkSection, 'dark', custom.themeOverrides.dark ?? {},
			() => this.ensureSiteCustomization(index).themeOverrides);

		// Named styles (per-note; referenced by the `cpn-style` frontmatter value)
		this.displayNamedStylesSettings(containerEl, custom, index);
	}

	/**
	 * Per-profile "Named styles" editor. Each entry maps a style name (the value
	 * a note puts in `cpn-style`) to scoped light/dark color overrides + an
	 * optional font. Overrides layer on top of the global theme on the published
	 * site; a note naming an undefined style falls back to default styling.
	 */
	private displayNamedStylesSettings(containerEl: HTMLElement, custom: SiteCustomization, index: number) {
		const stylesContainer = containerEl.createDiv({ cls: 'cpn-named-styles-container' });
		const stylesDetails = stylesContainer.createEl('details');
		stylesDetails.createEl('summary', { text: 'Named styles (per-note)' });
		stylesDetails.createEl('p', {
			text: 'Define styles a note can select via the "cpn-style" frontmatter property. Overrides layer on top of the site theme; unknown names fall back to default styling.',
			cls: 'setting-item-description',
		});

		const namedStyles = custom.namedStyles ?? {};
		const names = Object.keys(namedStyles);

		for (const name of names) {
			const style = namedStyles[name];
			const styleSection = stylesDetails.createDiv({ cls: 'cpn-named-style' });

			// Style name (rekeys the record on change). `currentName` tracks the
			// live key so color/font/remove handlers keep targeting this entry
			// even after a rename, without a full re-render on every keystroke.
			let currentName = name;
			new Setting(styleSection)
				.setName('Style name')
				.setDesc('Used as the cpn-style value')
				.addText(text => text
					.setPlaceholder('e.g. ai')
					.setValue(currentName)
					.onChange(async (value) => {
						const next = value.trim();
						const styles = this.ensureNamedStyles(index);
						// Ignore empty or colliding names (can't be referenced / would clobber).
						if (!next || (next !== currentName && styles[next] !== undefined)) {
							return;
						}
						const existing = styles[currentName] ?? {};
						delete styles[currentName];
						styles[next] = existing;
						currentName = next;
						await this.plugin.saveSettings();
					}))
				.addButton(button => button
					.setButtonText('Remove')
					.setWarning()
					.onClick(async () => {
						delete this.ensureNamedStyles(index)[currentName];
						await this.plugin.saveSettings();
						this.renderActiveProfile();
					}));

			new Setting(styleSection)
				.setName('Font family')
				.setDesc('Optional CSS font-family for notes using this style')
				.addText(text => text
					.setPlaceholder('inherit')
					.setValue(style.fontFamily ?? '')
					.onChange(async (value) => {
						const target = this.ensureNamedStyle(index, currentName);
						const trimmed = value.trim();
						if (trimmed) {
							target.fontFamily = trimmed;
						} else {
							delete target.fontFamily;
						}
						await this.plugin.saveSettings();
					}));

			const lightSection = styleSection.createDiv();
			new Setting(lightSection).setName('Light mode').setHeading();
			this.displayThemeColorInputs(lightSection, 'light', style.light ?? {},
				() => this.ensureNamedStyle(index, currentName));

			const darkSection = styleSection.createDiv();
			new Setting(darkSection).setName('Dark mode').setHeading();
			this.displayThemeColorInputs(darkSection, 'dark', style.dark ?? {},
				() => this.ensureNamedStyle(index, currentName));
		}

		new Setting(stylesDetails)
			.addButton(button => button
				.setButtonText('Add style')
				.onClick(async () => {
					const styles = this.ensureNamedStyles(index);
					// Mint a unique placeholder key so the new row is editable immediately.
					let n = 1;
					let name = 'style';
					while (styles[name] !== undefined) {
						name = `style-${++n}`;
					}
					styles[name] = {};
					await this.plugin.saveSettings();
					this.renderActiveProfile();
				}));
	}

	private ensureNamedStyles(index: number): Record<string, NamedStyle> {
		const custom = this.ensureSiteCustomization(index);
		if (!custom.namedStyles) {
			custom.namedStyles = {};
		}
		return custom.namedStyles;
	}

	private ensureNamedStyle(index: number, name: string): NamedStyle {
		const styles = this.ensureNamedStyles(index);
		if (!styles[name]) {
			styles[name] = {};
		}
		return styles[name];
	}

	/**
	 * Render the five light/dark color inputs for a theme-colors target. Shared
	 * by the global site theme (`themeOverrides`) and per-note named styles — both
	 * expose a `{ light?; dark? }` container, supplied lazily via `ensureTarget`
	 * so each onChange mutates the current object (which may be created on demand).
	 */
	private displayThemeColorInputs(
		containerEl: HTMLElement,
		mode: 'light' | 'dark',
		colors: ThemeColors,
		ensureTarget: () => { light?: ThemeColors; dark?: ThemeColors }
	) {
		const defaults: Record<'light' | 'dark', Record<string, string>> = {
			light: {
				bgPrimary: '#ffffff',
				bgSecondary: '#f6f8fa',
				textPrimary: '#24292e',
				linkColor: '#0366d6',
				borderColor: '#dddddd',
			},
			dark: {
				bgPrimary: '#0d1117',
				bgSecondary: '#161b22',
				textPrimary: '#e6edf3',
				linkColor: '#58a6ff',
				borderColor: '#30363d',
			},
		};

		const fields: { name: string; key: keyof ThemeColors }[] = [
			{ name: 'Background (primary)', key: 'bgPrimary' },
			{ name: 'Background (secondary)', key: 'bgSecondary' },
			{ name: 'Text color', key: 'textPrimary' },
			{ name: 'Link color', key: 'linkColor' },
			{ name: 'Border color', key: 'borderColor' },
		];

		for (const field of fields) {
			const defaultColor = defaults[mode][field.key];
			new Setting(containerEl)
				.setName(field.name)
				.addText(text => {
					text.inputEl.type = 'color';
					text.inputEl.addClass('cpn-color-input');
					text.setValue(colors[field.key] || defaultColor)
						.onChange(async (value) => {
							const target = ensureTarget();
							if (!target[mode]) {
								target[mode] = {};
							}
							target[mode]![field.key] = value;
							await this.plugin.saveSettings();
						});
					return text;
				})
				.addButton(button => button
					.setButtonText('Reset')
					.onClick(async () => {
						const target = ensureTarget();
						if (target[mode]) {
							delete target[mode]![field.key];
						}
						await this.plugin.saveSettings();
						const colorInput = button.buttonEl.parentElement?.querySelector('input[type="color"]') as HTMLInputElement | null;
						if (colorInput) {
							colorInput.value = defaultColor;
						}
					}));
		}
	}

	private ensureSiteCustomization(index: number): SiteCustomization {
		const profile = this.plugin.settings.publishingProfiles[index];
		if (!profile.siteCustomization) {
			profile.siteCustomization = {
				siteTitle: '',
				headerLinks: [],
				panelWidth: 600,
				fontFamily: '',
				themeOverrides: {},
			};
		}
		return profile.siteCustomization;
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