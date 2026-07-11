import { Notice, Setting } from 'obsidian';
import { PublishingProfile } from '../../types';
import { Logger } from '../../utils/logging';
import { DeploymentWizardModal } from '../../infrastructure/deploymentWizardModal';
import { DnsAssistantModal } from '../../infrastructure/dnsAssistantModal';
import { googleOAuthUrls } from '../../infrastructure/cognitoUrls';
import { ProfileContext } from '../context';
import { openAuthLambdaModal } from '../modals/authLambdaModal';
import { openUpgradePasswordGateModal } from '../modals/passwordGateModal';
import { openImportStackModal } from '../modals/importStack';

/**
 * "Infrastructure" section (AWS profiles): deployment status and the large,
 * state-dependent set of actions — auth Lambda, password gate upgrade, Google
 * OAuth URLs + callback sync, commenting info, sync-from-stack, DNS, deploy,
 * import, and unlink.
 */
export function renderInfrastructureSection(ctx: ProfileContext, containerEl: HTMLElement): void {
	const { app, plugin, profile, index } = ctx;
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
					openAuthLambdaModal(ctx, profile);
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
						openUpgradePasswordGateModal(ctx, profile);
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
								const cfManager = plugin.cloudFormationManager;
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
							plugin.settings.publishingProfiles[index].commentsFeedLimit = num;
							await plugin.saveSettings();
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
						const outputs = await plugin.cloudFormationManager.getStackOutputs(
							state.fullStackName!,
							profile,
							state.region,
						);
						profile.awsSettings!.bucketName = outputs.bucketName;
						profile.awsSettings!.cloudFrontDistributionId = outputs.distributionId;
						profile.baseUrl = `https://${outputs.siteUrl}/`;
						await plugin.saveSettings();
						ctx.rerenderProfile();
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
							app,
							plugin.cloudFormationManager,
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
						app,
						plugin,
						plugin.cloudFormationManager,
						profile,
					).open();
				}));

		new Setting(containerEl)
			.setName('Import existing deployment')
			.setDesc('Scan an AWS account and import your deployed stacks (site, certificate, auth, comments)')
			.addButton(btn => btn
				.setButtonText('Import')
				.onClick(() => {
					openImportStackModal(ctx, profile);
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
							await plugin.unlinkInfrastructure(profile);
							new Notice('Profile unlinked from backend. AWS resources were left running — you can now re-import or redeploy.');
							ctx.rerenderProfile();
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
