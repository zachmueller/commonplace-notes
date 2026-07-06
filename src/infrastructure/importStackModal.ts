import { App, Modal, Notice, Setting } from 'obsidian';
import type CommonplaceNotesPlugin from '../main';
import type { PublishingProfile } from '../types';
import {
	CloudFormationManager,
	mapCognitoOutputs,
	mapCommentOutputs,
	mapPasswordOutputs,
	mapSiteOutputs,
} from './cloudFormationManager';
import type {
	CognitoAuthState,
	CommentState,
	DiscoveredStack,
	InfrastructureState,
	PasswordAuthState,
	ReadGateMode,
	StackRole,
} from './types';
import { Logger } from '../utils/logging';

/** us-east-1 always hosts the certificate and Lambda@Edge auth stacks. */
const EDGE_REGION = 'us-east-1';

/** The importable roles (excludes 'unknown') in the order slots are populated. */
const ROLE_ORDER: StackRole[] = ['full', 'cert', 'cognito', 'password', 'comment'];

const ROLE_LABELS: Record<StackRole, string> = {
	full: 'Site',
	cert: 'Certificate',
	cognito: 'Read-gate: Cognito',
	password: 'Read-gate: Password',
	comment: 'Comments',
	unknown: 'Unrecognized',
};

/** Per-row selection state, keyed by `${region}:${stackName}`. */
interface RowState {
	stack: DiscoveredStack;
	checked: boolean;
	/** Effective role after any manual override; 'ignore' excludes the row entirely. */
	role: StackRole | 'ignore';
}

/**
 * Two-phase "import existing deployment" modal. Phase 1 collects AWS credentials
 * + the site region and scans (site region + us-east-1) for this plugin's stacks;
 * phase 2 presents them auto-detected, role-grouped and pre-checked for the user
 * to confirm, then reconstructs the profile's infrastructureState from the
 * already-fetched Outputs/Parameters (no second round trip).
 *
 * Imported stacks are recorded with imported:true — teardown/updates stay blocked
 * (they are treated as externally managed via CDK).
 */
export class ImportStackModal extends Modal {
	private plugin: CommonplaceNotesPlugin;
	private cfManager: CloudFormationManager;
	private profile: PublishingProfile;
	private onImported: () => void;

	private phase: 'input' | 'results' = 'input';
	private awsProfileName: string;
	private awsAccountId: string;
	private siteRegion: string;

	private discovered: DiscoveredStack[] = [];
	private rows: Map<string, RowState> = new Map();
	/** Selected cpn:profile tag filter, or '__all__' for untagged/all stacks. */
	private profileFilter: string = '__all__';
	/** When both a cognito and password gate are selected, which one gates reads. */
	private readGateChoice: 'cognito' | 'password' = 'cognito';

	constructor(
		app: App,
		plugin: CommonplaceNotesPlugin,
		cfManager: CloudFormationManager,
		profile: PublishingProfile,
		onImported: () => void,
	) {
		super(app);
		this.plugin = plugin;
		this.cfManager = cfManager;
		this.profile = profile;
		this.onImported = onImported;

		this.awsProfileName = profile.awsSettings?.awsProfile || '';
		this.awsAccountId = profile.awsSettings?.awsAccountId || '';
		this.siteRegion = profile.awsSettings?.region || 'us-east-1';
	}

	onOpen(): void {
		this.modalEl.addClass('cpn-wizard-modal');
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		this.contentEl.empty();
		if (this.phase === 'input') {
			this.renderInputPhase();
		} else {
			this.renderResultsPhase();
		}
	}

	// ---- Phase 1: credentials + region -------------------------------------

