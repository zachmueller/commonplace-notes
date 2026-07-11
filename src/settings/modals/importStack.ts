import { PublishingProfile } from '../../types';
import { ImportStackModal } from '../../infrastructure/importStackModal';
import { ProfileContext } from '../context';
import { initAWSSettings } from '../profile/shared';

/** Open the import-stack modal, re-rendering the profile pane when it finishes. */
export function openImportStackModal(ctx: ProfileContext, profile: PublishingProfile): void {
	initAWSSettings(profile);
	new ImportStackModal(
		ctx.app,
		ctx.plugin,
		ctx.plugin.cloudFormationManager,
		profile,
		() => ctx.rerenderProfile(),
	).open();
}
