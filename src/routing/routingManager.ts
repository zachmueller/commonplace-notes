/**
 * RoutingManager — discovers, compiles, and runs the user-extensible note-routing
 * engine.
 *
 * Modeled on `ParserExtensionManager`. Two file types are discovered from the
 * vault (or supplied as in-memory built-in scaffolds):
 *   - ACTIONS (`cpn/routes/actions/`) — reusable building blocks.
 *   - OPTIONS (`cpn/routes/options/`) — user-facing routing choices that compose
 *     an ordered list of steps referencing actions (by wikilink + params) and/or
 *     defining inline actions.
 *
 * Lifecycle:
 *   - `loadRoutes(profileId)` — discover + inject scaffold fallbacks + compile
 *     `code` actions + resolve each option's steps into a concrete pipeline.
 *   - `runRoute(file, mode)` — suggester → title prompt → ordered step execution
 *     with per-option error policy and capability-flag skipping.
 *
 * Built-ins are overridable: a vault file whose name matches a built-in replaces
 * it; deleting the file restores the default (an in-memory fallback runs when no
 * vault file exists).
 */

import { Notice, normalizePath, parseYaml, TFile } from 'obsidian';
import CommonplaceNotesPlugin from '../main';
import { Logger } from '../utils/logging';
import { PathUtils } from '../utils/path';
import { extractFrontmatter } from '../utils/vaultScan';
import { buildRoutingLibs } from './libs';
import { compileRoutingAction } from './compiler';
import { discoverRoutingFiles, type RoutingSearchDir } from './discovery';
import { parseRoutingActionFile, isRoutingError } from './actionFile';
import { parseRoutingOptionFile } from './optionFile';
import { RK } from './frontmatterKeys';
import {
	BUILTIN_ROUTING_ACTION_SCAFFOLDS,
	BUILTIN_ROUTING_OPTION_SCAFFOLDS,
} from './scaffolds';
import { RoutingOptionSuggestModal, TitlePromptModal } from './modals';
import type {
	InlineActionSpec,
	RoutingActionDefinition,
	RoutingContext,
	RoutingError,
	RoutingLibs,
	RoutingMode,
	RoutingOptionDefinition,
	RoutingStep,
	RoutingUtils,
	TitlePromptMode,
} from './types';

const DEFAULT_CPN_DIR = 'cpn';

/**
 * Strip `[[ ]]`, a `|alias`, and a `#heading`/`^block` anchor from a wikilink,
 * but PRESERVE any directory segments (unlike `bareWikilinkName`, which reduces
 * to the basename) so a template reference like `[[templates/meeting]]` resolves.
 */
function stripToLinkpath(raw: string): string {
	let s = raw.trim();
	const m = s.match(/^\[\[([^\]]+)\]\]$/);
	if (m) s = m[1];
	return s.split('|')[0].split('#')[0].trim();
}

export class RoutingManager {
	private plugin: CommonplaceNotesPlugin;

