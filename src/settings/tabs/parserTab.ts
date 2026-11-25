import { Notice, SettingDefinition, SettingDefinitionItem } from 'obsidian';
import { DefinitionContext } from '../context';
import { hintRow, loadErrorsRow, overrideButtons } from './shared';

/**
 * Markdown parser page: the CPN directory field plus a row per built-in stage
 * with open/materialize and reset controls (mirrors Notor's per-tool settings
 * wiring). Stage edits take effect on next publish.
 */
export function parserDefinitions(ctx: DefinitionContext): SettingDefinitionItem[] {
	const { plugin } = ctx;
	const manager = plugin.parserExtensionManager;

	const stageRows: SettingDefinition[] = [];
	for (const name of manager.getBuiltinParserNames()) {
		const scaffold = manager.getBuiltinScaffold(name);
		if (!scaffold) continue;
		const base = `${scaffold.stage} · order ${scaffold.order}`;
		stageRows.push({
			name,
			desc: `${base} — ${scaffold.description}`,
			aliases: ['parser stage', 'override', scaffold.stage],
			render: setting => {
				const exists = manager.builtinVaultFileExists(name);
				setting.setDesc(`${base}${exists ? ' · overridden' : ''} — ${scaffold.description}`);
				overrideButtons(ctx, setting, {
					noun: 'stage',
					label: name,
					exists: () => exists,
					ensure: () => manager.ensureBuiltinParserVaultFile(name),
					reset: () => manager.resetBuiltinParserToDefault(name),
					createdNotice: path => `Created ${path} — re-publish to apply.`,
				});
			},
		});
	}

	return [
		{
			name: 'CPN directory',
			desc: 'Vault folder for CPN extension files. Parser stages live in <dir>/parsers/. Default: cpn',
			aliases: ['folder', 'extensions', 'cpn'],
			control: { type: 'text', key: ctx.generalKey('cpnDirectory'), placeholder: 'cpn' },
		},
		// Surface load errors from the most recent publish, if any.
		loadErrorsRow('Parser extension errors', 'cpn-parser-errors', () => manager.getLoadErrors().length, 'stage(s)'),
		{
			type: 'group',
			heading: 'Built-in stages',
			items: [
				hintRow('Each stage can be materialized to your vault and edited. The built-in runs until you override it; deleting the file restores the default. Changes apply on the next publish.'),
				...stageRows,
				{
					name: 'Export all built-in stages',
					desc: 'Materialize every built-in stage to the vault at once for tinkering.',
					aliases: ['export', 'scaffold'],
					action: () => {
						void (async () => {
							try {
								const paths = await manager.exportAllScaffolds();
								new Notice(`Exported ${paths.length} parser stage(s) to ${plugin.settings.cpnDirectory ?? 'cpn'}/parsers/`);
								ctx.refresh();
							} catch (e) {
								new Notice(`Failed to export stages: ${e instanceof Error ? e.message : String(e)}`);
							}
						})();
					},
				},
			],
		},
	];
}
