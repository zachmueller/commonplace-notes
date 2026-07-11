import { Setting } from 'obsidian';
import { IndicatorStyle } from '../../types';
import { ProfileContext } from '../context';

/**
 * "Profile Identity" section: profile name, ID, and the publish indicator
 * (color block or emoji). Rendered into a section container by the profile tab.
 */
export function renderIdentitySection(ctx: ProfileContext, containerEl: HTMLElement): void {
	const { plugin, profile, index } = ctx;

	new Setting(containerEl)
		.setName('Profile name')
		.addText(text => text
			.setValue(profile.name)
			.onChange(async (value) => {
				plugin.settings.publishingProfiles[index].name = value;
				await plugin.saveSettings();
			})
			.inputEl.addEventListener('blur', () => {
				plugin.registerProfileCommands();
				ctx.updateProfileDropdownLabel(index, plugin.settings.publishingProfiles[index].name);
			}));

	new Setting(containerEl)
		.setName('Profile ID')
		.setDesc('Unique identifier used in frontmatter')
		.addText(text => text
			.setValue(profile.id)
			.onChange(async (value) => {
				plugin.settings.publishingProfiles[index].id = value;
				await plugin.saveSettings();
				plugin.registerProfileCommands();
			}));

	renderIndicatorSettings(ctx, containerEl);
}

function renderIndicatorSettings(ctx: ProfileContext, containerEl: HTMLElement): void {
	const { plugin, profile } = ctx;

	// Initialize indicator if it doesn't exist
	if (!profile.indicator) {
		profile.indicator = {
			style: 'color',
			color: '#000000'
		};
	}

	// Style selector
	new Setting(containerEl)
		.setName('Indicator style')
		.setDesc('Choose how to display this profile\'s indicator')
		.addDropdown(dropdown => dropdown
			.addOption('color', 'Color block')
			.addOption('emoji', 'Emoji')
			.setValue(profile.indicator.style)
			.onChange(async (value: IndicatorStyle) => {
				profile.indicator.style = value;
				await plugin.saveSettings();
				ctx.rerenderAll();
			}));

	if (profile.indicator.style === 'color') {
		new Setting(containerEl)
			.setName('Indicator color')
			.setDesc('Choose the color for this profile\'s indicator')
			.addText(text => {
				text.inputEl.type = 'color';
				text.setValue(profile.indicator.color || '#000000')
					.onChange(async (value) => {
						profile.indicator.color = value;
						await plugin.saveSettings();
					});
				return text;
			});
	} else {
		new Setting(containerEl)
			.setName('Indicator emoji')
			.setDesc('Choose an emoji for this profile\'s indicator')
			.addText(text => text
				.setValue(profile.indicator.emoji || '📝')
				.onChange(async (value) => {
					profile.indicator.emoji = value;
					await plugin.saveSettings();
				}));
	}
}
