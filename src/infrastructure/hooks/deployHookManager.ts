/**
 * DeployHookManager — discovers, compiles, and runs the user-extensible
 * deploy-lifecycle hooks around the full-stack deploy.
 *
 * Modeled on `ParserExtensionManager` but simplified: hooks run for side effects
 * (return value ignored, like a routing `code` action) and have NO built-in
 * behavior — so there is no scaffold-fallback recovery. A hook that fails to
 * compile is a recorded, dropped load error; a hook that throws at runtime is
 * surfaced loudly but does NOT fail the deploy (succeed-with-warning).
 *
 * Hooks are PER-PROFILE: each deploy scans only
 * `{cpnDirectory}/profiles/{profileId}/hooks/`, so a hook authored for one site
 * never fires for another. `runDeployHooks(phase, args)` is the single entry
 * point the deploy settle points call, and it never throws.
 */

import { Notice, normalizePath, parseYaml } from 'obsidian';
import CommonplaceNotesPlugin from '../../main';
import { Logger } from '../../utils/logging';
import type { PublishingProfile } from '../../types';
import type { StackOutputs } from '../types';
import { compileDeployHook } from './compiler';
import { discoverDeployHooks, type DeployHookSearchDir } from './discovery';
import { buildDeployHookAws } from './awsHandle';
import { BUILTIN_DEPLOY_HOOK_SCAFFOLDS } from './scaffolds';
import type {
	BuiltinDeployHookScaffold,
	DeployHookContext,
	DeployHookDefinition,
	DeployHookError,
	DeployHookPhase,
	DeployHookUtils,
} from './types';

const DEFAULT_CPN_DIR = 'cpn';

export class DeployHookManager {
	private plugin: CommonplaceNotesPlugin;

