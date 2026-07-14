import { App, Modal, Setting, Notice } from 'obsidian';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import type CommonplaceNotesPlugin from '../main';
import type { PublishingProfile } from '../types';
import type { CloudFormationManager } from './cloudFormationManager';
import type { CertificateMatch, CognitoAuthOutputs, CommentStackOutputs, ChatStackOutputs, DeploymentConfig, HostedZoneInfo, OriginAccessMethod, StackEvent, StackOutputs } from './types';
import { pushSiteAssetsToS3, createCloudFrontInvalidation } from '../publish/awsUpload';
import { cognitoHostedUiDomain, googleOAuthUrls } from './cognitoUrls';

type WizardStep = 1 | 2 | 3 | 4 | 5 | 6;

/** Lowercase hex sha256 via Web Crypto (available in Obsidian's Electron renderer). */
export async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export class DeploymentWizardModal extends Modal {
	private plugin: CommonplaceNotesPlugin;
	private cfManager: CloudFormationManager;
	private profile: PublishingProfile;
	private step: WizardStep = 1;
	private config: Partial<DeploymentConfig> = {};
	private certArn: string = '';
	private certReused = false;
	/** The certificate match the chooser has highlighted for reuse (step 2). */
	private selectedCertMatch: CertificateMatch | null = null;
	private stackOutputs: StackOutputs | null = null;
	private cognitoOutputs: CognitoAuthOutputs | null = null;
	private cognitoStackName: string = '';
	private commentOutputs: CommentStackOutputs | null = null;
	private commentStackName: string = '';
	private chatOutputs: ChatStackOutputs | null = null;
	private chatStackName: string = '';
	private passwordStackName: string = '';
	private passwordEdgeArn: string = '';
	private aborted = false;

	constructor(app: App, plugin: CommonplaceNotesPlugin, cfManager: CloudFormationManager, profile: PublishingProfile) {
		super(app);
		this.plugin = plugin;
		this.cfManager = cfManager;
		this.profile = profile;

		const auth = profile.cognitoAuth;
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
			// Read-gate mode + built-in Cognito + Google auth — re-seed persisted
			// author intent (the Google secret + password plaintext are never
			// stored, so they are always re-entered; the password hash is reused).
			readGateMode: profile.readGate?.mode || (auth?.enabled ? 'cognito' : 'none'),
			passwordHash: profile.readGate?.passwordHash,
			commentIdentityEnabled: auth?.commentIdentity || false,
			googleClientId: auth?.googleClientId || '',
			authDomainPrefix: auth?.authDomainPrefix || '',
			commentingEnabled: profile.commenting?.enabled || false,
			chatEnabled: profile.chat?.enabled || false,
			chatSync: profile.chat?.sync || 'auto',
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
			case 4: this.renderStep4DeployCognito(); break;
			case 5: this.renderStep5DeployFull(); break;
			case 6: this.renderStep6Complete(); break;
		}
	}

	private renderStepIndicator(): void {
		const indicator = this.contentEl.createDiv({ cls: 'cpn-wizard-step-indicator' });
		const steps = ['Configure', 'Certificate', 'DNS', 'Auth', 'Deploy', 'Complete'];
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

		this.renderAuthSection(container);

		new Setting(container)
			.addButton(btn => btn
				.setButtonText('Next')
				.setCta()
				.onClick(() => this.handleStep1Next()));
	}

	/** The Cognito pool is provisioned whenever reads are Cognito-gated OR comments need identity. */
	private cognitoPoolNeeded(): boolean {
		return this.config.readGateMode === 'cognito' || !!this.config.commentIdentityEnabled;
	}

	/**
	 * Suggest a default Hosted UI domain prefix. Mirrors the stack-naming scheme
	 * (cpn-<variant>) and appends a short random suffix to reduce the chance of a
	 * global collision. Sanitized to satisfy Cognito's prefix rules.
	 */
	private suggestAuthDomainPrefix(): string {
		const base = (this.config.variantName || 'notes')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'notes';
		const suffix = Math.random().toString(36).slice(2, 6);
		return `cpn-${base}-${suffix}`;
	}

	/**
	 * Validate a Cognito Hosted UI domain prefix against AWS's rules. Returns an
	 * actionable error message, or null when the prefix is valid.
	 */
	private validateAuthDomainPrefix(prefix: string): string | null {
		if (prefix.length > 63) {
			return 'Auth domain prefix must be 63 characters or fewer.';
		}
		if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(prefix)) {
			return 'Auth domain prefix must use only lowercase letters, digits and hyphens, ' +
				'and cannot start or end with a hyphen.';
		}
		if (/aws|amazon|cognito/.test(prefix)) {
			return 'Auth domain prefix cannot contain "aws", "amazon" or "cognito" (reserved by AWS).';
		}
		return null;
	}

	private renderAuthSection(container: HTMLElement): void {
		container.createEl('h3', { text: 'Authentication' });

		// Read access is one axis: who can READ the site. Independent of comments.
		new Setting(container)
			.setName('Read access')
			.setDesc('Who can read the published site. Comment write-access is configured separately below.')
			.addDropdown(dd => dd
				.addOption('none', 'Public (anyone can read)')
				.addOption('cognito', 'Login required (Cognito + Google)')
				.addOption('password', 'Password (anyone with the password)')
				.addOption('byo', 'Custom Lambda@Edge ARN (advanced)')
				.setValue(this.config.readGateMode || 'none')
				.onChange(v => {
					this.config.readGateMode = v as DeploymentConfig['readGateMode'];
					this.renderStep();
				}));

		if (this.config.readGateMode === 'password') {
			new Setting(container)
				.setName('Site password')
				.setDesc('Shared read password. Hashed (sha256) before deploy — the plaintext never leaves the plugin. Re-enter to change it.')
				.addText(text => {
					text.inputEl.type = 'password';
					text
						.setValue(this.config.passwordValue || '')
						.setPlaceholder(this.config.passwordHash ? '•••••••• (unchanged)' : 'choose a password')
						.onChange(v => { this.config.passwordValue = v; });
				});
		}

		if (this.config.readGateMode === 'byo') {
			new Setting(container)
				.setName('Auth Lambda@Edge ARN (advanced)')
				.setDesc('Bring-your-own viewer-request function (e.g., from cpn-internal-auth). Must be a versioned ARN in us-east-1.')
				.addText(text => text
					.setValue(this.config.authLambdaEdgeArn || '')
					.setPlaceholder('arn:aws:lambda:us-east-1:...:function:name:version')
					.onChange(v => { this.config.authLambdaEdgeArn = v; }));
		}

		// Comment identity is the other axis: who can WRITE comments (Cognito sign-in).
		new Setting(container)
			.setName('Enable commenting (Cognito + Google sign-in)')
			.setDesc('Provision a Cognito pool so signed-in readers can write comments. Works with any read-access mode (e.g. password reads + sign-in to comment).')
			.addToggle(toggle => toggle
				.setValue(this.config.commentIdentityEnabled || false)
				.onChange(v => {
					this.config.commentIdentityEnabled = v;
					if (!v) this.config.commentingEnabled = false;
					this.renderStep();
				}));

		if (this.config.commentIdentityEnabled) {
			new Setting(container)
				.setName('Deploy commenting backend')
				.setDesc('Self-hosted comments (DynamoDB + S3). Comment reads inherit the read-access mode; only signed-in users can write.')
				.addToggle(toggle => toggle
					.setValue(this.config.commentingEnabled || false)
					.onChange(v => { this.config.commentingEnabled = v; }));
		}

		// Cognito credentials are needed whenever the pool is provisioned (for
		// read gating, for comment identity, or both).
		if (this.cognitoPoolNeeded()) {
			new Setting(container)
				.setName('Google Client ID')
				.setDesc('From Google Cloud Console → Credentials → OAuth 2.0 Client ID')
				.addText(text => text
					.setValue(this.config.googleClientId || '')
					.setPlaceholder('xxxx.apps.googleusercontent.com')
					.onChange(v => { this.config.googleClientId = v; }));

			new Setting(container)
				.setName('Google Client Secret')
				.setDesc('Not stored — passed securely at deploy time and re-entered each time.')
				.addText(text => {
					text.inputEl.type = 'password';
					text
						.setValue(this.config.googleClientSecret || '')
						.setPlaceholder('GOCSPX-...')
						.onChange(v => { this.config.googleClientSecret = v; });
				});

			// A name you choose (not a pre-existing endpoint): Cognito reserves it
			// when the auth stack's UserPoolDomain is created. Seed a sensible
			// default so the user isn't inventing a globally-unique string blind.
			if (!this.config.authDomainPrefix) {
				this.config.authDomainPrefix = this.suggestAuthDomainPrefix();
			}
			new Setting(container)
				.setName('Auth domain prefix')
				.setDesc(
					'A name you choose for the Cognito login page. On deploy it becomes ' +
					'<prefix>.auth.<region>.amazoncognito.com — it does not need to exist yet, ' +
					'but must be globally unique across all AWS accounts. Lowercase letters, ' +
					'digits and hyphens only.'
				)
				.addText(text => text
					.setValue(this.config.authDomainPrefix || '')
					.setPlaceholder('my-notes-auth')
					.onChange(v => {
						this.config.authDomainPrefix = v;
						this.renderGoogleOAuthHint(hintEl);
					}));

			// Live-updating hint: the Hosted UI domain is deterministic from the
			// prefix + region, so show the exact URLs to register in Google *now*
			// (Google must trust them before sign-in works). Re-rendered in place on
			// prefix change so the text input keeps focus.
			const hintEl = container.createDiv({ cls: 'cpn-oauth-hint' });
			this.renderGoogleOAuthHint(hintEl);
		}

		// --- LLM chat over the published corpus ------------------------------
		new Setting(container)
			.setName('Enable LLM chat over published notes')
			.setDesc('Deploy a Bedrock Knowledge Base + streaming chat endpoint behind this distribution. Readers can ask questions across your published notes and get grounded, citation-bearing answers. Chat inherits whatever read-access mode you set above (the endpoint is only reachable through the auth-gated CloudFront path).')
			.addToggle(toggle => toggle
				.setValue(this.config.chatEnabled || false)
				.onChange(v => {
					this.config.chatEnabled = v;
					this.renderStep();
				}));

		if (this.config.chatEnabled) {
			// Explicit cost disclosure — the vector-store choice is the big cost lever.
			const cost = container.createEl('p', { cls: 'cpn-wizard-description' });
			cost.setText(
				'Cost: the default S3 Vectors store has near-zero idle cost (a few cents/month for storage). ' +
				'Per-question cost is proportional to Bedrock usage (model + embedding tokens). ' +
				'OpenSearch Serverless (an advanced upgrade path, not deployed here) carries an always-on ~$350–700/month floor.'
			);

			new Setting(container)
				.setName('Knowledge base sync')
				.setDesc('Auto: a publish automatically re-indexes changed notes (recommended). Manual: re-index on demand from a command/button (ingestion is not instantaneous).')
				.addDropdown(dd => dd
					.addOption('auto', 'Auto (on every publish)')
					.addOption('manual', 'Manual (command only)')
					.setValue(this.config.chatSync || 'auto')
					.onChange(v => { this.config.chatSync = v as 'auto' | 'manual'; }));

			new Setting(container)
				.setName('Chat model (advanced)')
				.setDesc('Bedrock inference-profile ARN for answer generation. Leave blank to default to Claude Sonnet 5 in your region. Note: Sonnet 5 is inference-profile-only — use an inference-profile ARN, not a bare model id.')
				.addText(text => text
					.setValue(this.config.chatModelArn || '')
					.setPlaceholder('arn:aws:bedrock:<region>:<acct>:inference-profile/us.anthropic.claude-sonnet-5')
					.onChange(v => { this.config.chatModelArn = v.trim() || undefined; }));
		}
	}

	/**
	 * (Re)render the Google OAuth pre-deploy hint into `hintEl`, showing the
	 * Authorized JavaScript origin and redirect URI the user must add to their
	 * Google OAuth client. Uses a `<region>` / `<prefix>` placeholder when either
	 * value is not yet known so the shape is still clear.
	 */
	private renderGoogleOAuthHint(hintEl: HTMLElement): void {
		hintEl.empty();

		const prefix = this.config.authDomainPrefix || '<prefix>';
		const region = this.config.region || '<region>';
		const domain = `https://${prefix}.auth.${region}.amazoncognito.com`;
		const { jsOrigin, redirectUri } = googleOAuthUrls(domain);
		// Only wire up copy buttons once the values are real (no placeholders).
		const resolved = !!(this.config.authDomainPrefix && this.config.region);

		hintEl.createEl('p', {
			text: 'Add these to your Google OAuth client (Google Cloud Console → APIs & Services → '
				+ 'Credentials → your OAuth 2.0 Client ID) before deploying — sign-in fails until '
				+ 'Google trusts them:',
			cls: 'cpn-wizard-description',
		});
		this.createCopyRow(hintEl, 'Authorized JavaScript origin', jsOrigin, resolved);
		this.createCopyRow(hintEl, 'Authorized redirect URI', redirectUri, resolved);
	}

	/**
	 * A labelled read-only value row with a Copy button, styled like the DNS /
	 * stack-output rows. When `copyable` is false (placeholder values) the button
	 * is omitted so the user isn't offered a broken copy.
	 */
	private createCopyRow(parent: HTMLElement, label: string, value: string, copyable = true): void {
		const row = parent.createDiv({ cls: 'cpn-dns-record-row' });
		row.createEl('strong', { text: label });
		row.createEl('code', { text: value });
		if (copyable) {
			const btn = row.createEl('button', { text: 'Copy', cls: 'cpn-copy-btn' });
			btn.addEventListener('click', () => {
				navigator.clipboard.writeText(value);
				new Notice('Copied!');
			});
		}
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

		if (this.cognitoPoolNeeded()) {
			if (!this.config.googleClientId || !this.config.googleClientSecret || !this.config.authDomainPrefix) {
				new Notice('Cognito auth requires Google Client ID, Client Secret, and an auth domain prefix.');
				return;
			}
			const prefixError = this.validateAuthDomainPrefix(this.config.authDomainPrefix);
			if (prefixError) {
				new Notice(prefixError);
				return;
			}
		}

		if (this.config.readGateMode === 'password') {
			// Need a password unless one was already deployed (hash persisted) and left unchanged.
			if (!this.config.passwordValue && !this.config.passwordHash) {
				new Notice('Enter a site password, or choose a different read-access mode.');
				return;
			}
		}

		if (this.config.readGateMode === 'byo' && !this.config.authLambdaEdgeArn) {
			new Notice('Enter the Lambda@Edge ARN, or choose a different read-access mode.');
			return;
		}

		if (this.config.customDomain) {
			this.step = 2;
		} else {
			this.step = this.stepAfterDomainPath();
		}
		this.renderStep();
	}

	/** Whether the Auth deploy step (4) must run — any sub-stack or ARN wiring is needed. */
	private needsAuthStep(): boolean {
		return this.cognitoPoolNeeded()
			|| this.config.readGateMode === 'password'
			|| this.config.readGateMode === 'byo';
	}

	/**
	 * The step to enter once the domain/certificate path is settled: the Auth
	 * deploy step (4) when any read-gate sub-stack / pool is needed, otherwise
	 * straight to the full-stack deploy (5).
	 */
	private stepAfterDomainPath(): WizardStep {
		return this.needsAuthStep() ? 4 : 5;
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

	/**
	 * Certificate step. Looks up ISSUED certificates in the account (us-east-1)
	 * that cover the custom domain — matching the primary DomainName and all SANs,
	 * with wildcard semantics — and offers to reuse one instead of creating a new
	 * cert. The create path (runCertCreate) preserves the original behavior; the
	 * reuse path (reuseCertificate) skips certificate creation and DNS validation.
	 */
	private async renderStep2DeployCert(): Promise<void> {
		const container = this.contentEl.createDiv({ cls: 'cpn-wizard-step' });
		container.createEl('h2', { text: 'Certificate' });
		const domain = this.config.customDomain || '';

		const statusEl = container.createEl('p', {
			text: 'Looking up existing certificates in us-east-1...',
			cls: 'cpn-wizard-description',
		});
		const chooserEl = container.createDiv();

		let matches: CertificateMatch[];
		try {
			matches = await this.cfManager.findMatchingCertificates(domain, this.activeProfile);
		} catch (err: any) {
			if (this.aborted) return;
			// Non-fatal (e.g. missing acm:ListCertificates): fall back to creating a
			// new cert or pasting an existing ARN.
			statusEl.setText(`Couldn't list existing certificates: ${err.message}. Create a new certificate, or enter an existing certificate ARN.`);
			this.renderCertChooser(chooserEl, [], domain);
			return;
		}

		if (this.aborted) return;

		statusEl.setText(matches.length === 0
			? `No existing certificate covers "${domain}". Create a new certificate, or enter an existing certificate ARN.`
			: `Found ${matches.length} existing certificate${matches.length > 1 ? 's' : ''} that can serve "${domain}". Reuse one, or create a new certificate.`);
		this.renderCertChooser(chooserEl, matches, domain);
	}

	/** The dropdown of reuse candidates + create/manual/show-all options. */
	private renderCertChooser(container: HTMLElement, matches: CertificateMatch[], domain: string): void {
		this.selectedCertMatch = matches.length > 0 ? matches[0] : null;

		new Setting(container)
			.setName('Certificate')
			.setDesc(matches.length > 0
				? 'Reuse an existing certificate or create a new one'
				: 'Create a new certificate or reuse an existing one')
			.addDropdown(dd => {
				for (const match of matches) {
					dd.addOption(match.arn, this.certOptionLabel(match));
				}
				dd.addOption('__create__', 'Create a new certificate');
				dd.addOption('__manual__', 'Enter certificate ARN manually...');
				dd.addOption('__all__', 'Show all issued certificates...');
				dd.setValue(this.selectedCertMatch ? this.selectedCertMatch.arn : '__create__');
				dd.onChange(v => {
					if (v === '__manual__') {
						container.empty();
						this.renderManualArnEntry(container, domain);
					} else if (v === '__all__') {
						container.empty();
						this.renderAllCertsChooser(container, domain);
					} else if (v === '__create__') {
						this.selectedCertMatch = null;
					} else {
						this.selectedCertMatch = matches.find(m => m.arn === v) || null;
					}
				});
			});

		new Setting(container)
			.addButton(btn => btn
				.setButtonText('Continue')
				.setCta()
				.onClick(() => {
					if (this.selectedCertMatch) {
						this.reuseCertificate(this.selectedCertMatch);
					} else {
						this.runCertCreate();
					}
				}));
	}

	/** A one-line description of a reuse candidate for the chooser dropdown. */
	private certOptionLabel(match: CertificateMatch, domain?: string): string {
		const parts: string[] = [match.domainName || '(no domain)'];
		if (match.matchType) {
			parts.push(`${match.matchType} match`);
		} else if (domain) {
			parts.push(`does not cover ${domain}`);
		}
		if (match.notAfter) {
			parts.push(`expires ${new Date(match.notAfter).toLocaleDateString()}`);
		}
		if (match.inUse) parts.push('in use');
		return `${parts.join(' — ')} (…${match.arn.slice(-12)})`;
	}

	/** Manual ARN entry — validated (exists, ISSUED, covers the domain) before reuse. */
	private renderManualArnEntry(container: HTMLElement, domain: string): void {
		let arnValue = '';
		new Setting(container)
			.setName('Certificate ARN')
			.setDesc(`Must be an ISSUED certificate in us-east-1 that covers "${domain}".`)
			.addText(text => text
				.setPlaceholder('arn:aws:acm:us-east-1:...:certificate/...')
				.onChange(v => { arnValue = v; }));

		const statusEl = container.createDiv({ cls: 'cpn-dns-status' });

		new Setting(container)
			.addButton(btn => btn
				.setButtonText('Use this certificate')
				.setCta()
				.onClick(async () => {
					if (!arnValue.trim()) {
						new Notice('Enter a certificate ARN.');
						return;
					}
					btn.setDisabled(true);
					statusEl.setText('Validating certificate...');
					try {
						const match = await this.cfManager.describeCertificateForReuse(arnValue.trim(), domain, this.activeProfile);
						await this.reuseCertificate(match);
					} catch (err: any) {
						btn.setDisabled(false);
						statusEl.setText('');
						new Notice(err.message);
					}
				}))
			.addButton(btn => btn
				.setButtonText('Back')
				.onClick(() => this.renderStep()));
	}

	/** Fallback list of every ISSUED cert, annotated with domain coverage. */
	private async renderAllCertsChooser(container: HTMLElement, domain: string): Promise<void> {
		const loadingEl = container.createEl('p', { text: 'Loading all issued certificates...', cls: 'cpn-wizard-description' });

		let certs: CertificateMatch[];
		try {
			certs = await this.cfManager.listIssuedCertificatesForDomain(domain, this.activeProfile);
		} catch (err: any) {
			if (this.aborted) return;
			loadingEl.setText(`Couldn't list certificates: ${err.message}`);
			return;
		}
		if (this.aborted) return;
		loadingEl.remove();

		container.createEl('p', {
			text: certs.length === 0
				? 'No issued certificates found in this account.'
				: `Showing all issued certificates. One that does not cover "${domain}" cannot serve your site.`,
			cls: 'cpn-wizard-description',
		});

		let selected: CertificateMatch | null = certs.length > 0 ? certs[0] : null;
		if (certs.length > 0) {
			new Setting(container)
				.setName('Certificate')
				.addDropdown(dd => {
					for (const cert of certs) {
						dd.addOption(cert.arn, this.certOptionLabel(cert, domain));
					}
					dd.setValue(selected!.arn);
					dd.onChange(v => { selected = certs.find(c => c.arn === v) || null; });
				});
		}

		new Setting(container)
			.addButton(btn => btn
				.setButtonText('Use selected certificate')
				.setCta()
				.setDisabled(certs.length === 0)
				.onClick(async () => {
					if (!selected) return;
					// Re-validate via DescribeCertificate: confirms coverage even when
					// the summary's SANs were truncated (annotation is only a hint).
					btn.setDisabled(true);
					try {
						const match = await this.cfManager.describeCertificateForReuse(selected.arn, domain, this.activeProfile);
						await this.reuseCertificate(match);
					} catch (err: any) {
						btn.setDisabled(false);
						new Notice(err.message);
					}
				}))
			.addButton(btn => btn
				.setButtonText('Back')
				.onClick(() => this.renderStep()));
	}

	/** Reuse an already-ISSUED certificate: record it and skip creation + DNS. */
	private async reuseCertificate(match: CertificateMatch): Promise<void> {
		this.certArn = match.arn;
		this.config.certificateArn = match.arn;
		this.certReused = true;
		await this.updateInfraState({
			status: 'cert-deployed',
			certificateArn: match.arn,
			certificateReused: true,
			certStackName: undefined, // we do not own a cert stack for a reused cert
			customDomain: this.config.customDomain,
		});
		// Already ISSUED — skip the DNS validation step entirely, regardless of Route53.
		this.step = this.stepAfterDomainPath();
		this.renderStep();
	}

	/** Create a brand-new ACM certificate stack (the original step-2 behavior). */
	private async runCertCreate(): Promise<void> {
		this.contentEl.empty();
		this.renderStepIndicator();
		const container = this.contentEl.createDiv({ cls: 'cpn-wizard-step' });
		container.createEl('h2', { text: 'Deploy Certificate' });
		container.createEl('p', {
			text: `Creating ACM certificate for ${this.config.customDomain} in us-east-1...`,
			cls: 'cpn-wizard-description',
		});

		const eventLog = container.createDiv({ cls: 'cpn-wizard-event-log' });
		this.certReused = false;

		try {
			const stackName = await this.cfManager.deployCertificateStack(this.config as DeploymentConfig);

			await this.updateInfraState({
				certStackName: stackName,
				status: 'cert-deploying',
				customDomain: this.config.customDomain,
				certificateReused: false,
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
				await this.updateInfraState({ status: 'cert-deployed', certificateArn: this.certArn, certificateReused: false });

				if (this.config.useRoute53) {
					this.step = this.stepAfterDomainPath();
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
							this.step = this.stepAfterDomainPath();
							this.renderStep();
						} else {
							statusEl.setText(`Certificate status: ${status}. Waiting for validation...`);
						}
					}));
		} catch (err: any) {
			this.showError(container, `Error fetching validation records: ${err.message}`);
		}
	}

	/**
	 * Auth deploy step: deploy whichever read-gate / identity sub-stacks the
	 * chosen configuration needs (us-east-1), then resolve the read-gate ARN that
	 * feeds the full-stack `AuthLambdaEdgeArn`:
	 *   - password mode  -> deploy the password (Basic Auth) sub-stack; ARN = its edge fn
	 *   - cognito mode    -> ARN = the Cognito edge fn
	 *   - byo mode        -> ARN = the user-supplied ARN (no sub-stack)
	 *   - none            -> ARN = '' (public reads)
	 * The Cognito pool is deployed when read gating is cognito OR comments need
	 * identity. Its phase-2 callback fix-up still runs after the full stack.
	 */
	private async renderStep4DeployCognito(): Promise<void> {
		const container = this.contentEl.createDiv({ cls: 'cpn-wizard-step' });
		container.createEl('h2', { text: 'Deploy Authentication' });
		const eventLog = container.createDiv({ cls: 'cpn-wizard-event-log' });

		try {
			// 1) Password read-gate sub-stack (independent of the pool).
			if (this.config.readGateMode === 'password') {
				container.createEl('p', {
					text: 'Deploying the password (Basic Auth) viewer-request function in us-east-1...',
					cls: 'cpn-wizard-description',
				});
				// Hash the plaintext now (never stored/transmitted in the clear). Reuse
				// the existing hash on redeploy when the field was left blank.
				if (this.config.passwordValue) {
					this.config.passwordHash = await sha256Hex(this.config.passwordValue);
				}
				const pwStack = await this.cfManager.deployPasswordAuthStack(
					this.config as DeploymentConfig,
					this.activeProfile,
					(e) => this.appendEvent(eventLog, e),
				);
				await this.updateInfraState({ status: 'password-deploying' });
				const pwStatus = await this.cfManager.pollStackUntilComplete(
					pwStack, this.activeProfile, (e) => this.appendEvent(eventLog, e), 'us-east-1',
				);
				if (this.aborted) return;
				if (pwStatus !== 'CREATE_COMPLETE') {
					await this.updateInfraState({ status: 'failed' });
					this.showError(container, `Password auth stack deployment failed: ${pwStatus}`);
					return;
				}
				const pwOut = await this.cfManager.getPasswordAuthOutputs(pwStack, this.activeProfile);
				this.passwordStackName = pwStack;
				this.passwordEdgeArn = pwOut.edgeFunctionVersionArn;
				await this.updateInfraState({ status: 'password-deployed' });
			}

			// 2) Cognito pool (read gating and/or comment identity).
			if (this.cognitoPoolNeeded()) {
				container.createEl('p', {
					text: 'Deploying the Cognito user pool, Google sign-in, and viewer-request function in us-east-1...',
					cls: 'cpn-wizard-description',
				});
				// Custom-domain sites know their callback URL up front; default-domain
				// sites use a placeholder now and get the real URL in phase 2.
				this.config.callbackUrl = this.config.customDomain
					? `https://${this.config.customDomain}/auth/callback`
					: undefined;

				const stackName = await this.cfManager.deployCognitoAuthStack(this.config as DeploymentConfig);
				await this.updateInfraState({ status: 'cognito-deploying' });
				const finalStatus = await this.cfManager.pollStackUntilComplete(
					stackName, this.activeProfile, (e) => this.appendEvent(eventLog, e), 'us-east-1',
				);
				if (this.aborted) return;
				if (finalStatus !== 'CREATE_COMPLETE') {
					await this.updateInfraState({ status: 'failed' });
					this.showError(container, `Cognito auth stack deployment failed: ${finalStatus}`);
					return;
				}
				this.cognitoOutputs = await this.cfManager.getCognitoAuthOutputs(stackName, this.activeProfile);
				this.cognitoStackName = stackName;
				await this.updateInfraState({ status: 'cognito-deployed' });
			}

			// 3) Resolve the read-gate ARN fed into the full-stack deploy.
			this.config.authLambdaEdgeArn = this.resolveReadGateArn();

			this.step = 5;
			this.renderStep();
		} catch (err: any) {
			await this.updateInfraState({ status: 'failed' });
			this.showError(container, `Error deploying authentication: ${err.message}`);
		}
	}

	/** The viewer-request edge-fn ARN for the active read-gate mode (''=public). */
	private resolveReadGateArn(): string {
		switch (this.config.readGateMode) {
			case 'cognito': return this.cognitoOutputs?.edgeFunctionVersionArn || '';
			case 'password': return this.passwordEdgeArn || '';
			case 'byo': return this.config.authLambdaEdgeArn || '';
			default: return '';
		}
	}

	private async renderStep5DeployFull(): Promise<void> {
		const container = this.contentEl.createDiv({ cls: 'cpn-wizard-step' });
		container.createEl('h2', { text: 'Deploy Infrastructure' });
		container.createEl('p', {
			text: `Deploying S3 bucket and CloudFront distribution in ${this.config.region}...`,
			cls: 'cpn-wizard-description',
		});

		const eventLog = container.createDiv({ cls: 'cpn-wizard-event-log' });

		try {
			// Carve the /auth/* callback origin into the distribution so the
			// HttpOnly cookie is set first-party. The comment origins are wired in
			// a later deploy once the comment stack exists.
			if (this.cognitoPoolNeeded() && this.cognitoOutputs?.callbackApiDomain) {
				this.config.callbackApiDomainName = this.cognitoOutputs.callbackApiDomain;
			}

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

				// Phase 2: point the Cognito app client's callback URL at the now-known
				// site domain. Skipped for custom-domain sites (already correct in phase 1).
				await this.runCognitoPhase2(container, eventLog);
				if (this.aborted) return;

				// Optionally deploy the comment backend, then re-update the full stack
				// to attach the /comments/* + /api/comments origins.
				await this.runCommentDeploy(container, eventLog);
				if (this.aborted) return;

				// Optionally deploy the chat backend, then re-update the full stack to
				// attach the /api/chat origin + behavior (auth-gated, secret-header).
				await this.runChatDeploy(container, eventLog);
				if (this.aborted) return;

				// Populate the profile from stack outputs and seed the initial site
				// assets (landing index.html, styles, scripts, config) so the deployed
				// site serves a working page immediately. Done automatically here rather
				// than relying on the optional "Apply to Profile" button on the next
				// screen — otherwise a fresh bucket stays empty and CloudFront returns
				// S3 "Access Denied" (OAC grants GetObject only, so a missing index.html
				// is a 403, not a 404). Must run after the profile's commenting/cognito
				// state is set, which applyOutputsToProfile() does before pushing assets.
				container.createEl('p', {
					text: 'Applying outputs to profile and uploading initial site assets...',
					cls: 'cpn-wizard-description',
				});
				await this.applyOutputsToProfile();
				if (this.aborted) return;

				this.step = 6;
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

	/**
	 * Phase 2 of the two-phase Cognito deploy: for default-CloudFront-domain
	 * sites, update the auth sub-stack so the app client's callback URL matches
	 * the real distribution domain. A pure parameter update. No-op when built-in
	 * auth is off or the site has a custom domain (callback was correct already).
	 */
	private async runCognitoPhase2(container: HTMLElement, eventLog: HTMLElement): Promise<void> {
		if (!this.cognitoPoolNeeded() || !this.cognitoStackName) return;
		if (this.config.customDomain) return; // callback URL already correct
		if (!this.stackOutputs?.distributionDomainName) return;

		container.createEl('p', {
			text: 'Updating Cognito callback URL to the deployed site domain...',
			cls: 'cpn-wizard-description',
		});

		this.config.callbackUrl = `https://${this.stackOutputs.distributionDomainName}/auth/callback`;
		await this.cfManager.updateCognitoAuthStack(this.config as DeploymentConfig);
		await this.cfManager.pollStackUntilComplete(
			this.cognitoStackName,
			this.activeProfile,
			(event) => this.appendEvent(eventLog, event),
			'us-east-1',
		);
	}

	/**
	 * Deploy the self-hosted comment backend (when enabled), then re-update the
	 * full stack to attach the comment CloudFront origins. Requires the Cognito
	 * outputs (for the authorizer) and the full-stack outputs (for the bucket's
	 * cross-stack read grant), so it runs after both have deployed.
	 */
	private async runCommentDeploy(container: HTMLElement, eventLog: HTMLElement): Promise<void> {
		if (!this.config.commentingEnabled || !this.config.commentIdentityEnabled) return;
		if (!this.cognitoOutputs || !this.stackOutputs) return;

		container.createEl('p', {
			text: 'Deploying the comment backend (DynamoDB, write API, re-export)...',
			cls: 'cpn-wizard-description',
		});

		// Source the authorizer config from the auth pool, and the bucket grant
		// identifiers from the just-deployed site distribution.
		this.config.commentJwksUri = this.cognitoOutputs.jwksUri;
		this.config.commentTokenIssuer = this.cognitoOutputs.issuer;
		this.config.commentUserPoolClientId = this.cognitoOutputs.userPoolClientId;
		this.config.siteDistributionId = this.stackOutputs.distributionId;
		this.config.siteOriginAccessIdentityId = this.stackOutputs.originAccessIdentityId || '';

		const commentStackName = await this.cfManager.deployCommentStack(this.config as DeploymentConfig);
		await this.updateInfraState({ status: 'comment-deploying' });

		const status = await this.cfManager.pollStackUntilComplete(
			commentStackName,
			this.activeProfile,
			(event) => this.appendEvent(eventLog, event),
			this.config.region,
		);
		if (this.aborted) return;
		if (status !== 'CREATE_COMPLETE') {
			throw new Error(`Comment stack deployment failed: ${status}`);
		}

		const outputs = await this.cfManager.getCommentStackOutputs(commentStackName, this.activeProfile, this.config.region);
		this.commentStackName = commentStackName;
		this.commentOutputs = outputs;

		// Re-update the full stack to carve in the comment origins/behaviors.
		container.createEl('p', {
			text: 'Attaching the comment routes to the site distribution...',
			cls: 'cpn-wizard-description',
		});
		this.config.commentBucketDomainName = outputs.bucketDomainName;
		this.config.commentApiDomainName = outputs.apiDomain;
		await this.cfManager.updateFullStack(this.config as DeploymentConfig);
		await this.cfManager.pollStackUntilComplete(
			this.cfManager.getStackName(this.config.variantName || '', 'full'),
			this.activeProfile,
			(event) => this.appendEvent(eventLog, event),
			this.config.region,
		);
		await this.updateInfraState({ status: 'comment-deployed' });
	}

	/**
	 * Deploy the LLM chat backend (when enabled), then re-update the full stack to
	 * attach the /api/chat origin + behavior (carrying the shared secret header and
	 * the auth-edge association). Runs after the full stack (needs the site bucket
	 * + distribution) and after any comment deploy (so its full-stack update layers
	 * on top). The chat handler is packaged with a generated origin secret; the same
	 * secret is injected by CloudFront and validated fail-closed by the Lambda.
	 */
	private async runChatDeploy(container: HTMLElement, eventLog: HTMLElement): Promise<void> {
		if (!this.config.chatEnabled || !this.stackOutputs) return;

		container.createEl('p', {
			text: 'Deploying the chat backend (Bedrock Knowledge Base, S3 Vectors, streaming endpoint)...',
			cls: 'cpn-wizard-description',
		});

		// Generate the CloudFront↔origin shared secret once, here: baked into the
		// handler zip AND injected as the /api/chat origin custom header.
		this.config.chatOriginSecret = this.generateOriginSecret();
		const bucketName = this.stackOutputs.bucketName;

		const chatStackName = await this.cfManager.deployChatStack(this.config as DeploymentConfig, this.activeProfile, bucketName);
		await this.updateInfraState({ status: 'chat-deploying' });

		const status = await this.cfManager.pollStackUntilComplete(
			chatStackName,
			this.activeProfile,
			(event) => this.appendEvent(eventLog, event),
			this.config.region,
		);
		if (this.aborted) return;
		if (status !== 'CREATE_COMPLETE') {
			throw new Error(`Chat stack deployment failed: ${status}`);
		}

		const outputs = await this.cfManager.getChatStackOutputs(chatStackName, this.activeProfile, this.config.region);
		this.chatStackName = chatStackName;
		this.chatOutputs = outputs;

		// The handler was packaged with a PLACEHOLDER KB id (unknown until the stack
		// created the KB). Re-package with the real id and update the stack so the
		// Lambda queries the right Knowledge Base.
		container.createEl('p', {
			text: 'Finalizing the chat function with the knowledge base id...',
			cls: 'cpn-wizard-description',
		});
		await this.cfManager.updateChatStackWithKbId(this.config as DeploymentConfig, this.activeProfile, bucketName, outputs.knowledgeBaseId);
		await this.cfManager.pollStackUntilComplete(
			chatStackName,
			this.activeProfile,
			(event) => this.appendEvent(eventLog, event),
			this.config.region,
		);
		if (this.aborted) return;

		// Re-update the full stack to carve in the /api/chat origin + behavior.
		container.createEl('p', {
			text: 'Attaching the chat route to the site distribution...',
			cls: 'cpn-wizard-description',
		});
		this.config.chatFunctionUrlDomainName = outputs.functionUrlDomainName;
		await this.cfManager.updateFullStack(this.config as DeploymentConfig);
		await this.cfManager.pollStackUntilComplete(
			this.cfManager.getStackName(this.config.variantName || '', 'full'),
			this.activeProfile,
			(event) => this.appendEvent(eventLog, event),
			this.config.region,
		);
		await this.updateInfraState({ status: 'chat-deployed' });
	}

	/** Generate a URL-safe random shared secret for the /api/chat origin header. */
	private generateOriginSecret(): string {
		const bytes = new Uint8Array(32);
		globalThis.crypto.getRandomValues(bytes);
		return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	}

	private renderStep6Complete(): void {
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

		// Google sign-in finish-up: the user must register the Cognito Hosted UI
		// URLs in their Google OAuth client. These weren't final until now (the
		// domain is confirmed by the deploy), so surface them here with copy
		// buttons rather than leaving the user to reconstruct them.
		const hostedUiDomain = this.cognitoOutputs?.hostedUiDomain
			|| cognitoHostedUiDomain(this.config.authDomainPrefix, this.config.region);
		if (this.cognitoPoolNeeded() && hostedUiDomain) {
			const authDiv = container.createDiv({ cls: 'cpn-wizard-outputs' });
			authDiv.createEl('h3', { text: 'Finish Google sign-in setup' });
			authDiv.createEl('p', {
				text: 'Add these to your Google OAuth client (Google Cloud Console → APIs & Services '
					+ '→ Credentials → your OAuth 2.0 Client ID). Sign-in fails until Google trusts them:',
				cls: 'cpn-wizard-description',
			});
			const { jsOrigin, redirectUri } = googleOAuthUrls(hostedUiDomain);
			this.createCopyRow(authDiv, 'Authorized JavaScript origin', jsOrigin);
			this.createCopyRow(authDiv, 'Authorized redirect URI', redirectUri);
		}

		// Commenting needs published note content to be visible — the widget only
		// renders on note pages, and the freshly-seeded site has none yet. Tell the
		// user the one action that makes comments appear.
		if (this.config.commentingEnabled && this.commentOutputs) {
			const commentDiv = container.createDiv({ cls: 'cpn-wizard-outputs' });
			commentDiv.createEl('h3', { text: 'Commenting is deployed' });
			commentDiv.createEl('p', {
				text: 'The comment box only appears on published note pages. Run "Publish all notes" '
					+ 'to upload your content, then open a note to see it.',
				cls: 'cpn-wizard-description',
			});
		}

		if (this.config.chatEnabled && this.chatOutputs) {
			const chatDiv = container.createDiv({ cls: 'cpn-wizard-outputs' });
			chatDiv.createEl('h3', { text: 'LLM chat is deployed' });
			chatDiv.createEl('p', {
				text: 'Run "Publish all notes" to upload the kb/ corpus, which triggers a knowledge-base '
					+ 'ingestion. Indexing is not instantaneous — wait a minute after the first publish, then '
					+ 'open the site and use the "Ask these notes" button.',
				cls: 'cpn-wizard-description',
			});
		}

		new Setting(container)
			.setName('Re-apply profile settings')
			.setDesc('Outputs were already applied and the initial site assets uploaded automatically. Use this to re-apply the outputs and re-push the site assets.')
			.addButton(btn => btn
				.setButtonText('Re-apply & re-push assets')
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

		// Fetch the AWS account ID via STS
		try {
			const stsClient = this.plugin.awsSdkManager.getSTSClient(this.activeProfile);
			const identity = await stsClient.send(new GetCallerIdentityCommand({}));
			if (identity.Account) {
				profile.awsSettings.awsAccountId = identity.Account;
			}
		} catch {
			// Non-fatal — account ID is informational
		}

		// NOTE: this literal does NOT spread the existing infrastructureState, so
		// every field set during the wizard must be reconstructed here or it is
		// lost. Keep this in sync with updateInfraState()'s spread. The Cognito
		// state is grouped into one nested object to make that one field, not many.
		profile.infrastructureState = {
			status: 'deployed',
			fullStackName: this.cfManager.getStackName(this.config.variantName || '', 'full'),
			certStackName: (this.config.customDomain && !this.certReused)
				? this.cfManager.getStackName(this.config.variantName || '', 'cert')
				: undefined,
			customDomain: this.config.customDomain || undefined,
			useRoute53: this.config.useRoute53 || false,
			hostedZoneId: this.config.hostedZoneId || undefined,
			hostedZoneName: this.config.hostedZoneName || undefined,
			certificateArn: this.certArn || undefined,
			certificateReused: this.certReused || undefined,
			lastDeployTimestamp: Date.now(),
			region: this.config.region,
			variantName: this.config.variantName,
			originAccessMethod: this.config.originAccessMethod || 'oac',
			authLambdaEdgeArn: this.config.authLambdaEdgeArn || undefined,
			readGateMode: this.config.readGateMode || 'none',
			cognitoAuth: this.buildCognitoAuthState(),
			passwordAuth: this.buildPasswordAuthState(),
			comment: this.buildCommentState(),
			chat: this.buildChatState(),
		};

		// Persist read-gate intent (mode + low-sensitivity hash for redeploys).
		profile.readGate = (this.config.readGateMode && this.config.readGateMode !== 'none')
			? { mode: this.config.readGateMode, passwordHash: this.config.passwordHash }
			: undefined;

		// Persist author intent (re-shown when the wizard reopens); secret is never stored.
		if (this.cognitoPoolNeeded()) {
			profile.cognitoAuth = {
				enabled: true,
				commentIdentity: this.config.commentIdentityEnabled || false,
				googleClientId: this.config.googleClientId || undefined,
				authDomainPrefix: this.config.authDomainPrefix || undefined,
			};
		} else {
			profile.cognitoAuth = undefined;
		}

		profile.commenting = (this.config.commentingEnabled && this.commentOutputs)
			? { enabled: true }
			: undefined;

		profile.chat = (this.config.chatEnabled && this.chatOutputs)
			? { enabled: true, sync: this.config.chatSync || 'auto', modelId: this.config.chatModelArn }
			: undefined;

		await this.plugin.saveSettings();
		this.refreshSettingsTab();
		new Notice('Profile settings updated from stack outputs.');

		// Push initial site assets so the deployed site has content immediately.
		// Without this the bucket stays empty and CloudFront returns S3 "Access
		// Denied" (OAC grants GetObject only — a missing index.html is a 403, not a
		// 404). pushSiteAssetsToS3 catches its own errors and returns false rather
		// than throwing, so a failure here never marks the deploy failed; surface an
		// actionable hint and bust the edge cache on success.
		const seeded = await pushSiteAssetsToS3(this.plugin, profile.id);
		if (seeded) {
			await createCloudFrontInvalidation(this.plugin, profile.id);
		} else {
			new Notice(
				'Infrastructure deployed, but the initial site assets could not be uploaded. Use Settings → "Push site assets" to retry.',
				10000,
			);
		}
	}

	/**
	 * Assemble the persisted Cognito deployment bookkeeping from captured stack
	 * outputs. Returns undefined when built-in auth was not deployed in this run.
	 */
	private buildCognitoAuthState() {
		if (!this.cognitoPoolNeeded() || !this.cognitoOutputs) return undefined;
		return {
			stackName: this.cognitoStackName,
			enabled: true,
			commentIdentity: this.config.commentIdentityEnabled || false,
			userPoolId: this.cognitoOutputs.userPoolId,
			userPoolClientId: this.cognitoOutputs.userPoolClientId,
			hostedUiDomain: this.cognitoOutputs.hostedUiDomain,
			jwksUri: this.cognitoOutputs.jwksUri,
			issuer: this.cognitoOutputs.issuer,
			edgeFunctionVersionArn: this.cognitoOutputs.edgeFunctionVersionArn,
			callbackApiDomain: this.cognitoOutputs.callbackApiDomain,
			googleClientId: this.config.googleClientId || undefined,
			authDomainPrefix: this.config.authDomainPrefix || undefined,
		};
	}

	/** Password read-gate deployment bookkeeping, or undefined when not deployed this run. */
	private buildPasswordAuthState() {
		if (this.config.readGateMode !== 'password' || !this.passwordEdgeArn) return undefined;
		return {
			stackName: this.passwordStackName,
			edgeFunctionVersionArn: this.passwordEdgeArn,
			passwordHash: this.config.passwordHash,
		};
	}

	/** Comment-stack deployment bookkeeping, or undefined when not deployed this run. */
	private buildCommentState() {
		if (!this.config.commentingEnabled || !this.commentOutputs) return undefined;
		return {
			stackName: this.commentStackName,
			enabled: true,
			bucketName: this.commentOutputs.bucketName,
			bucketDomainName: this.commentOutputs.bucketDomainName,
			apiDomain: this.commentOutputs.apiDomain,
			tableName: this.commentOutputs.tableName,
		};
	}

	/** Chat-stack deployment bookkeeping, or undefined when not deployed this run. */
	private buildChatState() {
		if (!this.config.chatEnabled || !this.chatOutputs) return undefined;
		const accountId = this.plugin.settings.publishingProfiles.find(p => p.id === this.profile.id)?.awsSettings?.awsAccountId || '';
		return {
			stackName: this.chatStackName,
			enabled: true,
			functionUrlDomainName: this.chatOutputs.functionUrlDomainName,
			knowledgeBaseId: this.chatOutputs.knowledgeBaseId,
			dataSourceId: this.chatOutputs.dataSourceId,
			sync: this.config.chatSync || 'auto',
			modelArn: this.config.chatModelArn
				|| `arn:aws:bedrock:${this.config.region}:${accountId}:inference-profile/us.anthropic.claude-sonnet-5`,
			originSecret: this.config.chatOriginSecret || '',
		};
	}

	private refreshSettingsTab(): void {
		const setting = (this.app as any).setting;
		if (setting?.activeTab?.display) {
			setting.activeTab.display();
		}
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
		return new Promise(resolve => window.setTimeout(resolve, ms));
	}
}
