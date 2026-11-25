import type { SettingDefinitionItem, SettingDefinitionPage } from 'obsidian';
import { PublishingProfile } from '../../types';
import { errorMessage, Logger } from '../../utils/logging';
import { DefinitionContext, ProfileContext } from '../context';
import { identityGroup } from './identity';
import { contentGroup } from './content';
import { attachmentsGroup } from './attachments';
import { destinationGroup } from './destination';
import { authGroup } from './auth';
import { renderInfrastructureSection } from './infrastructure';
import { renderSiteCustomizationSection } from './siteCustomization';
import { renderDeployHooksSection } from './deployHooks';
import { renderAccessGroupsSection } from './accessGroups';
import { renderDangerZone } from './dangerZone';

/** Factory for a legacy (imperative) per-profile sub-page; removed in P4. */
export type LegacyProfilePage = (
	name: string,
	desc: string,
	render: (ctx: ProfileContext, containerEl: HTMLElement) => void,
) => SettingDefinitionPage;

/** The site domain from the base URL, else the mechanism, for the profile list. */
export function profileDisplayValue(profile: PublishingProfile): string {
	if (profile.baseUrl) {
		try {
			return new URL(profile.baseUrl).host || profile.baseUrl;
		} catch {
			return profile.baseUrl;
		}
	}
	return profile.publishMechanism;
}

/** 'warning' when an AWS profile isn't set up yet or its last deploy failed. */
export function profileStatus(profile: PublishingProfile): 'warning' | null {
	if (profile.publishMechanism !== 'AWS') return null;
	if (profile.infrastructureState?.status === 'failed') return 'warning';
	if (!profile.awsSettings?.bucketName || !profile.awsSettings.region) return 'warning';
	return null;
}

function profileItems(ctx: DefinitionContext, profile: PublishingProfile, legacy: LegacyProfilePage): SettingDefinitionItem[] {
	const isAws = () => profile.publishMechanism === 'AWS';
	return [
		{
			name: 'Last full publish',
			aliases: ['publish all', 'last published'],
			render: setting => {
				setting.setDesc(profile.lastFullPublishTimestamp
					? new Date(profile.lastFullPublishTimestamp).toLocaleString()
					: 'Never');
			},
		},
		identityGroup(ctx, profile),
		contentGroup(ctx, profile),
		attachmentsGroup(ctx, profile),
		destinationGroup(ctx, profile),
		authGroup(ctx, profile),
		{
			type: 'group',
			items: [
				{ ...legacy('Infrastructure', 'Deployed stacks, sign-in and domain tools.', renderInfrastructureSection), visible: isAws },
				{ ...legacy('Site Customization', 'Site title, fonts, header links, theme colors and named styles.', renderSiteCustomizationSection), visible: isAws },
				{ ...legacy('Deploy hooks', 'Scripts that run before and after a deploy.', renderDeployHooksSection), visible: isAws },
				legacy('Access groups', 'Who can read gated notes.', renderAccessGroupsSection),
				legacy('Danger Zone', 'Destroy infrastructure, force-clean leftovers, delete this profile.',
					(pctx, el) => renderDangerZone(pctx, el, el)),
			],
		},
	];
}

/**
 * One profile's page in the Publishing profiles list. `name` comes from the
 * session's page-name snapshot (spec §4). If building the page throws, the
 * page shows the error instead, so the rest of the tab still works.
 */
export function profilePage(
	ctx: DefinitionContext,
	profile: PublishingProfile,
	name: string,
	legacy: LegacyProfilePage,
): SettingDefinitionPage {
	let items: SettingDefinitionItem[];
	try {
		items = profileItems(ctx, profile, legacy);
	} catch (error) {
		Logger.error(`Error displaying profile ${profile.name}:`, error);
		items = [{
			name: 'Some settings for this profile failed to render',
			render: setting => {
				setting.setDesc(`${errorMessage(error)}. See the developer console for details.`);
				setting.descEl.addClass('mod-warning', 'cpn-profile-render-error');
			},
		}];
	}
	return {
		type: 'page',
		name,
		displayValue: () => profileDisplayValue(profile),
		status: () => profileStatus(profile),
		items,
	};
}