	/** Compiled, filename-sorted hooks from the last load. */
	private hooks: DeployHookDefinition[] | null = null;
	private loadErrors: DeployHookError[] = [];

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
	}

	// -----------------------------------------------------------------------
	// Directory resolution (per-profile)
	// -----------------------------------------------------------------------

	/** Base CPN vault directory (settings, default `cpn`), trailing slash stripped. */
	private cpnBaseDir(): string {
		const raw = this.plugin.settings.cpnDirectory || DEFAULT_CPN_DIR;
		return normalizePath(raw.replace(/\/+$/, ''));
	}

	/** Vault dir holding a profile's deploy hooks. Mirrors `getAssetsDir`. */
	profileHooksDir(profileId: string): string {
		return normalizePath(`${this.cpnBaseDir()}/profiles/${profileId}/hooks`);
	}

	/** Ordered search dirs. v1 is the single per-profile tier. */
	private searchDirs(profileId: string): DeployHookSearchDir[] {
		return [{ path: this.profileHooksDir(profileId), source: 'profile' }];
	}

	// -----------------------------------------------------------------------
	// Load (once per deploy phase)
	// -----------------------------------------------------------------------

	/**
	 * Discover + compile all hooks for a profile, caching the result. Clears
	 * prior state so edited vault files take effect on the next deploy (no
	 * watcher needed). A broken hook is recorded and dropped — no fallback.
	 */
	async loadHooks(profileId: string): Promise<void> {
		this.hooks = null;
		this.loadErrors = [];

		const discovered = await discoverDeployHooks(
			this.plugin.app.vault,
			this.plugin.app.metadataCache,
			this.searchDirs(profileId),
			parseYaml,
		);
		this.loadErrors.push(...discovered.errors);

		const compiled: DeployHookDefinition[] = [];
		for (const def of discovered.definitions) {
			const result = compileDeployHook(def.rawCode);
			if ('error' in result) {
				this.recordCompileFailure(def, result.error);
				continue;
			}
			def.compiledFn = result.fn;
			compiled.push(def);
		}

		// No order field in v1 — deterministic by filename.
		compiled.sort((a, b) => a.filename.localeCompare(b.filename));

		this.hooks = compiled;

		Logger.info(
			`Deploy hooks loaded for profile ${profileId}: ` +
				`${compiled.length} hook(s), ${this.loadErrors.length} error(s).`,
		);
	}

	// -----------------------------------------------------------------------
	// Run (the single entry point the deploy settle points call)
	// -----------------------------------------------------------------------

	/**
	 * Load + run every hook for the given phase. NEVER throws — a fault in a
	 * hook (or in the subsystem itself) is surfaced but the deploy proceeds
	 * (succeed-with-warning). Overloaded so `'post'` callers must supply
	 * non-null outputs (the stack has reached a terminal success state).
	 */
	async runDeployHooks(
		phase: 'pre',
		args: { profile: PublishingProfile; outputs: StackOutputs | null },
	): Promise<void>;
	async runDeployHooks(
		phase: 'post',
		args: { profile: PublishingProfile; outputs: StackOutputs },
	): Promise<void>;
	async runDeployHooks(
		phase: DeployHookPhase,
		args: { profile: PublishingProfile; outputs: StackOutputs | null },
	): Promise<void> {
		try {
			const { profile, outputs } = args;
			await this.loadHooks(profile.id);
			const matching = (this.hooks ?? []).filter((h) => h.phase === phase);
			if (matching.length === 0) return;

			const aws = buildDeployHookAws(this.plugin, profile);
			const utils: DeployHookUtils = { logger: Logger };
			const awsProfile = profile.awsSettings!.awsProfile;
			const region = profile.awsSettings!.region;
			const context: DeployHookContext =
				phase === 'pre'
					? { phase: 'pre', outputs, awsProfile, region }
					: { phase: 'post', outputs: outputs as StackOutputs, awsProfile, region };

			for (const hook of matching) {
				if (!hook.compiledFn) continue;
				try {
					await hook.compiledFn(aws, context, utils);
					Logger.info(`Deploy hook '${hook.name}' (${phase}) ran.`, { file: hook.filePath });
				} catch (e) {
					this.recordRuntimeFailure(hook, e);
				}
			}
		} catch (e) {
			// Defensive: a fault in the hook subsystem itself must never fail a deploy.
			Logger.error('Deploy-hook subsystem error (deploy unaffected):', e);
		}
	}

	private recordCompileFailure(def: DeployHookDefinition, error: string): void {
		this.loadErrors.push({ filePath: def.filePath, message: error });
		const msg = `Deploy hook '${def.name}' failed to compile and was skipped. See console.`;
		new Notice(msg);
		Logger.error(`Deploy hook '${def.name}' failed to compile`, { file: def.filePath, error });
	}

	private recordRuntimeFailure(hook: DeployHookDefinition, e: unknown): void {
		const message = e instanceof Error ? e.message : String(e);
		this.loadErrors.push({ filePath: hook.filePath, message });
		const msg = `Deploy hook '${hook.name}' (${hook.phase}) threw; the deploy succeeded with a warning. See console.`;
		new Notice(msg);
		Logger.error(`Deploy hook '${hook.name}' failed at runtime`, {
			file: hook.filePath,
			error: message,
		});
	}

	// -----------------------------------------------------------------------
	// Settings-facing helpers (validation + example materialization)
	// -----------------------------------------------------------------------

	/** Errors from the most recent load (for surfacing in settings UI). */
	getLoadErrors(): DeployHookError[] {
		return this.loadErrors;
	}

	/**
	 * Discover + compile a profile's hooks WITHOUT running them, for on-demand
	 * settings display (the "Validate hooks" button). Returns the resolved
	 * definitions and any load errors.
	 */
	async validateHooks(profileId: string): Promise<{
		definitions: DeployHookDefinition[];
		errors: DeployHookError[];
	}> {
		await this.loadHooks(profileId);
		return { definitions: this.hooks ?? [], errors: this.loadErrors };
	}

	/** Names of the materializable example hooks. */
	getBuiltinDeployHookNames(): string[] {
		return Array.from(BUILTIN_DEPLOY_HOOK_SCAFFOLDS.keys());
	}

	/** Metadata for an example hook (for settings UI labels). */
	getBuiltinScaffold(name: string): BuiltinDeployHookScaffold | undefined {
		return BUILTIN_DEPLOY_HOOK_SCAFFOLDS.get(name);
	}

	/** Vault-relative path where an example hook's materialized file lives. */
	builtinVaultPath(profileId: string, name: string): string {
		return normalizePath(`${this.profileHooksDir(profileId)}/${name}.md`);
	}

	/** True if a file for this example name already exists in the profile's dir. */
	builtinVaultFileExists(profileId: string, name: string): boolean {
		return (
			this.plugin.app.vault.getAbstractFileByPath(this.builtinVaultPath(profileId, name)) !== null
		);
	}

	/**
	 * Write an example hook's scaffold into the profile's hooks dir if absent,
	 * returning its path. No-op (returns the existing path) if a file exists.
	 */
	async ensureBuiltinDeployHookVaultFile(profileId: string, name: string): Promise<string> {
		const scaffold = BUILTIN_DEPLOY_HOOK_SCAFFOLDS.get(name);
		if (!scaffold) throw new Error(`No example deploy hook named "${name}"`);

		const dir = this.profileHooksDir(profileId);
		const filePath = this.builtinVaultPath(profileId, name);

		if (this.plugin.app.vault.getAbstractFileByPath(filePath)) {
			return filePath;
		}
		if (!this.plugin.app.vault.getAbstractFileByPath(dir)) {
			await this.plugin.app.vault.createFolder(dir);
		}
		await this.plugin.app.vault.create(filePath, scaffold.scaffoldContent);
		Logger.info(`Created example deploy hook`, { name, path: filePath });
		return filePath;
	}

	/** Materialize every example hook into the profile's dir. Returns the paths. */
	async exportExampleHooks(profileId: string): Promise<string[]> {
		const paths: string[] = [];
		for (const name of BUILTIN_DEPLOY_HOOK_SCAFFOLDS.keys()) {
			paths.push(await this.ensureBuiltinDeployHookVaultFile(profileId, name));
		}
		return paths;
	}
}
