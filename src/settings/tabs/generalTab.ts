import type { SettingDefinitionItem } from 'obsidian';
import { DefinitionContext } from '../context';

/** Reject non-integers; the number control already enforces min / max. */
function wholeNumber(value: number): string | void {
	if (!Number.isInteger(value)) return 'Enter a whole number.';
}

/**
 * General settings: global (non-profile) preferences — UID length, debug mode,
 * and the URL stack window. Rendered at the top of the tab, ungrouped.
 */
export function generalDefinitions(ctx: DefinitionContext): SettingDefinitionItem[] {
	return [
		{
			name: 'UID length',
			desc: 'Number of characters for newly generated note UIDs (Crockford Base32). 8 characters provides ~1 trillion unique IDs. Most users should leave this at the default. Only affects newly generated UIDs — existing notes are unchanged.',
			aliases: ['identifier', 'permalink', 'id'],
			control: {
				type: 'number',
				key: ctx.generalKey('uidLength'),
				defaultValue: 8,
				min: 4,
				max: 26,
				step: 1,
				placeholder: '8',
				validate: wholeNumber,
			},
		},
		{
			name: 'Debug mode',
			desc: 'Enable verbose debug logging to the developer console.',
			aliases: ['logging', 'verbose', 'console'],
			control: { type: 'toggle', key: ctx.generalKey('debugMode'), defaultValue: false },
		},
		// NOTE: The URL scheme ('current' vs 'original') is intentionally not
		// exposed in the UI. It defaults to 'current' and only existed as a
		// dropdown to bridge a one-time migration. Power users can still override
		// it by setting `urlScheme` directly in the plugin's data.json.
		{
			name: 'URL stack window (seconds)',
			desc: 'When using "Copy link to current note URL" repeatedly, each invocation within this window appends the active note to a growing stacked URL on the clipboard. The window resets on every copy. Only applies under the "Current" URL scheme.',
			aliases: ['copy link', 'clipboard', 'stacked'],
			control: {
				type: 'number',
				key: ctx.generalKey('urlStackWindowSeconds'),
				defaultValue: 10,
				min: 1,
				max: 120,
				step: 1,
				placeholder: '10',
				validate: wholeNumber,
			},
		},
	];
}