	private renderInputPhase(): void {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'Import Existing Deployment' });
		contentEl.createEl('p', {
			text: 'Scan an AWS account for CommonplaceNotes stacks (site, certificate, auth, and comments) and import them all. Both the site region and us-east-1 are scanned, since certificate and Lambda@Edge auth stacks always live in us-east-1.',
			cls: 'cpn-wizard-description',
		});

		new Setting(contentEl)
			.setName('AWS profile')
			.setDesc('The AWS CLI/SSO profile that has credentials for this account')
			.addText(text => text
				.setPlaceholder('notes')
				.setValue(this.awsProfileName)
				.onChange(v => { this.awsProfileName = v; }));

		new Setting(contentEl)
			.setName('AWS account ID (optional)')
			.setDesc('Used for display/verification only')
			.addText(text => text
				.setPlaceholder('123456789012')
				.setValue(this.awsAccountId)
				.onChange(v => { this.awsAccountId = v; }));

		new Setting(contentEl)
			.setName('Site region')
			.setDesc('AWS region where the site (and comment) stacks are deployed')
			.addText(text => text
				.setValue(this.siteRegion)
				.onChange(v => { this.siteRegion = v; }));

		const errorEl = contentEl.createEl('p', { cls: 'cpn-wizard-error' });
		errorEl.hide();

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => this.close()))
			.addButton(btn => btn
				.setButtonText('Scan for stacks')
				.setCta()
				.onClick(async () => {
					if (!this.awsProfileName || !this.siteRegion) {
						errorEl.setText('AWS profile and site region are required.');
						errorEl.show();
						return;
					}
					errorEl.hide();
					btn.setDisabled(true).setButtonText('Scanning…');
					try {
						// Explicit-param discovery — no profile mutation happens here.
						this.discovered = await this.cfManager.listCpnStacks(
							this.awsProfileName,
							[this.siteRegion, EDGE_REGION],
						);
						this.initRows();
						this.phase = 'results';
						this.render();
					} catch (err: any) {
						Logger.error('Error scanning for stacks:', err);
						errorEl.setText(`Scan failed: ${err.message}`);
						errorEl.show();
						btn.setDisabled(false).setButtonText('Scan for stacks');
					}
				}));
	}

	/** Seed per-row selection: pre-check healthy, confidently-detected stacks. */
	private initRows(): void {
		this.rows.clear();
		for (const stack of this.discovered) {
			this.rows.set(this.rowKey(stack), {
				stack,
				checked: stack.healthy && stack.role !== 'unknown',
				role: stack.role,
			});
		}

		// Default the profile-tag filter to this profile's own tag when present,
		// else the first tag seen, else "all".
		const tags = Array.from(new Set(this.discovered.map(s => s.profileTag).filter(Boolean))) as string[];
		if (tags.includes(this.profile.id)) {
			this.profileFilter = this.profile.id;
		} else if (tags.length > 0) {
			this.profileFilter = tags[0];
		} else {
			this.profileFilter = '__all__';
		}

		// Seed the read-gate default ONCE (not on every render, which would clobber
		// a user's explicit choice) — from the detected full stack's
		// AuthLambdaEdgeArn parameter vs. each auth stack's edge fn ARN.
		const full = this.discovered.find(s => s.role === 'full');
		const cognito = this.discovered.find(s => s.role === 'cognito');
		const password = this.discovered.find(s => s.role === 'password');
		const arn = full?.parameters['AuthLambdaEdgeArn'] || '';
		if (arn && password && arn === mapPasswordOutputs(password.outputs).edgeFunctionVersionArn) {
			this.readGateChoice = 'password';
		} else if (arn && cognito && arn === mapCognitoOutputs(cognito.outputs).edgeFunctionVersionArn) {
			this.readGateChoice = 'cognito';
		}
	}

	private rowKey(stack: DiscoveredStack): string {
		return `${stack.region}:${stack.stackName}`;
	}

	// ---- Phase 2: results checklist ----------------------------------------

	private renderResultsPhase(): void {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'Import Existing Deployment' });

		if (this.discovered.length === 0) {
			contentEl.createEl('p', {
				text: `No CommonplaceNotes stacks found in ${this.siteRegion} or ${EDGE_REGION}.`,
				cls: 'cpn-wizard-description',
			});
			this.renderResultsButtons(contentEl, false);
			return;
		}

		const distinctTags = Array.from(new Set(this.discovered.map(s => s.profileTag).filter(Boolean))) as string[];
		if (distinctTags.length > 1) {
			contentEl.createEl('p', {
				text: 'Multiple deployments were found in this account. Choose which one to import:',
				cls: 'cpn-wizard-description',
			});
			new Setting(contentEl)
				.setName('Deployment (cpn:profile tag)')
				.addDropdown(dd => {
					for (const tag of distinctTags) dd.addOption(tag, tag);
					dd.addOption('__all__', 'All / untagged');
					dd.setValue(this.profileFilter);
					dd.onChange(v => { this.profileFilter = v; this.render(); });
				});
		}

		const visible = this.visibleStacks();
		if (visible.length === 0) {
			contentEl.createEl('p', {
				text: 'No stacks match the selected deployment.',
				cls: 'cpn-wizard-description',
			});
			this.renderResultsButtons(contentEl, false);
			return;
		}

		contentEl.createEl('p', {
			text: 'Confirm the stacks to import. Roles are auto-detected; adjust any row if needed. Unhealthy stacks cannot be imported.',
			cls: 'cpn-wizard-description',
		});

		// Group by detected role in slot-population order, then unknowns last.
		const order: StackRole[] = [...ROLE_ORDER, 'unknown'];
		for (const role of order) {
			const group = visible.filter(s => s.role === role);
			if (group.length === 0) continue;
			contentEl.createEl('h3', { text: ROLE_LABELS[role] });
			for (const stack of group) this.renderStackRow(contentEl, stack);
		}

		this.renderReadGateSelector(contentEl);
		this.renderResultsButtons(contentEl, true);
	}

	private visibleStacks(): DiscoveredStack[] {
		if (this.profileFilter === '__all__') return this.discovered;
		return this.discovered.filter(s => s.profileTag === this.profileFilter);
	}

	private renderStackRow(container: HTMLElement, stack: DiscoveredStack): void {
		const state = this.rows.get(this.rowKey(stack))!;
		const row = container.createDiv({ cls: 'cpn-import-stack-row' });
		if (!stack.healthy) row.addClass('cpn-import-stack-unhealthy');

		const checkbox = row.createEl('input', { type: 'checkbox' });
		checkbox.checked = state.checked;
		checkbox.disabled = !stack.healthy;
		checkbox.addEventListener('change', () => { state.checked = checkbox.checked; });

		const info = row.createDiv({ cls: 'cpn-import-stack-info' });
		info.createEl('strong', { text: stack.stackName });
		const meta = stack.healthy ? `${stack.region}` : `${stack.region} · ${stack.status}`;
		info.createEl('small', { text: meta });

		// Role-override dropdown (importable roles + "ignore").
		const roleSetting = new Setting(row);
		roleSetting.settingEl.addClass('cpn-import-role-override');
		roleSetting.addDropdown(dd => {
			for (const r of ROLE_ORDER) dd.addOption(r, ROLE_LABELS[r]);
			dd.addOption('unknown', ROLE_LABELS.unknown);
			dd.addOption('ignore', 'Ignore');
			dd.setValue(state.role);
			dd.onChange(v => {
				state.role = v as StackRole | 'ignore';
				// Re-render so the read-gate selector appears/disappears as the
				// set of selected auth roles changes. Rows stay grouped under their
				// originally-detected role (stable positioning); the dropdown value
				// carries the override.
				this.render();
			});
		});
	}

	/** Show a read-gate chooser only when both auth stacks are selected for import. */
	private renderReadGateSelector(container: HTMLElement): void {
		const selected = this.selectedByRole();
		if (!selected.cognito || !selected.password) return;

		new Setting(container)
			.setName('Active read-gate')
			.setDesc('Both a Cognito and a password auth stack were selected. Choose which one gates read access to the site.')
			.addDropdown(dd => {
				dd.addOption('cognito', 'Cognito login');
				dd.addOption('password', 'Password');
				dd.setValue(this.readGateChoice);
				dd.onChange(v => { this.readGateChoice = v as 'cognito' | 'password'; });
			});
	}

	private renderResultsButtons(container: HTMLElement, canImport: boolean): void {
		const setting = new Setting(container)
			.addButton(btn => btn
				.setButtonText('Back')
				.onClick(() => { this.phase = 'input'; this.render(); }))
			.addButton(btn => btn
				.setButtonText('Cancel')
				.onClick(() => this.close()));

		if (canImport) {
			setting.addButton(btn => btn
				.setButtonText('Import selected')
				.setCta()
				.onClick(() => this.importSelected()));
		}
	}

	// ---- Import: reconstruct InfrastructureState ---------------------------

	/** Selected (checked, non-ignored) stacks, at most one per role. */
	private selectedByRole(): Partial<Record<Exclude<StackRole, 'unknown'>, DiscoveredStack>> {
		const byRole: Partial<Record<Exclude<StackRole, 'unknown'>, DiscoveredStack>> = {};
		for (const state of this.rows.values()) {
			if (!state.checked || state.role === 'ignore' || state.role === 'unknown') continue;
			if (!this.isVisible(state.stack)) continue;
			byRole[state.role] = state.stack;
		}
		return byRole;
	}

	private isVisible(stack: DiscoveredStack): boolean {
		if (this.profileFilter === '__all__') return true;
		return stack.profileTag === this.profileFilter;
	}

	/** Detect a duplicate role among the checked rows (blocks import). */
	private findDuplicateRole(): StackRole | null {
		const seen = new Set<string>();
		for (const state of this.rows.values()) {
			if (!state.checked || state.role === 'ignore' || state.role === 'unknown') continue;
			if (!this.isVisible(state.stack)) continue;
			if (seen.has(state.role)) return state.role;
			seen.add(state.role);
		}
		return null;
	}

	private async importSelected(): Promise<void> {
		const dup = this.findDuplicateRole();
		if (dup) {
			new Notice(`Two selected stacks map to the same role (${ROLE_LABELS[dup]}). A profile can track only one stack per role — adjust or ignore one.`);
			return;
		}

		const selected = this.selectedByRole();
		const roles = Object.keys(selected) as Array<Exclude<StackRole, 'unknown'>>;
		if (roles.length === 0) {
			new Notice('Select at least one stack to import.');
			return;
		}

		// Guard against persisting a site stack with no bucket (partial garbage).
		if (selected.full) {
			const site = mapSiteOutputs(selected.full.outputs);
			if (!site.bucketName || !site.distributionId) {
				new Notice('The selected site stack is missing its BucketName/DistributionID outputs — cannot import it.');
				return;
			}
		}

		// Warn (don't block) when selected stacks belong to different variants.
		const suffixes = Array.from(new Set(
			roles.map(r => selected[r]!.variantSuffix).filter(Boolean),
		)) as string[];
		if (suffixes.length > 1) {
			new Notice(`Warning: selected stacks span multiple variants (${suffixes.join(', ')}). Importing anyway.`);
		}

		try {
			this.applyToProfile(selected, suffixes[0]);
			await this.plugin.saveSettings();
			this.close();
			this.onImported();
			const summary = roles.map(r => ROLE_LABELS[r]).join(', ');
			new Notice(`Imported ${roles.length} stack(s): ${summary}.`);
		} catch (err: any) {
			Logger.error('Error importing stacks:', err);
			new Notice(`Import failed: ${err.message}`);
		}
	}

	/**
	 * Reconstruct infrastructureState + profile-level intent from the selected
	 * stacks, mirroring DeploymentWizardModal.applyOutputsToProfile so the result
	 * is shape-identical to a normal deploy (teardown, status, DNS, comments all
	 * read the same slots). Writes awsSettings first (ordering constraint), builds
	 * infrastructureState as a single fresh literal (no spread), and sets
	 * imported:true.
	 */
	private applyToProfile(
		selected: Partial<Record<Exclude<StackRole, 'unknown'>, DiscoveredStack>>,
		variantSuffix: string | undefined,
	): void {
		const profile = this.profile;
		if (!profile.awsSettings) {
			throw new Error('AWS settings missing on profile');
		}

		// Ordering constraint: persist credential/target fields first.
		profile.awsSettings.awsProfile = this.awsProfileName;
		profile.awsSettings.region = this.siteRegion;
		if (this.awsAccountId) profile.awsSettings.awsAccountId = this.awsAccountId;

		const full = selected.full;
		const cert = selected.cert;
		const cognito = selected.cognito;
		const password = selected.password;
		const comment = selected.comment;

		// Base values from the site stack (parameters are authoritative for the
		// bits never emitted as outputs).
		const site = full ? mapSiteOutputs(full.outputs) : undefined;
		const fullParams = full?.parameters || {};
		const originAccessMethod = site?.originAccessIdentityId ? 'oai' : 'oac';
		const authLambdaEdgeArn = fullParams['AuthLambdaEdgeArn'] || undefined;
		const useRoute53 = fullParams['UseRoute53'] === 'true';
		const customDomain = fullParams['CustomDomain'] || undefined;

		// Determine which read-gate is active. When both are present the user's
		// selector wins; otherwise infer from the full stack's AuthLambdaEdgeArn.
		const readGateMode = this.resolveReadGateMode(authLambdaEdgeArn, cognito, password);

		const commentPresent = !!comment;

		// --- Populate role-specific state slots ---
		let cognitoAuth: CognitoAuthState | undefined;
		if (cognito) {
			const o = mapCognitoOutputs(cognito.outputs);
			cognitoAuth = {
				stackName: cognito.stackName,
				enabled: true,
				commentIdentity: commentPresent,
				userPoolId: o.userPoolId,
				userPoolClientId: o.userPoolClientId,
				hostedUiDomain: o.hostedUiDomain,
				jwksUri: o.jwksUri,
				issuer: o.issuer,
				edgeFunctionVersionArn: o.edgeFunctionVersionArn,
				callbackApiDomain: o.callbackApiDomain,
				googleClientId: cognito.parameters['GoogleClientId'] || undefined,
				authDomainPrefix: cognito.parameters['AuthDomainPrefix'] || undefined,
			};
		}

		let passwordAuth: PasswordAuthState | undefined;
		if (password) {
			passwordAuth = {
				stackName: password.stackName,
				edgeFunctionVersionArn: mapPasswordOutputs(password.outputs).edgeFunctionVersionArn,
				// Hash is not recoverable from outputs — a later password update
				// via the wizard requires re-entry.
				passwordHash: undefined,
			};
		}

		let commentState: CommentState | undefined;
		if (comment) {
			const o = mapCommentOutputs(comment.outputs);
			commentState = {
				stackName: comment.stackName,
				enabled: true,
				bucketName: o.bucketName,
				bucketDomainName: o.bucketDomainName,
				apiDomain: o.apiDomain,
				tableName: o.tableName,
			};
		}

		const state: InfrastructureState = {
			status: 'deployed',
			imported: true,
			fullStackName: full?.stackName,
			certStackName: cert?.stackName,
			customDomain,
			useRoute53,
			hostedZoneId: fullParams['HostedZoneId'] || undefined,
			hostedZoneName: fullParams['HostedZoneName'] || undefined,
			certificateArn: cert ? (cert.outputs['CertificateArn'] || undefined) : undefined,
			certificateReused: cert ? false : undefined,
			lastDeployTimestamp: Date.now(),
			region: this.siteRegion,
			variantName: variantSuffix,
			originAccessMethod,
			authLambdaEdgeArn,
			readGateMode,
			cognitoAuth,
			passwordAuth,
			comment: commentState,
		};
		profile.infrastructureState = state;

		// Copy site outputs onto awsSettings/baseUrl (as applyOutputsToProfile does).
		if (site) {
			profile.awsSettings.bucketName = site.bucketName;
			profile.awsSettings.cloudFrontDistributionId = site.distributionId;
			if (site.siteUrl) profile.baseUrl = `https://${site.siteUrl}/`;
		}

		// Mirror profile-level intent so the settings UI and wizard reflect reality.
		profile.readGate = readGateMode !== 'none'
			? { mode: readGateMode, passwordHash: undefined }
			: undefined;
		profile.cognitoAuth = cognito
			? {
				enabled: true,
				commentIdentity: commentPresent,
				googleClientId: cognito.parameters['GoogleClientId'] || undefined,
				authDomainPrefix: cognito.parameters['AuthDomainPrefix'] || undefined,
			}
			: undefined;
		profile.commenting = commentPresent ? { enabled: true } : undefined;
	}

	/**
	 * Decide the active read-gate mode. With both auth stacks selected the user's
	 * explicit choice wins; otherwise match the full stack's AuthLambdaEdgeArn to
	 * whichever auth stack supplies it ('byo' if it matches neither, 'none' if
	 * empty).
	 */
	private resolveReadGateMode(
		authArn: string | undefined,
		cognito?: DiscoveredStack,
		password?: DiscoveredStack,
	): ReadGateMode {
		if (cognito && password) return this.readGateChoice;
		if (!authArn) {
			// No gate ARN on the site — but if exactly one auth stack was picked,
			// treat it as the intended gate.
			if (cognito) return 'cognito';
			if (password) return 'password';
			return 'none';
		}
		if (cognito && authArn === mapCognitoOutputs(cognito.outputs).edgeFunctionVersionArn) return 'cognito';
		if (password && authArn === mapPasswordOutputs(password.outputs).edgeFunctionVersionArn) return 'password';
		return 'byo';
	}
}
