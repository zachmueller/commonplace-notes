import { Modal, Notice, Setting } from 'obsidian';
import { PublishingProfile } from '../../types';
import { Logger } from '../../utils/logging';
import { ProfileContext } from '../context';
import { appendStackEventLine } from './shared';

/**
 * "Danger Zone" section: destroy infrastructure, force-clean leftovers, orphaned
 * edge cleanup, and delete profile (2-click confirm). `profileContainer` is the
 * element faded out on profile deletion.
 */
export function renderDangerZone(ctx: ProfileContext, containerEl: HTMLElement, profileContainer: HTMLElement): void {
	const { plugin, profile, index } = ctx;

	displayDestroyInfrastructure(ctx, containerEl);
	displayForceCleanLeftovers(ctx, containerEl);
	displayOrphanedEdgeCleanup(ctx, containerEl);

	const deleteButtonContainer = containerEl.createDiv({ cls: 'cpn-profile-delete-container' });

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

						window.setTimeout(() => {
							void (async () => {
								plugin.settings.publishingProfiles.splice(index, 1);
								await plugin.saveSettings();
								plugin.registerProfileCommands();
								ctx.rerenderAll();
							})();
						}, 200);
					}
				});
			return button;
		});

	if (plugin.settings.publishingProfiles.length <= 1) {
		deleteButtonContainer.querySelector('button')?.setAttribute('disabled', 'true');
		deleteButtonContainer.setAttribute('title', 'Cannot delete the last remaining profile');
	}
}

/**
 * "Destroy infrastructure" action. Only rendered for AWS profiles with a live,
 * non-imported deployment. On confirm it tears down the stacks via the shared
 * plugin.destroyInfrastructure(), streaming CloudFormation events into a live
 * log, then refreshes the profile view.
 */
function displayDestroyInfrastructure(ctx: ProfileContext, containerEl: HTMLElement): void {
	const { plugin, profile } = ctx;
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
					const choice = await plugin.confirmDestroyInfrastructure(profile);
					if (!choice.confirmed) return;

					button.setDisabled(true);
					button.setButtonText('Destroying...');
					eventLog.empty();
					eventLog.show();

					try {
						const result = await plugin.destroyInfrastructure(
							profile,
							{ deleteBuckets: choice.deleteBuckets },
							(event) => {
								appendStackEventLine(eventLog, event);
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
						ctx.rerenderProfile();
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
 * "Force-clean leftover infrastructure" action. Shown only when a prior teardown
 * left stacks behind — i.e. status is 'failed' or 'destroying' and the profile
 * still references stacks. Force-deletes the stuck stacks (retaining resources
 * CloudFormation can't remove, e.g. still-replicating Lambda@Edge fns) and, if
 * the user opts in, empties + removes the retained fixed-name S3 buckets so a
 * redeploy doesn't collide.
 */
function displayForceCleanLeftovers(ctx: ProfileContext, containerEl: HTMLElement): void {
	const { plugin, profile } = ctx;
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
					const choice = await confirmForceClean(ctx, profile);
					if (!choice.confirmed) return;

					button.setDisabled(true);
					button.setButtonText('Cleaning...');
					eventLog.empty();
					eventLog.show();

					try {
						const result = await plugin.forceCleanInfrastructure(
							profile,
							{ deleteBuckets: choice.deleteBuckets },
							(event) => {
								appendStackEventLine(eventLog, event);
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
						ctx.rerenderProfile();
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
 * "Clean up orphaned edge resources" action. Shown only when a prior force-clean
 * orphaned Lambda@Edge resources (retained to drain a stuck stack) that are
 * awaiting deletion. Deletion can only succeed once CloudFront has removed the
 * replicas (up to a few hours); the plugin also retries automatically on load,
 * so this button is a manual nudge.
 */
function displayOrphanedEdgeCleanup(ctx: ProfileContext, containerEl: HTMLElement): void {
	const { plugin, profile } = ctx;
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
						const result = await plugin.cleanupOrphanedEdgeResources(profile);
						if (result.stillPending === 0) {
							new Notice('Orphaned edge resources cleaned up.');
						} else {
							new Notice(
								`Cleaned ${result.cleaned}; ${result.stillPending} still replicating. ` +
								'CloudFront can take a few hours to remove edge replicas — try again later.',
							);
						}
						ctx.rerenderProfile();
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
function confirmForceClean(ctx: ProfileContext, profile: PublishingProfile): Promise<{ confirmed: boolean; deleteBuckets: boolean }> {
	return new Promise(resolve => {
		const modal = new Modal(ctx.app);
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
