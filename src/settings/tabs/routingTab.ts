import { Notice, SettingDefinition, SettingDefinitionItem } from 'obsidian';
import { DefinitionContext } from '../context';
import { hintRow, loadErrorsRow, overrideButtons } from './shared';

/**
 * Note routing page: the global title-prompt default plus a row for each
 * built-in routing action and option, with open/materialize and reset
 * controls. Definitions load on the next route.
 */
export function routingDefinitions(ctx: DefinitionContext): SettingDefinitionItem[] {
	const { plugin } = ctx;
	const manager = plugin.routingManager;

	const actionRows: SettingDefinition[] = [];
	for (const name of manager.getBuiltinActionNames()) {
		const scaffold = manager.getBuiltinActionScaffold(name);
		if (!scaffold) continue;
		actionRows.push({
			name,
			desc: `${scaffold.kind} — ${scaffold.description}`,
			aliases: ['routing action', 'override', scaffold.kind],
			render: setting => {
				const exists = manager.builtinActionFileExists(name);
				setting.setDesc(`${scaffold.kind}${exists ? ' · overridden' : ''} — ${scaffold.description}`);
				overrideButtons(ctx, setting, {
					noun: 'action',
					label: name,
					exists: () => exists,
					ensure: () => manager.ensureBuiltinActionVaultFile(name),
					reset: () => manager.resetBuiltinActionToDefault(name),
				});
			},
		});
	}

	const optionRows: SettingDefinition[] = [];
	for (const name of manager.getBuiltinOptionNames()) {
		const scaffold = manager.getBuiltinOptionScaffold(name);
		if (!scaffold) continue;
		optionRows.push({
			name,
			desc: scaffold.description,
			aliases: ['routing option', 'override'],
			render: setting => {
				const exists = manager.builtinOptionFileExists(name);
				setting.setDesc(`${exists ? 'overridden — ' : ''}${scaffold.description}`);
				overrideButtons(ctx, setting, {
					noun: 'option',
					label: name,
					exists: () => exists,
					ensure: () => manager.ensureBuiltinOptionVaultFile(name),
					reset: () => manager.resetBuiltinOptionToDefault(name),
				});
			},
		});
	}

	return [
		{
			name: 'Title prompt',
			desc: 'When routing prompts to (re)name the note. Options can override this. Actions & options live in <cpn-dir>/routes/.',
			aliases: ['rename', 'untitled', 'routing'],
			control: {
				type: 'dropdown',
				key: ctx.generalKey('routingTitlePrompt'),
				defaultValue: 'only-if-Untitled',
				options: {
					'always': 'Always prompt',
					'only-if-Untitled': 'Only if named "Untitled…"',
					'off': 'Never prompt',
				},
			},
		},
		loadErrorsRow('Routing errors', 'cpn-routing-errors', () => manager.getLoadErrors().length, 'routing file(s)'),
		{
			type: 'group',
			heading: 'Built-in actions',
			items: [
				hintRow('Reusable building blocks composed by options. Materialize to your vault to edit; deleting the file restores the default.'),
				...actionRows,
			],
		},
		{
			type: 'group',
			heading: 'Routing options',
			items: [
				hintRow('The choices shown in the routing suggester. CPN ships none by default — author your own under <cpn-dir>/routes/options/, composing the built-in actions above.'),
				...optionRows,
				{
					name: 'Export all routing files',
					desc: 'Materialize every built-in action to the vault at once.',
					aliases: ['export', 'scaffold'],
					action: () => {
						void (async () => {
							try {
								const paths = await manager.exportAllScaffolds();
								new Notice(`Exported ${paths.length} routing file(s) to ${plugin.settings.cpnDirectory ?? 'cpn'}/routes/`);
								ctx.refresh();
							} catch (e) {
								new Notice(`Failed to export routing files: ${e instanceof Error ? e.message : String(e)}`);
							}
						})();
					},
				},
			],
		},
	];
}