	private actions: Map<string, RoutingActionDefinition> | null = null;
	private options: RoutingOptionDefinition[] | null = null;
	private loadErrors: RoutingError[] = [];
	private libs: RoutingLibs | null = null;

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
	}

	// -----------------------------------------------------------------------
	// Directory resolution (forward-compatible with the v2 profile tier)
	// -----------------------------------------------------------------------

	private cpnBaseDir(): string {
		const raw = this.plugin.settings.cpnDirectory || DEFAULT_CPN_DIR;
		return normalizePath(raw.replace(/\/+$/, ''));
	}

	private actionsDir(): string {
		return normalizePath(`${this.cpnBaseDir()}/routes/actions`);
	}

	private optionsDir(): string {
		return normalizePath(`${this.cpnBaseDir()}/routes/options`);
	}

	private actionSearchDirs(_profileId: string): RoutingSearchDir[] {
		return [
			{ path: this.actionsDir(), source: 'global' },
			// v2: { path: `${this.cpnBaseDir()}/profiles/${_profileId}/routes/actions`, source: 'profile' },
		];
	}

	private optionSearchDirs(_profileId: string): RoutingSearchDir[] {
		return [
			{ path: this.optionsDir(), source: 'global' },
			// v2: { path: `${this.cpnBaseDir()}/profiles/${_profileId}/routes/options`, source: 'profile' },
		];
	}

	// -----------------------------------------------------------------------
	// Load (once per route invocation)
	// -----------------------------------------------------------------------

	/**
	 * Discover + compile actions and options for a profile, caching the result.
	 * Re-run on each command so edited vault files take effect without a watcher.
	 */
	async loadRoutes(profileId: string): Promise<void> {
		this.actions = null;
		this.options = null;
		this.loadErrors = [];
		this.libs = buildRoutingLibs(this.plugin);

		// --- 1. Discover + resolve ACTIONS ---
		const discoveredActions = await discoverRoutingFiles(
			this.plugin.app.vault,
			this.plugin.app.metadataCache,
			this.actionSearchDirs(profileId),
			parseYaml,
			parseRoutingActionFile,
			(def) => def.name,
		);
		this.loadErrors.push(...discoveredActions.errors);

		const actionsByName = new Map<string, RoutingActionDefinition>();
		for (const def of discoveredActions.definitions) {
			actionsByName.set(def.name, def);
		}

		// Inject scaffold fallbacks for built-in actions with no vault override.
		for (const [name, scaffold] of BUILTIN_ROUTING_ACTION_SCAFFOLDS) {
			if (actionsByName.has(name)) continue;
			const parsed = this.parseScaffoldAction(name, scaffold.scaffoldContent);
			if (parsed) actionsByName.set(name, parsed);
		}

		// Compile `code` actions. Broken user override → built-in fallback;
		// broken built-in scaffold → CRITICAL.
		for (const def of actionsByName.values()) {
			if (def.kind !== 'code' || !def.rawCode) continue;
			const result = compileRoutingAction(def.rawCode);
			if ('error' in result) {
				this.recordCompileFailure(def, result.error);
				const fallback = this.scaffoldFallbackFor(def);
				if (fallback) actionsByName.set(def.name, fallback);
				else actionsByName.delete(def.name);
				continue;
			}
			def.compiledFn = result.fn;
		}
		this.actions = actionsByName;

		// --- 2. Discover + resolve OPTIONS ---
		const discoveredOptions = await discoverRoutingFiles(
			this.plugin.app.vault,
			this.plugin.app.metadataCache,
			this.optionSearchDirs(profileId),
			parseYaml,
			parseRoutingOptionFile,
			(def) => def.name,
		);
		this.loadErrors.push(...discoveredOptions.errors);

		const optionsByName = new Map<string, RoutingOptionDefinition>();
		for (const def of discoveredOptions.definitions) {
			optionsByName.set(def.name, def);
		}
		for (const [name, scaffold] of BUILTIN_ROUTING_OPTION_SCAFFOLDS) {
			if (optionsByName.has(name)) continue;
			const parsed = this.parseScaffoldOption(name, scaffold.scaffoldContent);
			if (parsed) optionsByName.set(name, parsed);
		}

		// Resolve each option's raw steps into a concrete pipeline.
		for (const option of optionsByName.values()) {
			this.resolveOptionSteps(option);
		}

		this.options = Array.from(optionsByName.values()).sort((a, b) =>
			a.name.localeCompare(b.name),
		);

		Logger.info(
			`Routes loaded for profile ${profileId}: ${this.actions.size} action(s), ` +
				`${this.options.length} option(s), ${this.loadErrors.length} error(s).`,
		);
	}

	/** Parse a built-in action scaffold's `.md` into a definition (in-memory fallback). */
	private parseScaffoldAction(
		name: string,
		scaffoldContent: string,
	): RoutingActionDefinition | null {
		const fm = extractFrontmatter(scaffoldContent, parseYaml);
		if (!fm) {
			this.loadErrors.push({
				filePath: `(built-in action scaffold: ${name})`,
				message: 'Scaffold has no parseable frontmatter',
			});
			return null;
		}
		const parsed = parseRoutingActionFile(
			scaffoldContent,
			fm,
			`(built-in action scaffold: ${name})`,
			'built-in',
		);
		if (isRoutingError(parsed)) {
			this.loadErrors.push(parsed);
			return null;
		}
		return parsed;
	}

	/** Parse a built-in option scaffold's `.md` into a definition (in-memory fallback). */
	private parseScaffoldOption(
		name: string,
		scaffoldContent: string,
	): RoutingOptionDefinition | null {
		const fm = extractFrontmatter(scaffoldContent, parseYaml);
		if (!fm) {
			this.loadErrors.push({
				filePath: `(built-in option scaffold: ${name})`,
				message: 'Scaffold has no parseable frontmatter',
			});
			return null;
		}
		const parsed = parseRoutingOptionFile(
			scaffoldContent,
			fm,
			`(built-in option scaffold: ${name})`,
			'built-in',
		);
		if (isRoutingError(parsed)) {
			this.loadErrors.push(parsed);
			return null;
		}
		return parsed;
	}

	/** Recover a built-in action scaffold when a user override fails to compile. */
	private scaffoldFallbackFor(failed: RoutingActionDefinition): RoutingActionDefinition | null {
		const scaffold = BUILTIN_ROUTING_ACTION_SCAFFOLDS.get(failed.name);
		if (!scaffold) return null;
		const parsed = this.parseScaffoldAction(failed.name, scaffold.scaffoldContent);
		if (!parsed || parsed.kind !== 'code' || !parsed.rawCode) return parsed;
		const result = compileRoutingAction(parsed.rawCode);
		if ('error' in result) {
			this.recordCompileFailure(parsed, result.error);
			return null;
		}
		parsed.compiledFn = result.fn;
		return parsed;
	}

	/** Turn an option's `rawSteps` into concrete `RoutingStep[]`; mark degraded on missing refs. */
	private resolveOptionSteps(option: RoutingOptionDefinition): void {
		const steps: RoutingStep[] = [];
		for (const raw of option.rawSteps) {
			if ('ref' in raw) {
				const action = this.actions?.get(raw.ref);
				if (!action) {
					option.degraded = true;
					this.loadErrors.push({
						filePath: option.filePath,
						message: `Option '${option.name}' references unknown action '${raw.ref}'`,
					});
					continue;
				}
				steps.push({ action, params: raw.params, origin: 'reference' });
			} else {
				const action = this.buildInlineAction(option, raw.inline);
				if (!action) {
					option.degraded = true;
					continue;
				}
				steps.push({ action, origin: 'inline' });
			}
		}
		option.steps = steps;
	}

	/** Synthesize an ephemeral action definition from an inline step spec. */
	private buildInlineAction(
		option: RoutingOptionDefinition,
		spec: InlineActionSpec,
	): RoutingActionDefinition | null {
		const action: RoutingActionDefinition = {
			name: spec.name ?? `${option.name}:inline-${spec.kind}`,
			kind: spec.kind,
			description: spec.description,
			newNoteOnly: spec.newNoteOnly ?? false,
			idempotent: spec.idempotent ?? true,
			targetDir: spec.targetDir,
			publishContexts: spec.publishContexts,
			frontmatter: spec.frontmatter,
			templatePath: spec.templatePath,
			rawCode: spec.code,
			compiledFn: null,
			filePath: option.filePath,
			filename: option.filename,
			source: option.source,
			isScaffold: false,
		};
		if (spec.kind === 'code') {
			if (!spec.code) {
				this.loadErrors.push({
					filePath: option.filePath,
					message: `Inline code step in '${option.name}' has no code`,
				});
				return null;
			}
			const result = compileRoutingAction(spec.code);
			if ('error' in result) {
				this.loadErrors.push({ filePath: option.filePath, message: result.error });
				return null;
			}
			action.compiledFn = result.fn;
		}
		return action;
	}

	private recordCompileFailure(def: RoutingActionDefinition, error: string): void {
		this.loadErrors.push({ filePath: def.filePath, message: error });
		if (def.isScaffold) {
			const msg = `CRITICAL: Built-in routing action '${def.name}' failed to compile. See console.`;
			new Notice(msg);
			Logger.error(msg, { file: def.filePath, error });
		} else {
			new Notice(`Routing action '${def.name}' failed to compile; using the built-in. See console.`);
			Logger.error(`Routing action '${def.name}' failed to compile`, {
				file: def.filePath,
				error,
			});
		}
	}

	// -----------------------------------------------------------------------
	// Run (per command invocation)
	// -----------------------------------------------------------------------

	/**
	 * Entry point for the two commands. Loads routes, prompts for an option,
	 * optionally prompts for a title, then runs the option's steps in order.
	 */
	async runRoute(file: TFile, mode: RoutingMode): Promise<void> {
		const profileId = this.plugin.settings.publishingProfiles[0]?.id ?? 'default';
		await this.loadRoutes(profileId);

		if (!this.options || this.options.length === 0) {
			new Notice('No routing options found. Export the built-ins from CPN settings.');
			return;
		}

		const option = await this.pickOption();
		if (!option) return; // dismissed

		// Title prompt (before any move, so the rename + move don't race).
		await this.maybePromptTitle(file, option);

		await this.executeOption(file, option, mode);
	}

	/**
	 * Run a named option without the interactive suggester or title prompt.
	 * Loads routes, resolves the option by name, and executes its steps. Returns
	 * a structured result. Used by callers that already know the option (e.g. a
	 * per-option command, a future create-event hook) and by tests.
	 */
	async runOptionByName(
		file: TFile,
		optionName: string,
		mode: RoutingMode,
	): Promise<{ ok: boolean; error?: string; errors: string[] }> {
		const profileId = this.plugin.settings.publishingProfiles[0]?.id ?? 'default';
		await this.loadRoutes(profileId);

		const option = this.options?.find((o) => o.name === optionName);
		if (!option) {
			return { ok: false, error: `Unknown routing option '${optionName}'`, errors: [] };
		}
		return this.executeOption(file, option, mode);
	}

	private pickOption(): Promise<RoutingOptionDefinition | null> {
		return new Promise((resolve) => {
			new RoutingOptionSuggestModal(this.plugin.app, this.options!, resolve).open();
		});
	}

	private effectiveTitlePrompt(option: RoutingOptionDefinition): TitlePromptMode {
		return option.titlePrompt ?? this.plugin.settings.routingTitlePrompt ?? 'only-if-Untitled';
	}

	private async maybePromptTitle(file: TFile, option: RoutingOptionDefinition): Promise<void> {
		const mode = this.effectiveTitlePrompt(option);
		if (mode === 'off') return;
		if (mode === 'only-if-Untitled' && !file.basename.startsWith('Untitled')) return;

		const title = await new Promise<string | null>((resolve) => {
			new TitlePromptModal(this.plugin.app, file.basename, resolve).open();
		});
		if (!title || title === file.basename) return;

		const parentPath = file.parent && file.parent.path !== '/' ? `${file.parent.path}/` : '';
		const newPath = normalizePath(`${parentPath}${title}.${file.extension}`);
		if (this.plugin.app.vault.getAbstractFileByPath(newPath)) {
			new Notice(`A note named "${title}" already exists here; keeping the current title.`);
			return;
		}
		await this.plugin.app.fileManager.renameFile(file, newPath);
	}

	/**
	 * Run an option's resolved steps in order, honoring capability flags + on-error
	 * policy. Surfaces progress via Notices and returns a structured result so
	 * programmatic callers (and tests) can assert on the outcome.
	 */
	private async executeOption(
		file: TFile,
		option: RoutingOptionDefinition,
		mode: RoutingMode,
	): Promise<{ ok: boolean; error?: string; errors: string[] }> {
		const utils: RoutingUtils = { logger: Logger };
		const collected: string[] = [];

		for (const step of option.steps) {
			const action = step.action;

			// Capability-flag skipping when re-routing an existing note.
			if (mode === 'update' && (action.newNoteOnly || !action.idempotent)) {
				Logger.debug(`Routing: skipping '${action.name}' in update mode (not applicable)`);
				continue;
			}

			const params: Record<string, unknown> = {
				...this.declarativeParams(action),
				...(step.params ?? {}),
			};
			const context: RoutingContext = {
				file,
				mode,
				option,
				step,
				params,
				frontmatterManager: this.plugin.frontmatterManager,
				app: this.plugin.app,
			};

			try {
				await this.executeAction(action, context, utils);
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				this.loadErrors.push({ filePath: action.filePath, message });
				Logger.error(`Routing action '${action.name}' failed`, { error: message });
				if (option.onError === 'abort') {
					new Notice(`Routing aborted at "${action.name}": ${message}`);
					return { ok: false, error: `${action.name}: ${message}`, errors: [`${action.name}: ${message}`] };
				}
				collected.push(`${action.name}: ${message}`);
			}
		}

		if (collected.length > 0) {
			new Notice(
				`Routed "${file.basename}" via ${option.name} with ${collected.length} error(s). See console.`,
			);
		} else {
			new Notice(`Routed "${file.basename}" via ${option.name}.`);
		}
		return { ok: true, errors: collected };
	}

	/** The action's own declarative config, as a params object (step params override these). */
	private declarativeParams(action: RoutingActionDefinition): Record<string, unknown> {
		switch (action.kind) {
			case 'move':
				return action.targetDir !== undefined ? { dir: action.targetDir } : {};
			case 'publish-contexts':
				return action.publishContexts !== undefined ? { contexts: action.publishContexts } : {};
			case 'set-frontmatter':
				return action.frontmatter !== undefined ? { frontmatter: action.frontmatter } : {};
			case 'insert-template':
				return action.templatePath !== undefined ? { template: action.templatePath } : {};
			default:
				return {};
		}
	}

	/** Dispatch a single action by kind. Throws on failure (caught by the runner). */
	private async executeAction(
		action: RoutingActionDefinition,
		context: RoutingContext,
		utils: RoutingUtils,
	): Promise<void> {
		switch (action.kind) {
			case 'move':
				await this.runMove(action, context);
				break;
			case 'publish-contexts':
				await this.runPublishContexts(action, context);
				break;
			case 'set-frontmatter':
				await this.runSetFrontmatter(action, context);
				break;
			case 'insert-template':
				await this.runInsertTemplate(action, context);
				break;
			case 'code':
				if (!action.compiledFn) throw new Error(`Code action '${action.name}' is not compiled`);
				await action.compiledFn(this.libs!, context, this.plugin.app, utils);
				break;
		}
	}

	private async runMove(
		action: RoutingActionDefinition,
		context: RoutingContext,
	): Promise<void> {
		const dir = (context.params['dir'] as string) ?? action.targetDir;
		if (dir === undefined || dir === null) {
			throw new Error(`move action '${action.name}' has no target dir (set ${RK.TARGET_DIR} or params.dir)`);
		}
		const { file } = context;
		const cleanDir = normalizePath(String(dir).replace(/^\/+|\/+$/g, ''));
		const targetPath = normalizePath(
			cleanDir === '' ? `${file.basename}.${file.extension}` : `${cleanDir}/${file.basename}.${file.extension}`,
		);

		if (targetPath === file.path) return; // already here — no-op

		const existing = this.plugin.app.vault.getAbstractFileByPath(targetPath);
		if (existing && existing !== file) {
			// Never overwrite. In update mode this is a benign skip; surface it.
			new Notice(`Skipped move: "${targetPath}" already exists.`);
			return;
		}

		if (cleanDir !== '') {
			await PathUtils.ensureDirectory(this.plugin, cleanDir);
		}
		await this.plugin.app.fileManager.renameFile(file, targetPath);
	}

	private async runPublishContexts(
		action: RoutingActionDefinition,
		context: RoutingContext,
	): Promise<void> {
		const contexts = (context.params['contexts'] as string[]) ?? action.publishContexts;
		if (!Array.isArray(contexts) || contexts.length === 0) {
			throw new Error(`publish-contexts action '${action.name}' has no contexts`);
		}
		await this.plugin.frontmatterManager.mergeFrontmatter(context.file, {
			[RK.PUBLISH_CONTEXTS]: contexts,
		});
	}

	private async runSetFrontmatter(
		action: RoutingActionDefinition,
		context: RoutingContext,
	): Promise<void> {
		const raw = (context.params['frontmatter'] as Record<string, unknown>) ?? action.frontmatter;
		if (!raw || typeof raw !== 'object') {
			throw new Error(`set-frontmatter action '${action.name}' has no frontmatter mapping`);
		}
		const resolved = this.resolveFrontmatterSentinels(raw, context);
		await this.plugin.frontmatterManager.mergeFrontmatter(context.file, resolved);
	}

	/** Resolve a `cpn-routing-template` reference (wikilink or vault path) to a `TFile`. */
	private resolveTemplateFile(raw: string, context: RoutingContext): TFile | null {
		const linkpath = stripToLinkpath(raw);
		// Wikilinks, relative names, and subpaths (source path enables relative resolution).
		const viaLink = context.app.metadataCache.getFirstLinkpathDest(linkpath, context.file.path);
		if (viaLink) return viaLink;
		// Explicit vault path fallback (with or without the `.md` extension).
		const direct =
			context.app.vault.getAbstractFileByPath(linkpath) ??
			context.app.vault.getAbstractFileByPath(normalizePath(`${linkpath}.md`));
		return direct instanceof TFile ? direct : null; // guard against a TFolder match
	}

	private async runInsertTemplate(
		action: RoutingActionDefinition,
		context: RoutingContext,
	): Promise<void> {
		const raw = (context.params['template'] as string) ?? action.templatePath;
		if (!raw || typeof raw !== 'string') {
			throw new Error(
				`insert-template action '${action.name}' has no template (set ${RK.TEMPLATE} or params.template)`,
			);
		}
		const templateFile = this.resolveTemplateFile(raw, context);
		if (!templateFile) {
			// A thrown error DOES honor the option's cpn-routing-on-error policy.
			throw new Error(`insert-template action '${action.name}': template not found: '${raw}'`);
		}
		const ran = await this.libs!.runTemplaterTemplate(templateFile, context.file);
		if (!ran) {
			// Templater absent — skip with a Notice rather than aborting the option.
			new Notice(`Skipped "${action.name}": Templater is not installed/enabled.`);
			Logger.warn('insert-template skipped: Templater unavailable', { action: action.name });
		}
	}

	/** Replace `$now` / `$ctime` string sentinels with computed values. */
	private resolveFrontmatterSentinels(
		raw: Record<string, unknown>,
		context: RoutingContext,
	): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(raw)) {
			if (value === '$now') out[key] = this.libs!.now();
			else if (value === '$ctime') out[key] = this.libs!.ctimeOf(context.file);
			else out[key] = value;
		}
		return out;
	}

	// -----------------------------------------------------------------------
	// Scaffold materialization (settings UI / commands)
	// -----------------------------------------------------------------------

	getBuiltinActionNames(): string[] {
		return Array.from(BUILTIN_ROUTING_ACTION_SCAFFOLDS.keys());
	}

	getBuiltinOptionNames(): string[] {
		return Array.from(BUILTIN_ROUTING_OPTION_SCAFFOLDS.keys());
	}

	getBuiltinActionScaffold(name: string) {
		return BUILTIN_ROUTING_ACTION_SCAFFOLDS.get(name);
	}

	getBuiltinOptionScaffold(name: string) {
		return BUILTIN_ROUTING_OPTION_SCAFFOLDS.get(name);
	}

	builtinActionVaultPath(name: string): string {
		return normalizePath(`${this.actionsDir()}/${name}.md`);
	}

	builtinOptionVaultPath(name: string): string {
		return normalizePath(`${this.optionsDir()}/${name}.md`);
	}

	builtinActionFileExists(name: string): boolean {
		return this.plugin.app.vault.getAbstractFileByPath(this.builtinActionVaultPath(name)) !== null;
	}

	builtinOptionFileExists(name: string): boolean {
		return this.plugin.app.vault.getAbstractFileByPath(this.builtinOptionVaultPath(name)) !== null;
	}

	getLoadErrors(): RoutingError[] {
		return this.loadErrors;
	}

	private async ensureFile(dir: string, filePath: string, content: string): Promise<string> {
		if (this.plugin.app.vault.getAbstractFileByPath(filePath)) return filePath;
		if (!this.plugin.app.vault.getAbstractFileByPath(dir)) {
			await PathUtils.ensureDirectory(this.plugin, dir);
		}
		await this.plugin.app.vault.create(filePath, content);
		Logger.info('Created routing scaffold', { path: filePath });
		return filePath;
	}

	async ensureBuiltinActionVaultFile(name: string): Promise<string> {
		const scaffold = BUILTIN_ROUTING_ACTION_SCAFFOLDS.get(name);
		if (!scaffold) throw new Error(`No built-in routing action "${name}"`);
		return this.ensureFile(this.actionsDir(), this.builtinActionVaultPath(name), scaffold.scaffoldContent);
	}

	async ensureBuiltinOptionVaultFile(name: string): Promise<string> {
		const scaffold = BUILTIN_ROUTING_OPTION_SCAFFOLDS.get(name);
		if (!scaffold) throw new Error(`No built-in routing option "${name}"`);
		return this.ensureFile(this.optionsDir(), this.builtinOptionVaultPath(name), scaffold.scaffoldContent);
	}

	async resetBuiltinActionToDefault(name: string): Promise<void> {
		if (!BUILTIN_ROUTING_ACTION_SCAFFOLDS.has(name)) {
			throw new Error(`No built-in routing action "${name}"`);
		}
		const existing = this.plugin.app.vault.getAbstractFileByPath(this.builtinActionVaultPath(name));
		if (existing) await this.plugin.app.vault.delete(existing);
	}

	async resetBuiltinOptionToDefault(name: string): Promise<void> {
		if (!BUILTIN_ROUTING_OPTION_SCAFFOLDS.has(name)) {
			throw new Error(`No built-in routing option "${name}"`);
		}
		const existing = this.plugin.app.vault.getAbstractFileByPath(this.builtinOptionVaultPath(name));
		if (existing) await this.plugin.app.vault.delete(existing);
	}

	/** Materialize every built-in action + option to the vault. Returns the file paths. */
	async exportAllScaffolds(): Promise<string[]> {
		const paths: string[] = [];
		for (const name of BUILTIN_ROUTING_ACTION_SCAFFOLDS.keys()) {
			paths.push(await this.ensureBuiltinActionVaultFile(name));
		}
		for (const name of BUILTIN_ROUTING_OPTION_SCAFFOLDS.keys()) {
			paths.push(await this.ensureBuiltinOptionVaultFile(name));
		}
		return paths;
	}
}
