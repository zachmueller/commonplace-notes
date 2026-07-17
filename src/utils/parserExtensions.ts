/**
 * ParserExtensionManager — discovers, compiles, and assembles the user-extensible
 * Markdown→HTML parser pipeline.
 *
 * Modeled on Notor's `ExtensionManager` (`shared/notor/src/extensions/manager.ts`).
 * Two-phase lifecycle for performance:
 *   - `loadExtensions(profileId)` runs ONCE per publish batch: discover vault
 *     files, inject scaffold fallbacks for missing built-ins, compile every
 *     stage (sucrase strip + AsyncFunction), resolve overrides, sort.
 *   - `assemblePipeline(profileId, context)` runs ONCE PER NOTE: invoke each
 *     cached compiled stage with the per-note `context` and `.use()` the
 *     returned plugin onto a fresh `unified()` processor.
 *
 * Built-ins are overridable: a vault file whose `cpn-parser-name` matches a
 * built-in replaces it; deleting the file restores the default. When no vault
 * file exists for a built-in, the same scaffold content runs as an in-memory
 * fallback — so the pipeline always works.
 */

import { Notice, normalizePath, parseYaml } from 'obsidian';
import type { Plugin, Processor } from 'unified';
import CommonplaceNotesPlugin from '../main';
import { Logger } from './logging';
import { buildParserLibs } from './parser/libs';
import { compileParserExtension } from './parser/compiler';
import { discoverParserExtensions, type ParserSearchDir } from './parser/discovery';
import { parseParserExtensionFile, isParserError } from './parser/parserFile';
import { BUILTIN_PARSER_SCAFFOLDS } from './parser/scaffolds';
import type {
	ParserContext,
	ParserExtensionDefinition,
	ParserExtensionError,
	ParserLibs,
	ParserUtils,
} from './parser/types';

const DEFAULT_CPN_DIR = 'cpn';

export class ParserExtensionManager {
	private plugin: CommonplaceNotesPlugin;

