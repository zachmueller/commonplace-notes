import { ButtonComponent, Notice, Setting, SettingDefinition, SettingDefinitionGroup, SettingDefinitionRender } from 'obsidian';
import { Logger, errorMessage } from '../../utils/logging';
import { DeploymentWizardModal } from '../../infrastructure/deploymentWizardModal';
import { DnsAssistantModal } from '../../infrastructure/dnsAssistantModal';
import { googleOAuthUrls } from '../../infrastructure/cognitoUrls';
import { PublishingProfile } from '../../types';
import { DefinitionContext } from '../context';
import { openAuthLambdaModal } from '../modals/authLambdaModal';
import { openUpgradePasswordGateModal } from '../modals/passwordGateModal';
import { openImportStackModal } from '../modals/importStack';
import type { InfrastructureState } from '../../infrastructure/types';
import {
	effectiveSessionHours,
	isValidSessionHours,
	MAX_SESSION_HOURS,
	MIN_SESSION_HOURS,
} from '../../infrastructure/cognitoParams';
import {
	bucketCleanupRow,
	MAX_NONCURRENT_VERSION_DAYS,
	MIN_NONCURRENT_VERSION_DAYS,
	parseNoncurrentDays,
} from '../../infrastructure/bucketLifecycle';
import { liveOps } from './liveOps';

type StackEvent = { logicalResourceId: string; status: string };
type Run = <T>(task: (onEvent: (event: StackEvent) => void) => Promise<T>) => Promise<T>;

/**
 * A row whose button starts a long-running operation with a live event log.
 * The log and busy state live in {@link liveOps}, so they survive the row
 * being re-rendered mid-operation. `onClick` gets `run`, which streams the
 * task's events into the log; it handles its own confirmation and notices.
 */
export function liveOpRow(opts: {
	name: string;
	desc?: string;
	aliases?: string[];
	visible?: () => boolean;
	opKey: () => string;
	describe?: (setting: Setting) => void;
	extra?: (setting: Setting) => void;
	label: () => string;
	busyLabel: string;
	cta?: () => boolean;
	destructive?: boolean;
	disabled?: () => boolean;
	onClick: (run: Run) => Promise<void>;
}): SettingDefinitionRender {
	return {
		name: opts.name,
		desc: opts.desc,
		aliases: opts.aliases,
		visible: opts.visible,
		render: setting => {
			opts.describe?.(setting);
			opts.extra?.(setting);
			const key = opts.opKey();
			const logEl = setting.infoEl.createDiv({ cls: 'cpn-wizard-event-log' });
			let button: ButtonComponent | undefined;
			setting.addButton(btn => {
				button = btn;
				btn.setButtonText(opts.label());
				// Not setClass(cond ? 'mod-cta' : ''): an empty class token throws.
				if (opts.cta?.()) btn.setCta();
				if (opts.destructive) btn.setDestructive();
				btn.onClick(() => {
					if (liveOps.isRunning(key)) return;
					void opts.onClick(task => liveOps.run(key, task));
				});
			});
			return liveOps.mount(key, logEl, running => {
				button?.setDisabled(running || (opts.disabled?.() ?? false));
				button?.setButtonText(running ? opts.busyLabel : opts.label());
			});
		},
	};
}

/** A read-only row whose description is computed at render time. */
function infoRow(name: string, opts: { aliases?: string[]; visible: () => boolean; desc: () => string }): SettingDefinition {
	return {
		name,
		aliases: opts.aliases,
		visible: opts.visible,
		render: setting => { setting.setDesc(opts.desc()); },
	};
}

/** A row with one button; the click handler runs as-is. */
function buttonRow(name: string, opts: {
	desc?: string;
	aliases?: string[];
	visible: () => boolean;
	describe?: (setting: Setting) => void;
	label: () => string;
	cta?: boolean;
	onClick: (btn: ButtonComponent) => void | Promise<void>;
}): SettingDefinition {
	return {
		name,
		desc: opts.desc,
		aliases: opts.aliases,
		visible: opts.visible,
		render: setting => {
			opts.describe?.(setting);
			setting.addButton(btn => {
				btn.setButtonText(opts.label());
				if (opts.cta) btn.setCta();
				btn.onClick(() => { void opts.onClick(btn); });
			});
		},
	};
}

