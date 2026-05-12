import { App, Modal, Setting, Notice } from 'obsidian';
import type CommonplaceNotesPlugin from '../main';
import type { PublishingProfile } from '../types';
import type { CloudFormationManager } from './cloudFormationManager';
import type { DeploymentConfig, HostedZoneInfo, OriginAccessMethod, StackEvent, StackOutputs } from './types';

type WizardStep = 1 | 2 | 3 | 4 | 5;

export class DeploymentWizardModal extends Modal {
	private plugin: CommonplaceNotesPlugin;
	private cfManager: CloudFormationManager;
	private profile: PublishingProfile;
	private step: WizardStep = 1;
	private config: Partial<DeploymentConfig> = {};
	private certArn: string = '';
	private stackOutputs: StackOutputs | null = null;
	private aborted = false;

	constructor(app: App, plugin: CommonplaceNotesPlugin, cfManager: CloudFormationManager, profile: PublishingProfile) {
		super(app);
		this.plugin = plugin;
		this.cfManager = cfManager;
		this.profile = profile;

		this.config = {
			profileId: profile.id,
			region: profile.awsSettings?.region || 'us-east-1',
			awsProfile: profile.awsSettings?.awsProfile || 'default',
			s3Prefix: profile.awsSettings?.s3Prefix || '',
			variantName: '',
			customDomain: '',
			useRoute53: false,
			hostedZoneId: '',
			hostedZoneName: '',
			originAccessMethod: 'oac',
		};
	}

	onOpen(): void {
		this.modalEl.addClass('cpn-wizard-modal');
		this.renderStep();
	}

	onClose(): void {
		this.aborted = true;
		this.contentEl.empty();
	}

	private renderStep(): void {
		this.contentEl.empty();
		this.renderStepIndicator();

		switch (this.step) {
			case 1: this.renderStep1Configure(); break;
			case 2: this.renderStep2DeployCert(); break;
			case 3: this.renderStep3DnsValidation(); break;
			case 4: this.renderStep4DeployFull(); break;
			case 5: this.renderStep5Complete(); break;
		}
	}

	private renderStepIndicator(): void {
		const indicator = this.contentEl.createDiv({ cls: 'cpn-wizard-step-indicator' });
		const steps = ['Configure', 'Certificate', 'DNS', 'Deploy', 'Complete'];
		for (let i = 0; i < steps.length; i++) {
			const dot = indicator.createSpan({ cls: 'cpn-wizard-step-dot' });
			if (i + 1 === this.step) dot.addClass('cpn-wizard-step-active');
			if (i + 1 < this.step) dot.addClass('cpn-wizard-step-done');
			dot.setText(steps[i]);
		}
	}

