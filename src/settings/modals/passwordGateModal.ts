import { Modal, Notice, Setting } from 'obsidian';
import { PublishingProfile } from '../../types';
import { Logger, errorMessage } from '../../utils/logging';
import { sha256Hex } from '../../infrastructure/deploymentWizardModal';
import type { DeploymentConfig } from '../../infrastructure/types';
import { ProfileContext } from '../context';

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
export function openUpgradePasswordGateModal(ctx: ProfileContext, profile: PublishingProfile): void {
	const { app, plugin } = ctx;
	const state = profile.infrastructureState;
	if (!state || !profile.awsSettings) return;

	const modal = new Modal(app);
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
					const cfm = plugin.cloudFormationManager;
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

						// Pre-deploy hooks (succeed-with-warning; never blocks).
						await plugin.deployHookManager.runDeployHooks('pre', { profile, outputs: null });

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
						await plugin.saveSettings();
						// Post-deploy hooks — fire once after the reconcile settles. Guarded so a
						// failed outputs fetch cannot turn a successful upgrade into a failure.
						try {
							const outputs = await cfm.getStackOutputs(state.fullStackName!, profile, state.region);
							await plugin.deployHookManager.runDeployHooks('post', { profile, outputs });
						} catch (hookErr) {
							Logger.error('Post-deploy hooks could not run (the password upgrade still succeeded):', hookErr);
							new Notice('Post-deploy hooks could not run (see console); the upgrade succeeded.');
						}
						modal.close();
						ctx.rerenderProfile();
						new Notice('Password gate upgraded successfully.');
					} catch (err: unknown) {
						Logger.error('Error upgrading password gate:', err);
						new Notice(`Upgrade failed: ${errorMessage(err)}`);
						btn.setDisabled(false);
						btn.setButtonText('Upgrade');
					}
				}));
	};

	modal.open();
}