const STATUS_LABELS: Record<string, string> = {
	'none': 'Not deployed',
	'cert-deploying': 'Deploying certificate...',
	'cert-deployed': 'Certificate deployed',
	'waiting-dns': 'Waiting for DNS validation',
	'deploying': 'Deploying...',
	'deployed': 'Deployed',
	'failed': 'Failed',
	'destroying': 'Destroying...',
};

/** Whether a Cognito-backed site needs the gate upgrade, and what to call it. */
function cognitoGatePlan(profile: PublishingProfile, state: InfrastructureState) {
	const cognito = state.cognitoAuth!;
	// A public site that opted in to access groups needs the public-reads edge
	// fn deployed AND attached; the upgrade does both.
	const publicGating = (state.readGateMode ?? 'none') === 'none' && !!profile.publicSiteAccessGroups;
	const needsUpgrade = !cognito.accessGroupsKey
		|| (state.readGateMode === 'cognito' && !cognito.edgeStackName)
		|| (publicGating && (!cognito.edgeStackName || !cognito.edgePublicReads
			|| state.authLambdaEdgeArn !== cognito.edgeFunctionVersionArn));
	const upgradeLabel = publicGating ? 'Deploy access-groups edge function' : 'Upgrade Cognito gate';
	return { publicGating, needsUpgrade, label: needsUpgrade ? upgradeLabel : 'Redeploy' };
}

/**
 * "Infrastructure" group (AWS profiles): deployment status and the large,
 * state-dependent set of actions — auth Lambda, password gate upgrade, Cognito
 * gate upgrade + sign-in session length, bucket cleanup rule, Google OAuth
 * URLs + callback sync, commenting info, sync-from-stack, DNS, deploy, import,
 * and unlink. Every row reads the profile's state when it renders, so the
 * group follows deploys without being rebuilt.
 */
