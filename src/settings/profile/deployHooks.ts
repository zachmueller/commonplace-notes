import { Notice, Setting } from 'obsidian';
import { ProfileContext } from '../context';

/**
 * "Deploy hooks" section (AWS profiles): per-profile deploy-lifecycle hooks that
 * run around the full-stack deploy. Hooks live in
 * `{cpnDirectory}/profiles/{profileId}/hooks/` and are authored as `.md` notes
 * tagged `cpn-type: pre-deploy-hook` / `post-deploy-hook`. Lean by design — a
 * "Validate hooks" button (surfaces discovery/compile errors on demand) and an
 * "Export example hook" button (materializes a documented no-op starter).
 */
export function renderDeployHooksSection(ctx: ProfileContext, containerEl: HTMLElement): void {
	const { app, plugin, profile } = ctx;
	const manager = plugin.deployHookManager;
	const hooksDir = manager.profileHooksDir(profile.id);

	containerEl.createEl('p', {
		text: `Run custom code around this profile's full-stack deploy. Author hook notes (cpn-type: pre-deploy-hook / post-deploy-hook) in ${hooksDir}/. Hooks run for side effects with an injected AWS SDK handle + resolved stack outputs; a throwing hook is surfaced but does not fail the deploy.`,
		cls: 'cpn-settings-hint',
	});

	// Validate on demand — discovers + compiles without running, reporting count
	// and any load errors inline. (Load errors are otherwise only visible after
	// an actual deploy, since a broken hook is silently dropped.)
	const statusEl = containerEl.createDiv();
	new Setting(containerEl)
		.setName('Validate hooks')
		.setDesc('Discover and compile this profile’s hooks now, without deploying.')
		.addButton(button => button
			.setButtonText('Validate')
			.onClick(async () => {
				statusEl.empty();
				try {
					const { definitions, errors } = await manager.validateHooks(profile.id);
					if (definitions.length === 0 && errors.length === 0) {
						statusEl.createEl('p', {
							text: 'No hooks found for this profile.',
							cls: 'cpn-settings-hint',
						});
						return;
					}
					for (const def of definitions) {
						statusEl.createDiv({ cls: 'cpn-wizard-event-line cpn-event-success' })
							.setText(`✓ ${def.name} (${def.phase}) — ${def.filename}`);
					}
					for (const err of errors) {
						statusEl.createDiv({ cls: 'cpn-wizard-event-line cpn-event-error' })
							.setText(`✗ ${err.filePath}: ${err.message}`);
					}
				} catch (e) {
					new Notice(`Failed to validate hooks: ${e instanceof Error ? e.message : String(e)}`);
				}
			}));

	new Setting(containerEl)
		.setName('Export example hook')
		.setDesc('Materialize a documented no-op post-deploy hook you can copy, rename, and edit.')
		.addButton(button => button
			.setButtonText('Export example')
			.onClick(async () => {
				try {
					const paths = await manager.exportExampleHooks(profile.id);
					new Notice(`Exported ${paths.length} example hook(s) to ${hooksDir}/`);
					// Open the first one so the user lands on it immediately.
					if (paths.length > 0) {
						await app.workspace.openLinkText(paths[0], '', true);
					}
				} catch (e) {
					new Notice(`Failed to export example hook: ${e instanceof Error ? e.message : String(e)}`);
				}
			}));
}