	private renderStep1Configure(): void {
		const container = this.contentEl.createDiv({ cls: 'cpn-wizard-step' });
		container.createEl('h2', { text: 'Configure Infrastructure' });
		container.createEl('p', {
			text: 'Configure the AWS infrastructure for publishing. This will create an S3 bucket and CloudFront distribution.',
			cls: 'cpn-wizard-description',
		});

		new Setting(container)
			.setName('AWS Profile')
			.setDesc('The AWS CLI profile to use for deployment')
			.addText(text => text
				.setValue(this.config.awsProfile || '')
				.onChange(v => { this.config.awsProfile = v; }));

		new Setting(container)
			.setName('Region')
			.setDesc('AWS region for the S3 bucket and CloudFront distribution')
			.addText(text => text
				.setValue(this.config.region || '')
				.onChange(v => { this.config.region = v; }));

		new Setting(container)
			.setName('Variant Name')
			.setDesc('Optional name for multi-instance deployments (e.g., "personal", "work")')
			.addText(text => text
				.setValue(this.config.variantName || '')
				.setPlaceholder('default')
				.onChange(v => { this.config.variantName = v; }));

		new Setting(container)
			.setName('S3 Prefix')
			.setDesc('Optional path prefix within the bucket')
			.addText(text => text
				.setValue(this.config.s3Prefix || '')
				.setPlaceholder('/')
				.onChange(v => { this.config.s3Prefix = v; }));

		new Setting(container)
			.setName('Origin Access Method')
			.setDesc('OAC is recommended (modern). OAI is legacy but compatible with existing stacks.')
			.addDropdown(dd => dd
				.addOption('oac', 'OAC (Recommended)')
				.addOption('oai', 'OAI (Legacy)')
				.setValue(this.config.originAccessMethod || 'oac')
				.onChange(v => { this.config.originAccessMethod = v as OriginAccessMethod; }));

		new Setting(container)
			.setName('Custom Domain')
			.setDesc('Optional custom domain (requires ACM certificate)')
			.addText(text => text
				.setValue(this.config.customDomain || '')
				.setPlaceholder('notes.example.com')
				.onChange(v => { this.config.customDomain = v; }));

		new Setting(container)
			.setName('Use Route53')
			.setDesc('Automatically create DNS records via Route53')
			.addToggle(toggle => toggle
				.setValue(this.config.useRoute53 || false)
				.onChange(v => {
					this.config.useRoute53 = v;
					this.renderStep();
				}));

		if (this.config.useRoute53) {
			const route53Container = container.createDiv({ cls: 'cpn-route53-section' });
			this.renderRoute53Section(route53Container);
		}

		new Setting(container)
			.addButton(btn => btn
				.setButtonText('Next')
				.setCta()
				.onClick(() => this.handleStep1Next()));
	}

	private handleStep1Next(): void {
		if (!this.config.awsProfile || !this.config.region) {
			new Notice('AWS Profile and Region are required.');
			return;
		}

		if (this.config.useRoute53 && (!this.config.hostedZoneId || !this.config.hostedZoneName)) {
			new Notice('Hosted Zone ID and Name are required when using Route53.');
			return;
		}

		if (this.config.customDomain) {
			this.step = 2;
		} else {
			this.step = 4;
		}
		this.renderStep();
	}

	private async renderRoute53Section(container: HTMLElement): Promise<void> {
		const loadingEl = container.createEl('p', { text: 'Looking up hosted zones...', cls: 'cpn-wizard-description' });

		try {
			const zones = await this.cfManager.listHostedZones(this.activeProfile);
			if (this.aborted) return;
			loadingEl.remove();

			if (zones.length === 0) {
				this.renderNoZonesSection(container);
				return;
			}

			const domain = this.config.customDomain || '';

			// Find zones that could serve the custom domain (matching suffix)
			const matchingZones = domain
				? zones.filter(z => domain === z.name || domain.endsWith('.' + z.name))
				: [];

			// Determine which zones to show in the dropdown
			const dropdownZones = matchingZones.length > 0 ? matchingZones : zones;

			// Auto-select: best match if available, otherwise first zone
			if (!this.config.hostedZoneId) {
				const autoSelect = matchingZones.length > 0
					? matchingZones.sort((a, b) => b.name.length - a.name.length)[0]
					: zones[0];
				this.config.hostedZoneId = autoSelect.id;
				this.config.hostedZoneName = autoSelect.name;
			}

			if (matchingZones.length > 0) {
				new Setting(container)
					.setName('Hosted Zone')
					.setDesc('Auto-detected zone matching your domain')
					.addDropdown(dd => {
						for (const zone of matchingZones) {
							dd.addOption(zone.id, `${zone.name} (${zone.id})`);
						}
						if (zones.length > matchingZones.length) {
							dd.addOption('__all__', 'Show all zones...');
						}
						dd.addOption('__manual__', 'Enter manually...');
						dd.setValue(this.config.hostedZoneId || '');
						dd.onChange(v => {
							if (v === '__manual__') {
								this.config.hostedZoneId = '';
								this.config.hostedZoneName = '';
								container.empty();
								this.renderRoute53ManualInputs(container);
							} else if (v === '__all__') {
								container.empty();
								this.renderAllZonesDropdown(container, zones);
							} else {
								const selected = matchingZones.find(z => z.id === v);
								if (selected) {
									this.config.hostedZoneId = selected.id;
									this.config.hostedZoneName = selected.name;
								}
							}
						});
					});
			} else {
				// No matching zones but zones exist — show all in dropdown
				if (domain) {
					container.createEl('p', {
						text: `No zone exactly matching "${domain}" found. Select from your existing zones or create a new one.`,
						cls: 'cpn-wizard-description',
					});
				}
				this.renderAllZonesDropdown(container, zones);
			}
		} catch (err: any) {
			loadingEl.remove();
			container.createEl('p', {
				text: `Could not load hosted zones: ${err.message}`,
				cls: 'cpn-wizard-description',
			});
			this.renderRoute53ManualInputs(container);
		}
	}