export function infrastructureGroup(ctx: DefinitionContext, profile: PublishingProfile): SettingDefinitionGroup {
	const { app, plugin } = ctx;
	const ref = ctx.refs.refFor(profile);
	const state = () => profile.infrastructureState;
	const status = () => state()?.status || 'none';
	const deployed = () => status() === 'deployed' && !!state();
	const cognitoLive = () => deployed() && !!state()?.cognitoAuth?.stackName && !state()?.imported;
	const hostedUi = () => deployed() && !!state()?.cognitoAuth?.hostedUiDomain;
	const commenting = () => deployed() && !!profile.commenting?.enabled && !!state()?.cognitoAuth?.commentIdentity;
	const isLinked = () => status() !== 'none'
		|| !!state()?.fullStackName
		|| !!state()?.certStackName
		|| !!profile.awsSettings?.bucketName
		|| !!profile.awsSettings?.cloudFrontDistributionId;

	const items: SettingDefinition[] = [
		{
			name: 'Status',
			desc: 'Deployment status of this profile\'s AWS stacks.',
			aliases: ['deployment', 'stack', 'infrastructure'],
			render: setting => {
				const s = status();
				setting.setDesc(STATUS_LABELS[s] || s);
				const badge = setting.nameEl.createSpan({ cls: 'cpn-infra-status-badge' });
				badge.addClass(s === 'deployed' ? 'cpn-infra-status-deployed'
					: s === 'failed' ? 'cpn-infra-status-failed'
						: s === 'none' ? 'cpn-infra-status-none'
							: 'cpn-infra-status-pending');
			},
		},
		infoRow('Stack', {
			aliases: ['CloudFormation'],
			visible: () => deployed() && !!state()?.fullStackName,
			desc: () => `${state()?.fullStackName ?? ''} (${state()?.region || 'unknown region'})`,
		}),
		infoRow('Domain', {
			aliases: ['custom domain'],
			visible: () => deployed() && !!state()?.customDomain,
			desc: () => state()?.customDomain ?? '',
		}),
		infoRow('Origin Access', {
			aliases: ['OAC', 'OAI'],
			visible: deployed,
			desc: () => state()?.originAccessMethod === 'oac' ? 'OAC (Modern)' : 'OAI (Legacy)',
		}),
		buttonRow('Auth Lambda@Edge', {
			aliases: ['authentication', 'edge function', 'BYO'],
			visible: deployed,
			describe: setting => { setting.setDesc(state()?.authLambdaEdgeArn || 'Not configured'); },
			label: () => state()?.authLambdaEdgeArn ? 'Update' : 'Configure',
			onClick: () => openAuthLambdaModal(ctx, profile),
		}),
		bucketCleanupDefinition(ctx, profile, ref, deployed),
		// Password read-gate: offer an in-place upgrade to the S3-asset edge
		// packaging (escapes the 4096-byte inline cap and Safari ITP cookie
		// limits). Shown only for password-gated sites.
		buttonRow('Password gate', {
			desc: 'Rebuild the password gate on the latest edge function (S3-asset packaging).',
			aliases: ['password', 'upgrade'],
			visible: () => deployed() && state()?.readGateMode === 'password' && !!state()?.passwordAuth?.stackName,
			label: () => 'Upgrade',
			onClick: () => openUpgradePasswordGateModal(ctx, profile),
		}),
		// Cognito gate: migrate legacy pools (inline edge fn) to the separate
		// S3-asset edge stack and add the pre-token trigger that per-note access
		// groups need. Idempotent, so it doubles as "redeploy the latest edge fn".
		liveOpRow({
			name: 'Cognito gate',
			desc: 'Upgrade or redeploy the sign-in edge function and group-membership trigger.',
			aliases: ['sign-in', 'login', 'Google', 'access groups', 'upgrade'],
			visible: cognitoLive,
			opKey: () => `${ref}:cognito-gate`,
			describe: setting => {
				const s = state();
				if (!s?.cognitoAuth) return;
				const plan = cognitoGatePlan(profile, s);
				setting.setDesc(plan.needsUpgrade
					? (plan.publicGating
						? 'Needed for access groups on this public site: adds the group-membership trigger to the sign-in pool and attaches the '
							+ 'access-groups edge function (public notes stay anonymous; every request runs it). The site stays up; takes several minutes.'
						: 'Upgrade required for per-note access groups: moves the sign-in edge function to its own stack and adds the group-membership trigger. The site stays up; takes several minutes.')
					: 'Up to date. Re-run to redeploy the latest edge function and trigger code.');
			},
			label: () => {
				const s = state();
				return s?.cognitoAuth ? cognitoGatePlan(profile, s).label : 'Redeploy';
			},
			cta: () => {
				const s = state();
				return !!s?.cognitoAuth && cognitoGatePlan(profile, s).needsUpgrade;
			},
			busyLabel: 'Working...',
			onClick: async run => {
				try {
					const result = await run(onEvent => plugin.cloudFormationManager.upgradeCognitoGate(profile, onEvent));
					new Notice(result.legacyOrphaned
						? 'Cognito gate upgraded. The old edge function is queued for cleanup once CloudFront releases it.'
						: 'Cognito gate is up to date.');
					// Membership and site config depend on the new state.
					await plugin.syncAccessGroups(profile, { force: true });
					ctx.refresh();
				} catch (err: unknown) {
					Logger.error('Error upgrading the Cognito gate:', err);
					new Notice(`Cognito gate upgrade failed: ${errorMessage(err)}`);
				}
			},
		}),
		sessionLengthDefinition(ctx, profile, ref, cognitoLive),
		// Google sign-in: the Cognito Hosted UI URLs the user must register in
		// their Google OAuth client, persisted from the deploy and shown here
		// (with copy buttons) so they're always retrievable.
		// Render rows also run while hidden, so read state defensively.
		copyRow('Google authorized JavaScript origin', hostedUi, () => {
			const domain = state()?.cognitoAuth?.hostedUiDomain;
			return domain ? googleOAuthUrls(domain).jsOrigin : '';
		}),
		copyRow('Google authorized redirect URI', hostedUi, () => {
			const domain = state()?.cognitoAuth?.hostedUiDomain;
			return domain ? googleOAuthUrls(domain).redirectUri : '';
		}),
		// Re-sync the Cognito OAuth callback URL to the current site domain. The
		// wizard sets this callback only once, at initial deploy; if the site
		// domain / baseUrl changes afterward, the published sign-in link sends a
		// redirect_uri the app client no longer trusts ("redirect_mismatch").
		// This re-points the app client callback (and the callback Lambda's
		// REDIRECT_URI) at baseUrl + /auth/callback, keeping the Google secret.
		buttonRow('Sync Google sign-in with site domain', {
			aliases: ['callback', 'redirect_mismatch', 'Google', 'sign-in'],
			visible: () => hostedUi() && !!profile.baseUrl,
			describe: setting => {
				setting.setDesc(`Points Cognito's OAuth callback at ${callbackUrl(profile)}. `
					+ 'Run this after changing the custom domain or site URL — otherwise '
					+ 'sign-in fails with a "redirect_mismatch" error.');
			},
			label: () => 'Sync callback URL',
			onClick: async btn => {
				const url = callbackUrl(profile);
				btn.setDisabled(true);
				btn.setButtonText('Syncing...');
				try {
					const cfManager = plugin.cloudFormationManager;
					const stackName = cfManager.getStackName(state()?.variantName || '', 'cognito');
					await cfManager.updateCognitoCallbackUrl(stackName, url, profile);
					const finalStatus = await cfManager.pollStackUntilComplete(stackName, profile, () => {}, 'us-east-1');
					if (finalStatus === 'UPDATE_COMPLETE') {
						new Notice(`Google sign-in callback synced to ${url}.`);
					} else {
						new Notice(`Stack update ended with status: ${finalStatus}`);
					}
				} catch (err: unknown) {
					Logger.error('Error syncing Cognito callback URL:', err);
					new Notice(`Sync failed: ${errorMessage(err)}`);
				} finally {
					btn.setDisabled(false);
					btn.setButtonText('Sync callback URL');
				}
			},
		}),
		// Commenting: the widget only renders on published note pages, so a
		// deployed-but-empty site shows nothing. Point the user at the action
		// that makes comments appear.
		{
			name: 'Commenting',
			desc: 'Enabled. The comment box appears on published note pages — '
				+ 'run "Publish all notes" and open a note to see it.',
			aliases: ['comments'],
			visible: commenting,
		},
		// Commenter [[ ]] note-link autocomplete is powered by the published
		// content index ("Include site-wide content search" under Content).
		infoRow('Note links in comments', {
			aliases: ['comments', 'wikilinks', 'autocomplete'],
			visible: commenting,
			desc: () => profile.publishContentIndex
				? 'Enabled. Commenters can autocomplete and link to other notes '
					+ 'with [[ ]]; links are stored as note UIDs so they survive renames.'
				: 'Turn on "Include site-wide content search" (under Content) to let '
					+ 'commenters autocomplete and link to other notes with [[ ]]. '
					+ 'Without it, autocomplete is unavailable and existing [[ ]] links '
					+ 'render greyed-out.',
		}),
		{
			name: 'Recent comments to load per refresh',
			desc: 'How many recent comments the Recent Comments panel pulls from DynamoDB on each refresh. Default 25.',
			aliases: ['comments', 'feed', 'limit'],
			visible: commenting,
			control: {
				type: 'number',
				key: ctx.profileKey(profile, 'commentsFeedLimit'),
				defaultValue: 25,
				min: 1,
				max: 200,
				step: 1,
				placeholder: '25',
				validate: (v: number) => Number.isInteger(v) ? undefined : 'Enter a whole number.',
			},
		},
		infoRow('Recent comments last refreshed', {
			aliases: ['comments'],
			visible: () => commenting() && !!profile.commentsLastRefreshed,
			desc: () => new Date(profile.commentsLastRefreshed ?? 0).toLocaleString(),
		}),
		{
			name: 'Imported stack',
			desc: 'This stack was imported and is managed externally via CDK.',
			aliases: ['CDK', 'import'],
			visible: () => deployed() && !!state()?.imported,
		},
		buttonRow('Sync settings from stack', {
			desc: 'Copy the bucket, distribution ID and site URL from the deployed stack\'s outputs into this profile.',
			aliases: ['outputs', 'bucket', 'distribution'],
			visible: () => deployed() && !!state()?.fullStackName,
			label: () => 'Sync',
			onClick: async () => {
				const s = state();
				if (!s?.fullStackName) return;
				try {
					const outputs = await plugin.cloudFormationManager.getStackOutputs(s.fullStackName, profile, s.region);
					profile.awsSettings!.bucketName = outputs.bucketName;
					profile.awsSettings!.cloudFrontDistributionId = outputs.distributionId;
					profile.baseUrl = `https://${outputs.siteUrl}/`;
					await ctx.save();
					ctx.refresh();
				} catch (err: unknown) {
					Logger.error('Error syncing stack outputs:', err);
				}
			},
		}),
		// A reused cert is already ISSUED — DNS validation is not applicable.
		buttonRow('DNS records', {
			desc: 'Certificate validation and domain records for this site.',
			aliases: ['DNS', 'certificate', 'Route 53', 'domain'],
			visible: () => {
				const s = state();
				return deployed() && !!s && (s.status === 'waiting-dns' || !!s.certificateArn) && !s.certificateReused;
			},
			label: () => 'Manage DNS',
			onClick: () => new DnsAssistantModal(app, plugin.cloudFormationManager, profile).open(),
		}),
		buttonRow('Deploy infrastructure', {
			desc: 'Create the S3 bucket, CloudFront distribution and optional sign-in, password gate and comments for this site.',
			aliases: ['deploy', 'wizard', 'CloudFormation', 'setup'],
			visible: () => status() === 'none',
			label: () => 'Deploy Infrastructure',
			cta: true,
			onClick: () => new DeploymentWizardModal(app, plugin, plugin.cloudFormationManager, profile).open(),
		}),
		buttonRow('Import existing deployment', {
			desc: 'Scan an AWS account and import your deployed stacks (site, certificate, auth, comments)',
			aliases: ['import', 'scan', 'CDK'],
			visible: () => status() === 'none',
			label: () => 'Import',
			onClick: () => openImportStackModal(ctx, profile),
		}),
		// "Unlink from AWS backend" clears the (re-derivable) backend link so a
		// profile stuck with a partial/broken link (commonly an old, buggy
		// import) can re-run the import. It makes NO AWS calls and works even
		// for imported stacks. Shown once there is a link to clear.
		{
			name: 'Unlink from AWS backend',
			desc: 'Disconnect this profile from its AWS backend without deleting anything in AWS. '
				+ 'Your published site, S3 buckets, CloudFront distribution, and any comments keep running '
				+ '(and keep incurring cost). Local publish history and note mappings are preserved. '
				+ 'Use this to recover from a broken import and re-run the import cleanly.',
			aliases: ['disconnect', 'reset', 'unlink'],
			visible: isLinked,
			render: setting => {
				setting.addButton(button => twoClickConfirm(button, {
					label: 'Unlink',
					confirmLabel: 'Click again to confirm unlink',
					busyLabel: 'Unlinking...',
					run: async () => {
						await plugin.unlinkInfrastructure(profile);
						new Notice('Profile unlinked from backend. AWS resources were left running — you can now re-import or redeploy.');
						ctx.refresh();
					},
					onError: err => {
						Logger.error('Error unlinking infrastructure:', err);
						new Notice(`Failed to unlink: ${errorMessage(err)}`);
					},
				}));
			},
		},
	];

	return {
		type: 'group',
		heading: 'Infrastructure',
		visible: () => profile.publishMechanism === 'AWS',
		items,
	};
}

