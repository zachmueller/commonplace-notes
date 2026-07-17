import { Modal, Notice, Setting } from 'obsidian';
import { PublishingProfile } from '../../types';
import { Logger, errorMessage } from '../../utils/logging';
import { ProfileContext } from '../context';

/**
 * Modal to set/clear the viewer-request Lambda@Edge ARN gating an AWS site.
 * Performs a targeted stack update (only the auth ARN; all other params inherited
 * via UsePreviousValue) so it can't prune the comment/auth routes off a working
 * site. On success it persists the ARN and re-renders the profile pane.
 */
export function openAuthLambdaModal(ctx: ProfileContext, profile: PublishingProfile): void {
	const { app, plugin } = ctx;
	const state = profile.infrastructureState;
	if (!state || !profile.awsSettings) return;

	const modal = new Modal(app);
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
						// Pre-deploy hooks (succeed-with-warning; never blocks).
						await plugin.deployHookManager.runDeployHooks('pre', { profile, outputs: null });

						// Targeted update: change ONLY the auth ARN and inherit every
						// other parameter via UsePreviousValue. Rebuilding the full
						// parameter set from this partial config would blank the
						// comment/auth domain params and prune the /auth/*, /comments/*
						// and /api/comments routes off a working site.
						await plugin.cloudFormationManager.updateFullStackAuthLambda(
							state.fullStackName!,
							state.originAccessMethod,
							arnValue,
							profile,
							state.region,
						);

						const finalStatus = await plugin.cloudFormationManager.pollStackUntilComplete(
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
							await plugin.saveSettings();
							// Post-deploy hooks — fire once after the reconcile settles. Guarded so a
							// failed outputs fetch cannot turn a successful update into a failure.
							try {
								const outputs = await plugin.cloudFormationManager.getStackOutputs(
									state.fullStackName!, profile, state.region);
								await plugin.deployHookManager.runDeployHooks('post', { profile, outputs });
							} catch (hookErr) {
								Logger.error('Post-deploy hooks could not run (the stack update still succeeded):', hookErr);
								new Notice('Post-deploy hooks could not run (see console); the update succeeded.');
							}
							modal.close();
							ctx.rerenderProfile();
							new Notice('Infrastructure updated successfully.');
						} else {
							new Notice(`Stack update ended with status: ${finalStatus}`);
							btn.setDisabled(false);
							btn.setButtonText('Update Stack');
						}
					} catch (err: unknown) {
						Logger.error('Error updating auth lambda:', err);
						new Notice(`Update failed: ${errorMessage(err)}`);
						btn.setDisabled(false);
						btn.setButtonText('Update Stack');
					}
				}));
	};

	modal.open();
}