	private renderAllZonesDropdown(container: HTMLElement, zones: HostedZoneInfo[]): void {
		if (!this.config.hostedZoneId && zones.length > 0) {
			this.config.hostedZoneId = zones[0].id;
			this.config.hostedZoneName = zones[0].name;
		}

		new Setting(container)
			.setName('Hosted Zone')
			.setDesc('Select a Route53 hosted zone')
			.addDropdown(dd => {
				for (const zone of zones) {
					dd.addOption(zone.id, `${zone.name} (${zone.id})`);
				}
				dd.addOption('__create__', 'Create new zone...');
				dd.addOption('__manual__', 'Enter manually...');
				dd.setValue(this.config.hostedZoneId || '');
				dd.onChange(v => {
					if (v === '__manual__') {
						this.config.hostedZoneId = '';
						this.config.hostedZoneName = '';
						container.empty();
						this.renderRoute53ManualInputs(container);
					} else if (v === '__create__') {
						container.empty();
						this.renderCreateZoneSection(container);
					} else {
						const selected = zones.find(z => z.id === v);
						if (selected) {
							this.config.hostedZoneId = selected.id;
							this.config.hostedZoneName = selected.name;
						}
					}
				});
			});
	}

	private renderNoZonesSection(container: HTMLElement): void {
		const domain = this.config.customDomain || '';
		container.createEl('p', {
			text: 'No Route53 hosted zones found in this account.',
			cls: 'cpn-wizard-description',
		});

		if (domain) {
			this.renderCreateZoneSection(container);
		} else {
			this.renderRoute53ManualInputs(container);
		}
	}

	private renderCreateZoneSection(container: HTMLElement): void {
		const domain = this.config.customDomain || '';
		const domainParts = domain.split('.');
		const parentDomain = domainParts.length >= 2
			? domainParts.slice(-2).join('.')
			: domain || 'example.com';

		new Setting(container)
			.setName('Create hosted zone')
			.setDesc(`Create a new Route53 hosted zone for "${parentDomain}"`)
			.addButton(btn => btn
				.setButtonText('Create Zone')
				.setCta()
				.onClick(async () => {
					try {
						const newZone = await this.cfManager.createHostedZone(this.activeProfile, parentDomain);
						this.config.hostedZoneId = newZone.id;
						this.config.hostedZoneName = newZone.name;
						new Notice(`Created hosted zone: ${newZone.name} (${newZone.id})`);
						container.empty();
						container.createEl('p', {
							text: `Using hosted zone: ${newZone.name} (${newZone.id})`,
							cls: 'cpn-wizard-description',
						});
						container.createEl('p', {
							text: 'Note: Update your domain registrar\'s nameservers to point to the Route53 nameservers for this zone.',
							cls: 'cpn-wizard-description',
						});
					} catch (err: any) {
						new Notice(`Error creating zone: ${err.message}`);
					}
				}));

		new Setting(container)
			.addButton(btn => btn
				.setButtonText('Enter manually instead')
				.onClick(() => {
					container.empty();
					this.renderRoute53ManualInputs(container);
				}));
	}

