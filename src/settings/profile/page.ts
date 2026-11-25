import type { SettingDefinitionItem, SettingDefinitionPage } from 'obsidian';
import { PublishingProfile } from '../../types';
import { errorMessage, Logger } from '../../utils/logging';
import { DefinitionContext } from '../context';
import { identityGroup } from './identity';
import { contentGroup } from './content';
import { attachmentsGroup } from './attachments';
import { destinationGroup } from './destination';
import { authGroup } from './auth';
import { infrastructureGroup } from './infrastructure';
import { siteCustomizationItems } from './siteCustomization';
import { deployHooksPage } from './deployHooks';
import { accessGroupsPage } from './accessGroups';
import { dangerZonePage } from './dangerZone';

/** Names of the sub-pages under a profile page (kept by its tombstone, spec §4). */
export const PROFILE_SUBPAGES = ['Theme color overrides', 'Named styles', 'Deploy hooks', 'Access groups', 'Danger Zone'];

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

function profileItems(ctx: DefinitionContext, profile: PublishingProfile): SettingDefinitionItem[] {
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
		infrastructureGroup(ctx, profile),
		authGroup(ctx, profile),
		...siteCustomizationItems(ctx, profile),
		{
			type: 'group',
			items: [
				deployHooksPage(ctx, profile),
				accessGroupsPage(ctx, profile),
				dangerZonePage(ctx, profile),
			],
		},
	];
}

/**
 * Placeholder for a deleted profile's page and its sub-pages, so pages still
 * open on it re-resolve until Settings closes (spec §4).
 */
export function profileTombstone(name: string): SettingDefinitionPage {
	const removed = { name: 'Profile removed', desc: 'This profile was deleted. Go back to the profile list.' };
	return {
		type: 'page',
		name,
		visible: false,
		items: [
			removed,
			...PROFILE_SUBPAGES.map((sub): SettingDefinitionPage => ({ type: 'page', name: sub, visible: false, items: [removed] })),
		],
	};
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
): SettingDefinitionPage {
	let items: SettingDefinitionItem[];
	try {
		items = profileItems(ctx, profile);
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
