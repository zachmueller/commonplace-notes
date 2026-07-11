import { Notice, Setting } from 'obsidian';
import { SettingsContext } from '../context';

/**
 * "Markdown parser" tab: the CPN directory field plus a per-stage row for each
 * built-in stage with open/materialize and reset controls (mirrors Notor's
 * per-tool settings wiring). Stage edits take effect on next publish.
 */
export function renderParserTab(ctx: SettingsContext, containerEl: HTMLElement): void {
	const { app, plugin } = ctx;

	new Setting(containerEl)
		.setName('CPN directory')
		.setDesc('Vault folder for CPN extension files. Parser stages live in <dir>/parsers/. Default: cpn')
		.addText(text => text
			.setPlaceholder('cpn')
			.setValue(plugin.settings.cpnDirectory ?? 'cpn')
			.onChange(async (value) => {
				plugin.settings.cpnDirectory = value.trim() || 'cpn';
				await plugin.saveSettings();
			}));

	const manager = plugin.parserExtensionManager;

	// Surface load errors from the most recent publish, if any.
	const loadErrors = manager.getLoadErrors();
	if (loadErrors.length > 0) {
		new Setting(containerEl)
			.setName('Parser extension errors')
			.setDesc(`${loadErrors.length} stage(s) failed to load on the last publish. See the developer console for details.`)
			.setClass('cpn-parser-errors');
	}

	const section = ctx.createSection(containerEl, 'Built-in stages');
	section.createEl('p', {
		text: 'Each stage can be materialized to your vault and edited. The built-in runs until you override it; deleting the file restores the default. Changes apply on the next publish.',
		cls: 'cpn-settings-hint'
	});

	for (const name of manager.getBuiltinParserNames()) {
		const scaffold = manager.getBuiltinScaffold(name);
		if (!scaffold) continue;
		const exists = manager.builtinVaultFileExists(name);

		const setting = new Setting(section)
			.setName(name)
			.setDesc(`${scaffold.stage} · order ${scaffold.order}${exists ? ' · overridden' : ''} — ${scaffold.description}`);

		// Open (materialize on demand, then open) — mirrors Notor tools.ts.
		setting.addExtraButton(btn => btn
			.setIcon('square-arrow-out-up-right')
			.setTooltip(exists ? 'Open stage definition' : 'Create & open stage definition')
			.onClick(async () => {
				try {
					const path = await manager.ensureBuiltinParserVaultFile(name);
					await app.workspace.openLinkText(path, '', true);
					if (!exists) {
						new Notice(`Created ${path} — re-publish to apply.`);
						ctx.rerenderAll();
					}
				} catch (e) {
					new Notice(`Failed to create stage file: ${e instanceof Error ? e.message : String(e)}`);
				}
			}));

		// Reset (delete the vault file → fall back to built-in) — only if present.
		if (exists) {
			setting.addExtraButton(btn => btn
				.setIcon('rotate-ccw')
				.setTooltip('Reset to built-in default (deletes the vault file)')
				.onClick(async () => {
					try {
						await manager.resetBuiltinParserToDefault(name);
						new Notice(`Reset "${name}" to built-in default.`);
						ctx.rerenderAll();
					} catch (e) {
						new Notice(`Failed to reset stage: ${e instanceof Error ? e.message : String(e)}`);
					}
				}));
		}
	}

	new Setting(section)
		.setName('Export all built-in stages')
		.setDesc('Materialize every built-in stage to the vault at once for tinkering.')
		.addButton(button => button
			.setButtonText('Export all')
			.onClick(async () => {
				try {
					const paths = await manager.exportAllScaffolds();
					new Notice(`Exported ${paths.length} parser stage(s) to ${plugin.settings.cpnDirectory ?? 'cpn'}/parsers/`);
					ctx.rerenderAll();
				} catch (e) {
					new Notice(`Failed to export stages: ${e instanceof Error ? e.message : String(e)}`);
				}
			}));
}