	private renderRoute53ManualInputs(container: HTMLElement): void {
		new Setting(container)
			.setName('Hosted Zone ID')
			.addText(text => text
				.setValue(this.config.hostedZoneId || '')
				.onChange(v => { this.config.hostedZoneId = v; }));

		new Setting(container)
			.setName('Hosted Zone Name')
			.setDesc('e.g., example.com')
			.addText(text => text
				.setValue(this.config.hostedZoneName || '')
				.onChange(v => { this.config.hostedZoneName = v; }));
	}

	private async renderStep2DeployCert(): Promise<void> {
		const container = this.contentEl.createDiv({ cls: 'cpn-wizard-step' });
		container.createEl('h2', { text: 'Deploy Certificate' });
		container.createEl('p', {
			text: `Creating ACM certificate for ${this.config.customDomain} in us-east-1...`,
			cls: 'cpn-wizard-description',
		});

		const eventLog = container.createDiv({ cls: 'cpn-wizard-event-log' });

		try {
			const stackName = await this.cfManager.deployCertificateStack(this.config as DeploymentConfig);

			await this.updateInfraState({
				certStackName: stackName,
				status: 'cert-deploying',
				customDomain: this.config.customDomain,
			});

			const finalStatus = await this.cfManager.pollStackUntilComplete(
				stackName,
				this.activeProfile,
				(event) => this.appendEvent(eventLog, event),
				'us-east-1',
			);

			if (this.aborted) return;

			if (finalStatus === 'CREATE_COMPLETE') {
				this.certArn = await this.cfManager.getCertificateArn(stackName, this.activeProfile);
				this.config.certificateArn = this.certArn;
				await this.updateInfraState({ status: 'cert-deployed', certificateArn: this.certArn });

				if (this.config.useRoute53) {
					this.step = 4;
				} else {
					this.step = 3;
				}
				this.renderStep();
			} else {
				await this.updateInfraState({ status: 'failed' });
				this.showError(container, `Certificate stack deployment failed: ${finalStatus}`);
			}
		} catch (err: any) {
			await this.updateInfraState({ status: 'failed' });
			this.showError(container, `Error deploying certificate: ${err.message}`);
		}
	}

	private async renderStep3DnsValidation(): Promise<void> {
		const container = this.contentEl.createDiv({ cls: 'cpn-wizard-step' });
		container.createEl('h2', { text: 'DNS Validation' });
		container.createEl('p', {
			text: 'Add the following CNAME record to your DNS provider to validate the certificate:',
			cls: 'cpn-wizard-description',
		});

		await this.updateInfraState({ status: 'waiting-dns' });

		try {
			const records = await this.cfManager.getCertificateValidationRecords(this.certArn, this.activeProfile);

			if (records.length === 0) {
				container.createEl('p', { text: 'Waiting for validation records to become available...' });
				await this.sleep(5000);
				if (!this.aborted) this.renderStep();
				return;
			}

			for (const record of records) {
				const row = container.createDiv({ cls: 'cpn-dns-record-row' });
				row.createEl('strong', { text: 'CNAME Name:' });
				const nameEl = row.createEl('code', { text: record.name });
				const copyNameBtn = row.createEl('button', { text: 'Copy', cls: 'cpn-copy-btn' });
				copyNameBtn.addEventListener('click', () => {
					navigator.clipboard.writeText(record.name);
					new Notice('Copied!');
				});

				row.createEl('strong', { text: 'CNAME Value:' });
				const valueEl = row.createEl('code', { text: record.value });
				const copyValueBtn = row.createEl('button', { text: 'Copy', cls: 'cpn-copy-btn' });
				copyValueBtn.addEventListener('click', () => {
					navigator.clipboard.writeText(record.value);
					new Notice('Copied!');
				});
			}

			const statusEl = container.createDiv({ cls: 'cpn-dns-status' });
			statusEl.setText('Waiting for certificate validation...');

			new Setting(container)
				.addButton(btn => btn
					.setButtonText('Check Status')
					.setCta()
					.onClick(async () => {
						const status = await this.cfManager.checkCertificateStatus(this.certArn, this.activeProfile);
						if (status === 'ISSUED') {
							this.step = 4;
							this.renderStep();
						} else {
							statusEl.setText(`Certificate status: ${status}. Waiting for validation...`);
						}
					}));
		} catch (err: any) {
			this.showError(container, `Error fetching validation records: ${err.message}`);
		}
	}

