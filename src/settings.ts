import { App, DropdownComponent, Modal, Notice, PluginSettingTab, Setting, SuggestModal, TFile } from 'obsidian';
import CommonplaceNotesPlugin from './main';
import { PublishingProfile, IndicatorStyle, SiteCustomization, HeaderLink } from './types';
import { Logger } from './utils/logging';
import { DeploymentWizardModal } from './infrastructure/deploymentWizardModal';
import { DnsAssistantModal } from './infrastructure/dnsAssistantModal';
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
		containerEl.createEl('h2', {text: 'General'});

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

		new Setting(containerEl)
			.setName('URL scheme')
			.setDesc('Format used when generating note links. "Current" produces #/uABC123; "Original" produces #u=ABC123. Parsing always accepts both.')
			.addDropdown(dropdown => dropdown
				.addOption('current', 'Current (#/uABC123)')
				.addOption('original', 'Original (#u=ABC123)')
				.setValue(this.plugin.settings.urlScheme ?? 'current')
				.onChange(async (value: 'current' | 'original') => {
					this.plugin.settings.urlScheme = value;
					await this.plugin.saveSettings();
				}));

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

	/**
	 * "Markdown parser" section: the CPN directory field plus a per-stage row for
	 * each built-in stage with open/materialize and reset controls (mirrors
	 * Notor's per-tool settings wiring). Stage edits take effect on next publish.
	 */
	private renderParserSettings(containerEl: HTMLElement): void {
		containerEl.createEl('h2', { text: 'Markdown parser' });

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
		section.createEl('h4', { text: title, cls: 'cpn-settings-section-heading' });
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

							setTimeout(() => {
								if (isConfirmState) {
									button.setButtonText('Delete profile');
									button.setClass('mod-warning');
									isConfirmState = false;
								}
							}, 3000);
						} else {
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

		if (profile.awsSettings!.awsCliPath) {
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

			if (profile.awsSettings?.bucketName && profile.awsSettings?.cloudFrontDistributionId) {
				new Setting(containerEl)
					.setName('Import existing stack')
					.setDesc('Import a stack deployed via CDK to track it here')
					.addButton(btn => btn
						.setButtonText('Import')
						.onClick(() => {
							this.openImportStackModal(profile);
						}));
			}
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
							if (result.fullyCleaned) {
								new Notice('Leftover infrastructure cleaned. You can now redeploy.');
							} else {
								new Notice(
									`Some stacks still could not be deleted (${result.leftoverStacks.join(', ')}). ` +
									'Lambda@Edge replicas can take up to a few hours to clear — try again later.',
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
		const modal = new Modal(this.app);
		let stackName = 'PublishedCommonplaceNotesStack';
		let region = profile.awsSettings?.region || 'us-east-1';

		modal.onOpen = () => {
			modal.titleEl.setText('Import Existing Stack');

			new Setting(modal.contentEl)
				.setName('Stack name')
				.setDesc('The CloudFormation stack name to import')
				.addText(text => text
					.setValue(stackName)
					.onChange(v => { stackName = v; }));

			new Setting(modal.contentEl)
				.setName('Region')
				.setDesc('AWS region where the stack is deployed')
				.addText(text => text
					.setValue(region)
					.onChange(v => { region = v; }));

			new Setting(modal.contentEl)
				.addButton(btn => btn
					.setButtonText('Cancel')
					.onClick(() => modal.close()))
				.addButton(btn => btn
					.setButtonText('Import')
					.setCta()
					.onClick(async () => {
						if (!stackName || !region) {
							new Notice('Stack name and region are required.');
							return;
						}
						try {
							const outputs = await this.plugin.cloudFormationManager.importStack(stackName, profile, region);
							profile.infrastructureState = {
								status: 'deployed',
								imported: true,
								fullStackName: stackName,
								region,
								useRoute53: false,
								originAccessMethod: 'oai',
							};
							profile.awsSettings!.bucketName = outputs.bucketName;
							profile.awsSettings!.cloudFrontDistributionId = outputs.distributionId;
							profile.baseUrl = `https://${outputs.siteUrl}/`;
							await this.plugin.saveSettings();
							modal.close();
							this.renderActiveProfile();
							new Notice('Stack imported successfully.');
						} catch (err: any) {
							Logger.error('Error importing stack:', err);
							new Notice(`Import failed: ${err.message}`);
						}
					}));
		};

		modal.open();
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
		lightSection.createEl('h5', { text: 'Light mode' });
		this.displayThemeColorInputs(lightSection, 'light', custom, index);

		const darkSection = themeDetails.createDiv();
		darkSection.createEl('h5', { text: 'Dark mode' });
		this.displayThemeColorInputs(darkSection, 'dark', custom, index);
	}

	private displayThemeColorInputs(
		containerEl: HTMLElement,
		mode: 'light' | 'dark',
		custom: SiteCustomization,
		index: number
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

		const colors = custom.themeOverrides[mode] ?? {};
		const fields: { name: string; key: keyof typeof colors }[] = [
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
					text.inputEl.style.width = '50px';
					text.setValue(colors[field.key] || defaultColor)
						.onChange(async (value) => {
							const siteCustom = this.ensureSiteCustomization(index);
							if (!siteCustom.themeOverrides[mode]) {
								siteCustom.themeOverrides[mode] = {};
							}
							siteCustom.themeOverrides[mode]![field.key] = value;
							await this.plugin.saveSettings();
						});
					return text;
				})
				.addButton(button => button
					.setButtonText('Reset')
					.onClick(async () => {
						const siteCustom = this.ensureSiteCustomization(index);
						if (siteCustom.themeOverrides[mode]) {
							delete siteCustom.themeOverrides[mode]![field.key];
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