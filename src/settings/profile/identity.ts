import type { SettingDefinitionGroup } from 'obsidian';
import { PublishingProfile } from '../../types';
import { DefinitionContext } from '../context';

/**
 * "Profile Identity" group: profile name, ID, and the publish indicator
 * (color block or emoji).
 */
export function identityGroup(ctx: DefinitionContext, profile: PublishingProfile): SettingDefinitionGroup {
	// Older profiles may predate indicators.
	if (!profile.indicator) {
		profile.indicator = { style: 'color', color: '#000000' };
	}
	const key = (path: string) => ctx.profileKey(profile, path);

	return {
		type: 'group',
		heading: 'Profile Identity',
		items: [
			{
				name: 'Profile name',
				desc: 'Shown in commands and in this list. The page title updates the next time Settings opens.',
				aliases: ['rename', 'label'],
				control: { type: 'text', key: key('name') },
			},
			{
				name: 'Profile ID',
				desc: 'Unique identifier used in frontmatter',
				aliases: ['cpn-publish-contexts', 'frontmatter', 'identifier'],
				control: { type: 'text', key: key('id') },
			},
			{
				name: 'Indicator style',
				desc: 'Choose how to display this profile\'s indicator',
				aliases: ['badge', 'status bar'],
				control: {
					type: 'dropdown',
					key: key('indicator.style'),
					defaultValue: 'color',
					options: { color: 'Color block', emoji: 'Emoji' },
				},
			},
			{
				name: 'Indicator color',
				desc: 'Choose the color for this profile\'s indicator',
				aliases: ['badge', 'colour'],
				visible: () => profile.indicator.style === 'color',
				control: { type: 'color', key: key('indicator.color'), defaultValue: '#000000' },
			},
			{
				name: 'Indicator emoji',
				desc: 'Choose an emoji for this profile\'s indicator',
				aliases: ['badge', 'icon'],
				visible: () => profile.indicator.style !== 'color',
				control: { type: 'text', key: key('indicator.emoji'), defaultValue: '📝' },
			},
		],
	};
}