	private async renderStep4DeployFull(): Promise<void> {
		const container = this.contentEl.createDiv({ cls: 'cpn-wizard-step' });
		container.createEl('h2', { text: 'Deploy Infrastructure' });
		container.createEl('p', {
			text: `Deploying S3 bucket and CloudFront distribution in ${this.config.region}...`,
			cls: 'cpn-wizard-description',
		});

		const eventLog = container.createDiv({ cls: 'cpn-wizard-event-log' });

		try {
			const stackName = await this.cfManager.deployFullStack(this.config as DeploymentConfig);

			await this.updateInfraState({
				fullStackName: stackName,
				status: 'deploying',
				region: this.config.region,
				variantName: this.config.variantName,
				originAccessMethod: this.config.originAccessMethod,
			});

			const finalStatus = await this.cfManager.pollStackUntilComplete(
				stackName,
				this.activeProfile,
				(event) => this.appendEvent(eventLog, event),
				this.config.region,
			);

			if (this.aborted) return;

			if (finalStatus === 'CREATE_COMPLETE') {
				this.stackOutputs = await this.cfManager.getStackOutputs(stackName, this.activeProfile, this.config.region);
				await this.updateInfraState({ status: 'deployed', lastDeployTimestamp: Date.now() });
				this.step = 5;
				this.renderStep();
			} else {
				await this.updateInfraState({ status: 'failed' });
				this.showError(container, `Stack deployment failed: ${finalStatus}`);
			}
		} catch (err: any) {
			await this.updateInfraState({ status: 'failed' });
			this.showError(container, `Error deploying infrastructure: ${err.message}`);
		}
	}

	private renderStep5Complete(): void {
		const container = this.contentEl.createDiv({ cls: 'cpn-wizard-step' });
		container.createEl('h2', { text: 'Deployment Complete' });
		container.createEl('p', {
			text: 'Your publishing infrastructure has been successfully deployed.',
			cls: 'cpn-wizard-description',
		});

		if (this.stackOutputs) {
			const outputsDiv = container.createDiv({ cls: 'cpn-wizard-outputs' });
			const outputsHeader = outputsDiv.createDiv({ cls: 'cpn-outputs-header' });
			outputsHeader.createEl('h3', { text: 'Stack Outputs' });
			const copyBtn = outputsHeader.createEl('button', {
				cls: 'cpn-copy-btn',
				attr: { 'aria-label': 'Copy all outputs to clipboard' },
			});
			copyBtn.setText('Copy All');
			copyBtn.addEventListener('click', () => {
				const text = [
					`Bucket Name: ${this.stackOutputs!.bucketName}`,
					`Distribution ID: ${this.stackOutputs!.distributionId}`,
					`Distribution Domain: ${this.stackOutputs!.distributionDomainName}`,
					`Site URL: ${this.stackOutputs!.siteUrl}`,
					`Region: ${this.config.region}`,
					`S3 Prefix: ${this.config.s3Prefix || '(none)'}`,
					`Stack Name: ${this.cfManager.getStackName(this.config.variantName || '', 'full')}`,
					`Origin Access: ${this.config.originAccessMethod === 'oac' ? 'OAC' : 'OAI'}`,
				].join('\n');
				navigator.clipboard.writeText(text);
				new Notice('Stack outputs copied to clipboard.');
			});

			const entries: [string, string][] = [
				['Bucket Name', this.stackOutputs.bucketName],
				['Distribution ID', this.stackOutputs.distributionId],
				['Distribution Domain', this.stackOutputs.distributionDomainName],
				['Site URL', this.stackOutputs.siteUrl],
			];

			for (const [label, value] of entries) {
				const row = outputsDiv.createDiv({ cls: 'cpn-output-row' });
				row.createEl('strong', { text: `${label}: ` });
				row.createEl('code', { text: value });
			}
		}

		new Setting(container)
			.setName('Auto-populate profile settings')
			.setDesc('Write the deployed infrastructure outputs into this publishing profile')
			.addButton(btn => btn
				.setButtonText('Apply to Profile')
				.setCta()
				.onClick(() => this.applyOutputsToProfile()));

		new Setting(container)
			.addButton(btn => btn
				.setButtonText('Done')
				.onClick(() => this.close()));
	}