function callbackUrl(profile: PublishingProfile): string {
	return (profile.baseUrl ?? '').replace(/\/+$/, '') + '/auth/callback';
}

function copyRow(name: string, visible: () => boolean, value: () => string): SettingDefinition {
	return {
		name,
		aliases: ['Google', 'OAuth', 'sign-in', 'Cognito'],
		visible,
		render: setting => {
			const v = value();
			setting.setDesc(v);
			setting.addButton(btn => btn
				.setButtonText('Copy')
				.onClick(() => {
					void navigator.clipboard.writeText(v);
					new Notice('Copied!');
				}));
		},
	};
}

/**
 * A button that needs two clicks within 3 s: the first arms it, the second
 * runs `run`. Used where a full confirmation dialog would be heavier than the
 * action (unlink, delete profile).
 */
export function twoClickConfirm(button: ButtonComponent, opts: {
	label: string;
	confirmLabel: string;
	busyLabel: string;
	run: () => Promise<void>;
	onError: (err: unknown) => void;
}): ButtonComponent {
	let armed = false;
	const reset = () => {
		armed = false;
		button.setButtonText(opts.label);
		button.buttonEl.removeClass('mod-error');
		button.setClass('mod-warning');
	};
	reset();
	button.onClick(async () => {
		if (!armed) {
			armed = true;
			button.setButtonText(opts.confirmLabel);
			button.buttonEl.removeClass('mod-warning');
			button.setClass('mod-error');
			window.setTimeout(() => { if (armed) reset(); }, 3000);
			return;
		}
		armed = false;
		button.setDisabled(true);
		button.setButtonText(opts.busyLabel);
		try {
			await opts.run();
		} catch (err) {
			opts.onError(err);
			button.setDisabled(false);
			reset();
		}
	});
	return button;
}

