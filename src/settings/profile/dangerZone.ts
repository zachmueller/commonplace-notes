import { Notice, SettingDefinitionPage } from 'obsidian';
import { confirmDestructive } from '../../utils/confirm';
import { PublishingProfile } from '../../types';
import { Logger, errorMessage } from '../../utils/logging';
import { DefinitionContext } from '../context';
import { liveOpRow, twoClickConfirm } from './infrastructure';

/**
 * Confirm dialog for force-clean, with an opt-in "also delete S3 data" toggle
 * (default OFF). Resolves { confirmed, deleteBuckets }.
 */
async function confirmForceClean(ctx: DefinitionContext, profile: PublishingProfile): Promise<{ confirmed: boolean; deleteBuckets: boolean }> {
	const { confirmed, checked } = await confirmDestructive(ctx.app, {
		title: 'Force-clean leftover infrastructure',
		body: `This force-deletes the remaining CloudFormation stacks for profile "${profile.name}", orphaning any resources AWS can't remove yet (e.g. replicating Lambda@Edge functions — AWS cleans those up later). Tick the option below to also empty and remove the retained S3 buckets, which permanently deletes your published site content and any stored comments. This cannot be undone.`,
		checkbox: 'Also delete S3 data (published content + comments)',
		confirmText: 'Force-clean',
	});
	return { confirmed, deleteBuckets: checked };
}

/** Lambda@Edge functions and roles a force-clean orphaned, awaiting deletion. */
function pendingEdgeCount(profile: PublishingProfile): number {
	return (profile.pendingEdgeCleanup ?? []).reduce(
		(n, e) => n + (e.functionName ? 1 : 0) + (e.roleName ? 1 : 0),
		0,
	);
}

/**
 * "Danger Zone" sub-page: destroy infrastructure, force-clean leftovers,
 * orphaned edge cleanup, and delete profile (2-click confirm). Destroy and
 * force-clean confirm in a dialog and stream a live event log.
 */