	private async applyOutputsToProfile(): Promise<void> {
		if (!this.stackOutputs) return;

		const profile = this.plugin.settings.publishingProfiles.find(p => p.id === this.profile.id);
		if (!profile || !profile.awsSettings) return;

		profile.awsSettings.bucketName = this.stackOutputs.bucketName;
		profile.awsSettings.cloudFrontDistributionId = this.stackOutputs.distributionId;
		profile.awsSettings.region = this.config.region!;
		profile.awsSettings.awsProfile = this.config.awsProfile!;
		if (this.config.s3Prefix) {
			profile.awsSettings.s3Prefix = this.config.s3Prefix;
		}
		profile.baseUrl = `https://${this.stackOutputs.siteUrl}/`;

		profile.infrastructureState = {
			status: 'deployed',
			fullStackName: this.cfManager.getStackName(this.config.variantName || '', 'full'),
			certStackName: this.config.customDomain
				? this.cfManager.getStackName(this.config.variantName || '', 'cert')
				: undefined,
			customDomain: this.config.customDomain || undefined,
			useRoute53: this.config.useRoute53 || false,
			certificateArn: this.certArn || undefined,
			lastDeployTimestamp: Date.now(),
			region: this.config.region,
			variantName: this.config.variantName,
			originAccessMethod: this.config.originAccessMethod || 'oac',
		};

		await this.plugin.saveSettings();
		new Notice('Profile settings updated from stack outputs.');
	}

	private get activeProfile(): PublishingProfile {
		return {
			...this.profile,
			awsSettings: {
				...this.profile.awsSettings!,
				awsProfile: this.config.awsProfile || this.profile.awsSettings!.awsProfile,
				region: this.config.region || this.profile.awsSettings!.region,
			},
		};
	}

	private async updateInfraState(partial: Record<string, any>): Promise<void> {
		const profile = this.plugin.settings.publishingProfiles.find(p => p.id === this.profile.id);
		if (!profile) return;

		profile.infrastructureState = {
			status: 'none' as const,
			useRoute53: this.config.useRoute53 || false,
			originAccessMethod: this.config.originAccessMethod || 'oac',
			...profile.infrastructureState,
			...partial,
		};
		await this.plugin.saveSettings();
	}

	private appendEvent(container: HTMLElement, event: StackEvent): void {
		const line = container.createDiv({ cls: 'cpn-wizard-event-line' });
		const status = event.status;
		if (status.includes('FAILED') || status.includes('ROLLBACK')) {
			line.addClass('cpn-event-error');
		} else if (status.includes('COMPLETE')) {
			line.addClass('cpn-event-success');
		}
		const time = event.timestamp.toLocaleTimeString();
		line.setText(`[${time}] ${event.logicalResourceId} - ${status}${event.reason ? ` (${event.reason})` : ''}`);
		container.scrollTop = container.scrollHeight;
	}

	private showError(container: HTMLElement, message: string): void {
		const errorDiv = container.createDiv({ cls: 'cpn-wizard-error' });
		errorDiv.setText(message);

		new Setting(container)
			.addButton(btn => btn
				.setButtonText('Close')
				.onClick(() => this.close()));
	}

	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}
