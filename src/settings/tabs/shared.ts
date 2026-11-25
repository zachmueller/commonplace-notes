import { Notice, Setting, SettingDefinition } from 'obsidian';
import { DefinitionContext } from '../context';

// Row builders shared by the Markdown parser and Note routing pages.

/** A non-searchable explanatory row (groups have no description of their own). */
export function hintRow(text: string): SettingDefinition {
	return { name: '', desc: text, searchable: false };
}

/** A row reporting files that failed to load; hidden when the last run had none. */
export function loadErrorsRow(name: string, cls: string, errors: () => number, what: string): SettingDefinition {
	return {
		name,
		desc: 'Files that failed to load on the last run. See the developer console for details.',
		aliases: ['errors', 'failed'],
		visible: () => errors() > 0,
		render: (setting: Setting) => {
			setting.setDesc(`${errors()} ${what} failed to load on the last run. See the developer console for details.`);
			setting.setClass(cls);
		},
	};
}

/**
 * Open / Reset extra buttons for a built-in vault-file override. `exists` is
 * read at render time: files can change while Settings is closed, and render
 * rows re-run on every page render.
 */
export function overrideButtons(
	ctx: DefinitionContext,
	setting: Setting,
	opts: {
		noun: string;
		exists: () => boolean;
		ensure: () => Promise<string>;
		reset: () => Promise<void>;
		createdNotice?: (path: string) => string;
		label: string;
	},
): void {
	const exists = opts.exists();
	setting.addExtraButton(btn => btn
		.setIcon('square-arrow-out-up-right')
		.setTooltip(exists ? `Open ${opts.noun} definition` : `Create & open ${opts.noun} definition`)
		.onClick(async () => {
			try {
				const path = await opts.ensure();
				await ctx.app.workspace.openLinkText(path, '', true);
				if (!exists) {
					if (opts.createdNotice) new Notice(opts.createdNotice(path));
					ctx.refresh();
				}
			} catch (e) {
				new Notice(`Failed to create ${opts.noun} file: ${e instanceof Error ? e.message : String(e)}`);
			}
		}));

	// Reset (delete the vault file → fall back to built-in) — only if present.
	if (exists) {
		setting.addExtraButton(btn => btn
			.setIcon('rotate-ccw')
			.setTooltip('Reset to built-in default (deletes the vault file)')
			.onClick(async () => {
				try {
					await opts.reset();
					new Notice(`Reset "${opts.label}" to built-in default.`);
					ctx.refresh();
				} catch (e) {
					new Notice(`Failed to reset ${opts.noun}: ${e instanceof Error ? e.message : String(e)}`);
				}
			}));
	}
}