/**
 * "Sign-in session length": the pool's token lifetime and cookie Max-Age.
 * Existing pools keep their length (1 h if deployed before this setting)
 * until the author applies a new one here. The value lives in the deployed
 * stack (infrastructureState), so this is an input + Apply, not a control.
 */
function sessionLengthDefinition(ctx: DefinitionContext, profile: PublishingProfile, ref: string, visible: () => boolean): SettingDefinition {
	const { plugin } = ctx;
	const cognito = () => profile.infrastructureState?.cognitoAuth;
	// Pools not on the current template (no access-groups key) may still hold
	// the old inline edge function, which the current template would remove
	// without the upgrade's retain step. The manager re-checks the template.
	const blocked = () => !cognito()?.accessGroupsKey;
	let hours = 0;
	return liveOpRow({
		name: 'Sign-in session length',
		desc: 'How long a reader stays signed in, in hours.',
		aliases: ['session', 'sign-in', 'login', 'cookie', 'hours'],
		visible,
		opKey: () => `${ref}:session-length`,
		describe: setting => {
			const c = cognito();
			if (!c) return;
			const current = effectiveSessionHours(c);
			const tradeOff = 'Longer sessions mean fewer sign-ins and media that keeps playing, '
				+ 'but a reader removed from a group keeps access for up to one session length.';
			setting.setDesc(blocked()
				? 'Run Upgrade Cognito gate first.'
				: c.sessionHours === undefined
					? `This site uses 1-hour sessions, Cognito's default when it was deployed. ${tradeOff}`
					: `Currently ${current} hour${current === 1 ? '' : 's'}. ${tradeOff} Applies at each reader's next sign-in.`);
			if (blocked()) setting.descEl.addClass('mod-warning');
		},
		extra: setting => {
			const c = cognito();
			hours = c ? effectiveSessionHours(c) : 0;
			setting.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = String(MIN_SESSION_HOURS);
				text.inputEl.max = String(MAX_SESSION_HOURS);
				text.inputEl.addClass('cpn-session-hours');
				text.setValue(String(hours))
					.setDisabled(blocked())
					.onChange(v => { hours = Number(v); });
			});
		},
		label: () => 'Apply',
		busyLabel: 'Applying...',
		disabled: blocked,
		onClick: async run => {
			if (!isValidSessionHours(hours)) {
				new Notice(`Enter a whole number of hours from ${MIN_SESSION_HOURS} to ${MAX_SESSION_HOURS}.`);
				return;
			}
			const target = hours;
			try {
				await run(onEvent => plugin.cloudFormationManager.updateCognitoSessionLength(profile, target, onEvent));
				new Notice(`Sign-in sessions now last ${target} hour${target === 1 ? '' : 's'}, from each reader's next sign-in.`);
				ctx.refresh();
			} catch (err: unknown) {
				Logger.error('Error changing the sign-in session length:', err);
				new Notice(`Session length change failed: ${errorMessage(err)}`);
			}
		},
	});
}

