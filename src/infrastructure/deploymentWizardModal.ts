import { App, Modal, Setting, Notice } from 'obsidian';
import type CommonplaceNotesPlugin from '../main';
import type { PublishingProfile } from '../types';
import type { CloudFormationManager } from './cloudFormationManager';
import type { DeploymentConfig, OriginAccessMethod, StackEvent, StackOutputs } from './types';

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

		const route53Setting = new Setting(container)
			.setName('Use Route53')
			.setDesc('Automatically create DNS records via Route53')
			.addToggle(toggle => toggle
				.setValue(this.config.useRoute53 || false)
				.onChange(v => {
					this.config.useRoute53 = v;
					this.renderStep();
				}));

		if (this.config.useRoute53) {
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

			this.updateInfraState({
				certStackName: stackName,
				status: 'cert-deploying',
				customDomain: this.config.customDomain,
			});

			const finalStatus = await this.cfManager.pollStackUntilComplete(
				stackName,
				this.profile,
				(event) => this.appendEvent(eventLog, event),
				'us-east-1',
			);

			if (this.aborted) return;

			if (finalStatus === 'CREATE_COMPLETE') {
				this.certArn = await this.cfManager.getCertificateArn(stackName, this.profile);
				this.config.certificateArn = this.certArn;
				this.updateInfraState({ status: 'cert-deployed', certificateArn: this.certArn });

				if (this.config.useRoute53) {
					this.step = 4;
				} else {
					this.step = 3;
				}
				this.renderStep();
			} else {
				this.updateInfraState({ status: 'failed' });
				this.showError(container, `Certificate stack deployment failed: ${finalStatus}`);
			}
		} catch (err: any) {
			this.updateInfraState({ status: 'failed' });
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

		this.updateInfraState({ status: 'waiting-dns' });

		try {
			const records = await this.cfManager.getCertificateValidationRecords(this.certArn, this.profile);

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
						const status = await this.cfManager.checkCertificateStatus(this.certArn, this.profile);
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

			this.updateInfraState({
				fullStackName: stackName,
				status: 'deploying',
				region: this.config.region,
				variantName: this.config.variantName,
				originAccessMethod: this.config.originAccessMethod,
			});

			const finalStatus = await this.cfManager.pollStackUntilComplete(
				stackName,
				this.profile,
				(event) => this.appendEvent(eventLog, event),
				this.config.region,
			);

			if (this.aborted) return;

			if (finalStatus === 'CREATE_COMPLETE') {
				this.stackOutputs = await this.cfManager.getStackOutputs(stackName, this.profile, this.config.region);
				this.updateInfraState({ status: 'deployed', lastDeployTimestamp: Date.now() });
				this.step = 5;
				this.renderStep();
			} else {
				this.updateInfraState({ status: 'failed' });
				this.showError(container, `Stack deployment failed: ${finalStatus}`);
			}
		} catch (err: any) {
			this.updateInfraState({ status: 'failed' });
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
			outputsDiv.createEl('h3', { text: 'Stack Outputs' });

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
		if (this.config.s3Prefix) {
			profile.awsSettings.s3Prefix = this.config.s3Prefix;
		}
		profile.baseUrl = `https://${this.stackOutputs.siteUrl}/`;

		await this.plugin.saveSettings();
		new Notice('Profile settings updated from stack outputs.');
	}

	private updateInfraState(partial: Record<string, any>): void {
		const profile = this.plugin.settings.publishingProfiles.find(p => p.id === this.profile.id);
		if (!profile) return;

		profile.infrastructureState = {
			status: 'none' as const,
			useRoute53: this.config.useRoute53 || false,
			originAccessMethod: this.config.originAccessMethod || 'oac',
			...profile.infrastructureState,
			...partial,
		};
		this.plugin.saveSettings();
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