	/** Compiled, override-resolved, order-sorted stages from the last load. */
	private resolvedStages: ParserExtensionDefinition[] | null = null;
	private loadErrors: ParserExtensionError[] = [];
	private libs: ParserLibs | null = null;

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
	}

	// -----------------------------------------------------------------------
	// Directory resolution (forward-compatible with the v2 profile tier)
	// -----------------------------------------------------------------------

	/** Base CPN vault directory (settings, default `cpn`), trailing slash stripped. */
	private cpnBaseDir(): string {
		const raw = this.plugin.settings.cpnDirectory || DEFAULT_CPN_DIR;
		return normalizePath(raw.replace(/\/+$/, ''));
	}

	/** Vault dir holding global parser stages. */
	private parsersDir(): string {
		return normalizePath(`${this.cpnBaseDir()}/parsers`);
	}

	/**
	 * Ordered search dirs; later entries override earlier ones by name. v1 is
	 * global-only; the v2 profile tier prepends `cpn/profiles/<id>/parsers`
	 * AFTER the global entry (so profile wins) — a one-line addition here.
	 */
	private searchDirs(_profileId: string): ParserSearchDir[] {
		return [
			{ path: this.parsersDir(), source: 'global' },
			// v2: { path: normalizePath(`${this.cpnBaseDir()}/profiles/${_profileId}/parsers`), source: 'profile' },
		];
	}

	// -----------------------------------------------------------------------
	// Load (once per publish batch)
	// -----------------------------------------------------------------------

	/**
	 * Discover + compile + resolve all stages for a profile, caching the result.
	 * Called once at the start of a publish batch. Clears prior state so edited
	 * vault files take effect on the next publish (no watcher needed).
	 */
	async loadExtensions(profileId: string): Promise<void> {
		this.resolvedStages = null;
		this.loadErrors = [];
		this.libs = buildParserLibs();

		// 1. Discover vault files.
		const discovered = await discoverParserExtensions(
			this.plugin.app.vault,
			this.plugin.app.metadataCache,
			this.searchDirs(profileId),
			parseYaml,
		);
		this.loadErrors.push(...discovered.errors);

		const byName = new Map<string, ParserExtensionDefinition>();
		for (const def of discovered.definitions) {
			byName.set(def.name, def);
		}

		// 2. Inject scaffold fallbacks for built-ins with no vault override.
		//    (Mirrors Notor manager.ts "Inject scaffold fallbacks" loop.)
		for (const [name, scaffold] of BUILTIN_PARSER_SCAFFOLDS) {
			if (byName.has(name)) continue; // user override present — skip fallback
			const frontmatter: Record<string, unknown> = {
				'cpn-type': 'parser',
				'cpn-parser-name': scaffold.name,
				'cpn-parser-stage': scaffold.stage,
				'cpn-parser-order': scaffold.order,
				'cpn-description': scaffold.description,
			};
			const parsed = parseParserExtensionFile(
				scaffold.scaffoldContent,
				frontmatter,
				`(built-in scaffold: ${name})`,
				'built-in',
			);
			if (isParserError(parsed)) {
				// Should never happen — scaffolds are authored in-repo.
				this.loadErrors.push(parsed);
				continue;
			}
			byName.set(name, parsed);
		}

		// 3. Compile every stage. A broken USER override falls back to the
		//    built-in scaffold; a broken built-in scaffold is CRITICAL.
		const compiled: ParserExtensionDefinition[] = [];
		for (const def of byName.values()) {
			const result = compileParserExtension(def.rawCode);
			if ('error' in result) {
				this.recordCompileFailure(def, result.error);
				const fallback = this.scaffoldFallbackFor(def);
				if (fallback) compiled.push(fallback);
				continue;
			}
			def.compiledFn = result.fn;
			compiled.push(def);
		}

		// 4. Resolve order: sort by `order`, ties broken by filename.
		compiled.sort((a, b) =>
			a.order !== b.order ? a.order - b.order : a.filename.localeCompare(b.filename),
		);

		this.resolvedStages = compiled;

		Logger.info(
			`Parser extensions loaded for profile ${profileId}: ` +
				`${compiled.length} stage(s), ${this.loadErrors.length} error(s).`,
		);
	}

	/**
	 * When a non-scaffold (user) override fails to compile, recover the built-in
	 * scaffold of the same name so the canonical stage still runs. Returns a
	 * freshly-compiled scaffold definition, or null if there's no built-in for
	 * this name (a purely user-added stage — it's simply dropped) or the
	 * scaffold itself fails (CRITICAL, already surfaced).
	 */
	private scaffoldFallbackFor(failed: ParserExtensionDefinition): ParserExtensionDefinition | null {
		const scaffold = BUILTIN_PARSER_SCAFFOLDS.get(failed.name);
		if (!scaffold) return null; // user-added stage with no built-in — drop it
		const frontmatter: Record<string, unknown> = {
			'cpn-type': 'parser',
			'cpn-parser-name': scaffold.name,
			'cpn-parser-stage': scaffold.stage,
			'cpn-parser-order': scaffold.order,
			'cpn-description': scaffold.description,
		};
		const parsed = parseParserExtensionFile(
			scaffold.scaffoldContent,
			frontmatter,
			`(built-in scaffold: ${scaffold.name})`,
			'built-in',
		);
		if (isParserError(parsed)) return null;
		const result = compileParserExtension(parsed.rawCode);
		if ('error' in result) {
			this.recordCompileFailure(parsed, result.error);
			return null;
		}
		parsed.compiledFn = result.fn;
		return parsed;
	}

	private recordCompileFailure(def: ParserExtensionDefinition, error: string): void {
		this.loadErrors.push({ filePath: def.filePath, message: error });
		if (def.isScaffold) {
			const msg = `CRITICAL: Built-in parser stage '${def.name}' failed to load. Published HTML may be malformed.`;
			new Notice(msg);
			Logger.error(msg, { file: def.filePath, error });
		} else {
			const msg = `Parser extension '${def.name}' failed to compile; using the built-in. See console.`;
			new Notice(msg);
			Logger.error(`Parser extension '${def.name}' failed to compile`, {
				file: def.filePath,
				error,
			});
		}
	}

	// -----------------------------------------------------------------------
	// Assemble (once per note)
	// -----------------------------------------------------------------------

	/**
	 * Build a ready-to-run `unified()` processor for one note. Invokes each
	 * cached compiled stage with `(libs, context, app, utils)` — awaited, since
	 * compiled stages are AsyncFunctions — and `.use()`s the returned plugin (or
	 * `[plugin, options]`). A stage that throws or returns a bad shape is logged
	 * and skipped (the rest of the pipeline still runs).
	 */
	async assemblePipeline(profileId: string, context: ParserContext): Promise<Processor> {
		if (!this.resolvedStages || !this.libs) {
			// Safety net — normally loadExtensions runs first in publishNotes.
			await this.loadExtensions(profileId);
		}
		const libs = this.libs!;
		const utils: ParserUtils = { logger: Logger, slug: libs.githubSlugger.slug };

		let processor = libs.unified();
		for (const def of this.resolvedStages!) {
			if (!def.compiledFn) continue;
			let produced: unknown;
			try {
				produced = await def.compiledFn(libs, context, this.plugin.app, utils);
			} catch (e) {
				this.recordRuntimeFailure(def, e);
				continue;
			}
			if (typeof produced === 'function') {
				processor = processor.use(produced as Plugin);
			} else if (Array.isArray(produced) && typeof produced[0] === 'function') {
				const [plugin, options] = produced as [Plugin, unknown];
				processor = processor.use(plugin, options as Record<string, unknown>);
			} else {
				this.recordRuntimeFailure(
					def,
					new Error(
						`stage must return a unified plugin or [plugin, options]; got ${typeof produced}`,
					),
				);
			}
		}
		return processor;
	}

	private recordRuntimeFailure(def: ParserExtensionDefinition, e: unknown): void {
		const message = e instanceof Error ? e.message : String(e);
		this.loadErrors.push({ filePath: def.filePath, message });
		if (def.isScaffold) {
			const msg = `CRITICAL: Built-in parser stage '${def.name}' failed at runtime: ${message}`;
			new Notice(msg);
			Logger.error(msg, { file: def.filePath });
		} else {
			Logger.error(`Parser stage '${def.name}' failed at runtime; skipping`, {
				file: def.filePath,
				error: message,
			});
		}
	}

	// -----------------------------------------------------------------------
	// Scaffold materialization (settings UI / commands)
	// -----------------------------------------------------------------------

	/** Canonical built-in stage names, in default execution order. */
	getBuiltinParserNames(): string[] {
		return Array.from(BUILTIN_PARSER_SCAFFOLDS.values())
			.sort((a, b) => a.order - b.order)
			.map((s) => s.name);
	}

	/** Metadata for a built-in (for settings UI labels). */
	getBuiltinScaffold(name: string) {
		return BUILTIN_PARSER_SCAFFOLDS.get(name);
	}

	/** Vault-relative path where a built-in's materialized file lives. */
	builtinVaultPath(name: string): string {
		return normalizePath(`${this.parsersDir()}/${name}.md`);
	}

	/** True if the user has materialized (or hand-authored) a file for this name. */
	builtinVaultFileExists(name: string): boolean {
		return this.plugin.app.vault.getAbstractFileByPath(this.builtinVaultPath(name)) !== null;
	}

	/** Errors from the most recent load (for surfacing in settings UI). */
	getLoadErrors(): ParserExtensionError[] {
		return this.loadErrors;
	}

	/**
	 * Write a built-in's scaffold to the vault if absent, returning its path.
	 * No-op (returns the existing path) if a file already exists.
	 * Port of Notor `ensureBuiltinToolVaultFile`.
	 */
	async ensureBuiltinParserVaultFile(name: string): Promise<string> {
		const scaffold = BUILTIN_PARSER_SCAFFOLDS.get(name);
		if (!scaffold) throw new Error(`No built-in scaffold for parser stage "${name}"`);

		const dir = this.parsersDir();
		const filePath = this.builtinVaultPath(name);

		if (this.plugin.app.vault.getAbstractFileByPath(filePath)) {
			return filePath;
		}
		if (!this.plugin.app.vault.getAbstractFileByPath(dir)) {
			await this.plugin.app.vault.createFolder(dir);
		}
		await this.plugin.app.vault.create(filePath, scaffold.scaffoldContent);
		Logger.info(`Created built-in parser scaffold`, { name, path: filePath });
		return filePath;
	}

	/**
	 * Delete a built-in's vault file so the in-memory scaffold fallback resumes.
	 * Port of Notor `resetBuiltinToolToDefault`.
	 */
	async resetBuiltinParserToDefault(name: string): Promise<void> {
		if (!BUILTIN_PARSER_SCAFFOLDS.has(name)) {
			throw new Error(`No built-in scaffold for parser stage "${name}"`);
		}
		const existing = this.plugin.app.vault.getAbstractFileByPath(this.builtinVaultPath(name));
		if (existing) {
			await this.plugin.app.vault.delete(existing);
			Logger.info(`Reset built-in parser stage to default`, { name });
		}
	}

	/** Materialize every built-in scaffold at once. Returns the file paths. */
	async exportAllScaffolds(): Promise<string[]> {
		const paths: string[] = [];
		for (const name of BUILTIN_PARSER_SCAFFOLDS.keys()) {
			paths.push(await this.ensureBuiltinParserVaultFile(name));
		}
		return paths;
	}
}
