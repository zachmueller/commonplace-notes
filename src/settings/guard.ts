import type { SettingDefinitionItem } from 'obsidian';
import { Logger, errorMessage } from '../utils/logging';

/**
 * Wrap every `render` callback in `items` (recursively) so one failing row
 * shows its error instead of aborting the rest of the page. Render rows run
 * even while hidden, against whatever state the profile is in.
 */
export function guardRenders(items: SettingDefinitionItem[]): SettingDefinitionItem[] {
	for (const item of items) {
		if ('type' in item && (item.type === 'group' || item.type === 'list' || item.type === 'page')) {
			if (item.items) guardRenders(item.items as SettingDefinitionItem[]);
			continue;
		}
		if (!('render' in item) || !item.render) continue;
		const render = item.render;
		item.render = (setting, group) => {
			try {
				return render(setting, group);
			} catch (error) {
				Logger.error(`Error displaying setting "${item.name}":`, error);
				setting.setDesc(`This setting failed to render: ${errorMessage(error)}. See the developer console for details.`);
				setting.descEl.addClass('mod-warning', 'cpn-profile-render-error');
			}
		};
	}
	return items;
}