/**
 * "Bucket cleanup rule": how long the site bucket keeps noncurrent object
 * versions (0 = indefinitely); abandoned multipart uploads are aborted after
 * 7 days either way. Sites deployed before the rule keep their old versions
 * until the author applies it here. Imported stacks are managed in CDK.
 */
function bucketCleanupDefinition(ctx: DefinitionContext, profile: PublishingProfile, ref: string, deployed: () => boolean): SettingDefinition {
	const { plugin } = ctx;
	const row = () => bucketCleanupRow(profile.infrastructureState);
	let raw = '';
	const op = liveOpRow({
		name: 'Bucket cleanup rule',
		desc: 'How long the site bucket keeps old versions of replaced or deleted files.',
		aliases: ['S3', 'lifecycle', 'versions', 'storage cost'],
		opKey: () => `${ref}:bucket-cleanup`,
		describe: setting => {
			const r = row();
			if (r.kind === 'editable') setting.setDesc(r.desc);
		},
		extra: setting => {
			const r = row();
			raw = r.kind === 'editable' ? String(r.initialDays) : '';
			setting.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = String(MIN_NONCURRENT_VERSION_DAYS);
				text.inputEl.max = String(MAX_NONCURRENT_VERSION_DAYS);
				text.inputEl.addClass('cpn-bucket-lifecycle-days');
				text.setPlaceholder('Days')
					.setValue(raw)
					.onChange(v => { raw = v; });
			});
		},
		label: () => 'Apply',
		cta: () => {
			const r = row();
			return r.kind === 'editable' && r.current === undefined;
		},
		busyLabel: 'Applying...',
		onClick: async run => {
			const days = parseNoncurrentDays(raw);
			if (days === null) {
				new Notice(`Enter a whole number of days from ${MIN_NONCURRENT_VERSION_DAYS} to ${MAX_NONCURRENT_VERSION_DAYS} (0 keeps old versions).`);
				return;
			}
			try {
				await run(onEvent => plugin.cloudFormationManager.updateBucketLifecycle(profile, days, onEvent));
				new Notice(days === 0
					? 'Bucket cleanup rule applied: old versions are kept, abandoned uploads are removed after 7 days.'
					: `Bucket cleanup rule applied: old versions are deleted ${days} day${days === 1 ? '' : 's'} after they're replaced or deleted.`);
				ctx.refresh();
			} catch (err: unknown) {
				Logger.error('Error applying the bucket cleanup rule:', err);
				new Notice(`Bucket cleanup rule change failed: ${errorMessage(err)}`);
			}
		},
	});
	// Imported stacks are managed in CDK: the same row, read-only.
	return {
		...op,
		visible: () => deployed() && row().kind !== 'hidden',
		render: (setting, group) => {
			const r = row();
			if (r.kind === 'imported') {
				setting.setDesc(r.desc);
				return;
			}
			return op.render(setting, group);
		},
	};
}