export function dangerZonePage(ctx: DefinitionContext, profile: PublishingProfile): SettingDefinitionPage {
	const { plugin } = ctx;
	const ref = ctx.refs.refFor(profile);
	const isAws = () => profile.publishMechanism === 'AWS';
	const state = () => profile.infrastructureState;
	const deployedOrFailed = () => isAws() && !!state() && (state()?.status || 'none') !== 'none';

	return {
		type: 'page',
		name: 'Danger Zone',
		desc: 'Destroy infrastructure, force-clean leftovers, delete this profile.',
		items: [
			// Destroy: only for AWS profiles with a live deployment. Imported
			// stacks are managed in CDK and can't be destroyed from here.
			liveOpRow({
				name: 'Destroy infrastructure',
				desc: 'Delete the CloudFormation stacks for this profile. The S3 buckets are retained by default; you can opt to delete them in the confirmation dialog. This cannot be undone.',
				aliases: ['delete stacks', 'tear down', 'CloudFormation', 'remove site'],
				visible: deployedOrFailed,
				opKey: () => `${ref}:destroy`,
				describe: setting => {
					if (state()?.imported) {
						setting.setDesc('This stack was imported and is managed externally via CDK. It cannot be destroyed from the plugin.');
					}
				},
				label: () => 'Destroy infrastructure',
				busyLabel: 'Destroying...',
				destructive: true,
				disabled: () => !!state()?.imported,
				onClick: async run => {
					const choice = await plugin.confirmDestroyInfrastructure(profile);
					if (!choice.confirmed) return;
					try {
						const result = await run(onEvent => plugin.destroyInfrastructure(profile, { deleteBuckets: choice.deleteBuckets }, onEvent));
						if (result.fullyDestroyed) {
							new Notice('Infrastructure destroyed.');
						} else {
							new Notice(
								`Some stacks could not be deleted yet (${result.leftoverStacks.join(', ')}). ` +
								'Use "Force-clean leftover infrastructure" below to finish.',
							);
						}
						// Refresh either way: on success the row disappears; on a
						// partial teardown the status is now 'failed' and the
						// force-clean action appears.
						ctx.refresh();
					} catch (err) {
						Logger.error('Error destroying infrastructure:', err);
						new Notice(`Failed to destroy infrastructure: ${errorMessage(err)}`);
					}
				},
			}),
			// Force-clean: shown only when a prior teardown left stacks behind,
			// i.e. status is 'failed' or 'destroying' and the profile still
			// references stacks. Force-deletes the stuck stacks (retaining
			// resources CloudFormation can't remove, e.g. still-replicating
			// Lambda@Edge fns) and, if the user opts in, empties + removes the
			// retained fixed-name S3 buckets so a redeploy doesn't collide.
			liveOpRow({
				name: 'Force-clean leftover infrastructure',
				desc: 'This profile has stacks in a failed or in-progress-teardown state (commonly a Lambda@Edge auth stack whose CloudFront edge replicas take time to clear). Force-delete the remaining stacks so you can redeploy cleanly.',
				aliases: ['leftover stacks', 'stuck stack', 'cleanup'],
				visible: () => {
					const s = state();
					if (!isAws() || !s || s.imported) return false;
					const hasStackRefs = !!(
						s.fullStackName ||
						s.certStackName ||
						s.comment?.stackName ||
						s.cognitoAuth?.stackName ||
						s.cognitoAuth?.edgeStackName ||
						s.passwordAuth?.stackName
					);
					return hasStackRefs && (s.status === 'failed' || s.status === 'destroying');
				},
				opKey: () => `${ref}:force-clean`,
				label: () => 'Force-clean',
				busyLabel: 'Cleaning...',
				destructive: true,
				onClick: async run => {
					const choice = await confirmForceClean(ctx, profile);
					if (!choice.confirmed) return;
					try {
						const result = await run(onEvent => plugin.forceCleanInfrastructure(profile, { deleteBuckets: choice.deleteBuckets }, onEvent));
						// When edge resources were orphaned to drain a stuck stack, they
						// linger in AWS until CloudFront removes their replicas; the
						// plugin retries their deletion in the background (and via the
						// "Clean up orphaned edge resources" row).
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
						ctx.refresh();
					} catch (err) {
						Logger.error('Error force-cleaning infrastructure:', err);
						new Notice(`Force-clean failed: ${errorMessage(err)}`);
					}
				},
			}),
			// Orphaned edge cleanup: deletion only succeeds once CloudFront has
			// removed the replicas (up to a few hours); the plugin also retries
			// automatically on load, so this is a manual nudge.
			{
				name: 'Clean up orphaned edge resources',
				desc: 'A force-clean orphaned these Lambda@Edge resources so a stuck stack could be removed. They can only be deleted once CloudFront finishes removing their edge replicas (up to a few hours). The plugin retries automatically on load; use this to retry now.',
				aliases: ['Lambda@Edge', 'orphaned', 'cleanup'],
				visible: () => isAws() && pendingEdgeCount(profile) > 0,
				render: setting => {
					setting.setName(`Clean up orphaned edge resources (${pendingEdgeCount(profile)} pending)`);
					setting.addButton(button => button
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
								ctx.refresh();
							} catch (err) {
								Logger.error('Error cleaning orphaned edge resources:', err);
								new Notice(`Cleanup failed: ${errorMessage(err)}`);
								button.setDisabled(false);
								button.setButtonText('Clean up now');
							}
						}));
				},
			},
			{
				name: 'Delete profile',
				desc: 'Remove this profile from CPN. Its AWS resources are not touched; destroy them first if you no longer need them.',
				aliases: ['remove profile'],
				render: setting => {
					const last = plugin.settings.publishingProfiles.length <= 1;
					if (last) setting.setDesc('Cannot delete the last remaining profile.');
					setting.addButton(button => {
						twoClickConfirm(button, {
							label: 'Delete profile',
							confirmLabel: 'Click again to confirm deletion',
							busyLabel: 'Deleting...',
							run: async () => {
								const index = plugin.settings.publishingProfiles.indexOf(profile);
								if (index === -1) return;
								plugin.settings.publishingProfiles.splice(index, 1);
								await ctx.save();
								plugin.registerProfileCommands();
								// The open pages become tombstones until Settings closes.
								ctx.refresh();
							},
							onError: err => {
								Logger.error('Error deleting profile:', err);
								new Notice(`Failed to delete profile: ${errorMessage(err)}`);
							},
						});
						button.setDisabled(last);
					});
				},
			},
		],
	};
}
