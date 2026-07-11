import { Setting } from 'obsidian';
import { Logger } from '../../utils/logging';
import { SettingsContext } from '../context';

/**
 * "General" tab: global (non-profile) preferences — UID length, debug mode, and
 * the URL stack window.
 */
export function renderGeneralTab(ctx: SettingsContext, containerEl: HTMLElement): void {
	const { plugin } = ctx;

	new Setting(containerEl)
		.setName('UID length')
		.setDesc('Number of characters for newly generated note UIDs (Crockford Base32). 8 characters provides ~1 trillion unique IDs. Most users should leave this at the default. Only affects newly generated UIDs — existing notes are unchanged.')
		.addText(text => text
			.setPlaceholder('8')
			.setValue(String(plugin.settings.uidLength ?? 8))
			.onChange(async (value) => {
				const num = parseInt(value, 10);
				if (!isNaN(num) && num >= 4 && num <= 26) {
					plugin.settings.uidLength = num;
					await plugin.saveSettings();
				}
			}));

	new Setting(containerEl)
		.setName('Debug mode')
		.setDesc('Enable verbose debug logging to the developer console.')
		.addToggle(toggle => toggle
			.setValue(plugin.settings.debugMode ?? false)
			.onChange(async (value) => {
				plugin.settings.debugMode = value;
				Logger.setDebugMode(value);
				await plugin.saveSettings();
			}));

	// NOTE: The URL scheme ('current' vs 'original') is intentionally not
	// exposed in the UI. It defaults to 'current' and only existed as a
	// dropdown to bridge a one-time migration. Power users can still override
	// it by setting `urlScheme` directly in the plugin's data.json.

	new Setting(containerEl)
		.setName('URL stack window (seconds)')
		.setDesc('When using "Copy link to current note URL" repeatedly, each invocation within this window appends the active note to a growing stacked URL on the clipboard. The window resets on every copy. Only applies under the "Current" URL scheme.')
		.addText(text => text
			.setPlaceholder('10')
			.setValue(String(plugin.settings.urlStackWindowSeconds ?? 10))
			.onChange(async (value) => {
				const num = parseInt(value, 10);
				if (!isNaN(num) && num >= 1 && num <= 120) {
					plugin.settings.urlStackWindowSeconds = num;
					await plugin.saveSettings();
				}
			}));
}
