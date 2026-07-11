import { Notice, Setting } from 'obsidian';
import { SettingsContext } from '../context';

/**
 * "Note routing" tab: the global title-prompt default plus a per-item row for
 * each built-in routing action and option, with open/materialize and reset
 * controls. Definitions load on the next route.
 */
export function renderRoutingTab(ctx: SettingsContext, containerEl: HTMLElement): void {
	const { app, plugin } = ctx;

	new Setting(containerEl)
		.setName('Title prompt')
		.setDesc('When routing prompts to (re)name the note. Options can override this. Actions & options live in <cpn-dir>/routes/.')
		.addDropdown(dropdown => dropdown
			.addOption('always', 'Always prompt')
			.addOption('only-if-Untitled', 'Only if named "Untitled…"')
			.addOption('off', 'Never prompt')
			.setValue(plugin.settings.routingTitlePrompt ?? 'only-if-Untitled')
			.onChange(async (value) => {
				plugin.settings.routingTitlePrompt = value as 'always' | 'only-if-Untitled' | 'off';
				await plugin.saveSettings();
			}));

	const manager = plugin.routingManager;

	const loadErrors = manager.getLoadErrors();
	if (loadErrors.length > 0) {
		new Setting(containerEl)
			.setName('Routing errors')
			.setDesc(`${loadErrors.length} routing file(s) failed to load on the last run. See the developer console for details.`)
			.setClass('cpn-routing-errors');
	}

	// --- Built-in actions ---
	const actionSection = ctx.createSection(containerEl, 'Built-in actions');
	actionSection.createEl('p', {
		text: 'Reusable building blocks composed by options. Materialize to your vault to edit; deleting the file restores the default.',
		cls: 'cpn-settings-hint'
	});
	for (const name of manager.getBuiltinActionNames()) {
		const scaffold = manager.getBuiltinActionScaffold(name);
		if (!scaffold) continue;
		const exists = manager.builtinActionFileExists(name);

		const setting = new Setting(actionSection)
			.setName(name)
			.setDesc(`${scaffold.kind}${exists ? ' · overridden' : ''} — ${scaffold.description}`);

		setting.addExtraButton(btn => btn
			.setIcon('square-arrow-out-up-right')
			.setTooltip(exists ? 'Open action definition' : 'Create & open action definition')
			.onClick(async () => {
				try {
					const path = await manager.ensureBuiltinActionVaultFile(name);
					await app.workspace.openLinkText(path, '', true);
					if (!exists) ctx.rerenderAll();
				} catch (e) {
					new Notice(`Failed to create action file: ${e instanceof Error ? e.message : String(e)}`);
				}
			}));

		if (exists) {
			setting.addExtraButton(btn => btn
				.setIcon('rotate-ccw')
				.setTooltip('Reset to built-in default (deletes the vault file)')
				.onClick(async () => {
					try {
						await manager.resetBuiltinActionToDefault(name);
						new Notice(`Reset "${name}" to built-in default.`);
						ctx.rerenderAll();
					} catch (e) {
						new Notice(`Failed to reset action: ${e instanceof Error ? e.message : String(e)}`);
					}
				}));
		}
	}

	// --- Built-in options ---
	const optionSection = ctx.createSection(containerEl, 'Built-in options');
	optionSection.createEl('p', {
		text: 'The choices shown in the routing suggester. Materialize to your vault to edit or add your own.',
		cls: 'cpn-settings-hint'
	});
	for (const name of manager.getBuiltinOptionNames()) {
		const scaffold = manager.getBuiltinOptionScaffold(name);
		if (!scaffold) continue;
		const exists = manager.builtinOptionFileExists(name);

		const setting = new Setting(optionSection)
			.setName(name)
			.setDesc(`${exists ? 'overridden — ' : ''}${scaffold.description}`);

		setting.addExtraButton(btn => btn
			.setIcon('square-arrow-out-up-right')
			.setTooltip(exists ? 'Open option definition' : 'Create & open option definition')
			.onClick(async () => {
				try {
					const path = await manager.ensureBuiltinOptionVaultFile(name);
					await app.workspace.openLinkText(path, '', true);
					if (!exists) ctx.rerenderAll();
				} catch (e) {
					new Notice(`Failed to create option file: ${e instanceof Error ? e.message : String(e)}`);
				}
			}));

		if (exists) {
			setting.addExtraButton(btn => btn
				.setIcon('rotate-ccw')
				.setTooltip('Reset to built-in default (deletes the vault file)')
				.onClick(async () => {
					try {
						await manager.resetBuiltinOptionToDefault(name);
						new Notice(`Reset "${name}" to built-in default.`);
						ctx.rerenderAll();
					} catch (e) {
						new Notice(`Failed to reset option: ${e instanceof Error ? e.message : String(e)}`);
					}
				}));
		}
	}

	new Setting(optionSection)
		.setName('Export all routing files')
		.setDesc('Materialize every built-in action and option to the vault at once.')
		.addButton(button => button
			.setButtonText('Export all')
			.onClick(async () => {
				try {
					const paths = await manager.exportAllScaffolds();
					new Notice(`Exported ${paths.length} routing file(s) to ${plugin.settings.cpnDirectory ?? 'cpn'}/routes/`);
					ctx.rerenderAll();
				} catch (e) {
					new Notice(`Failed to export routing files: ${e instanceof Error ? e.message : String(e)}`);
				}
			}));
}
