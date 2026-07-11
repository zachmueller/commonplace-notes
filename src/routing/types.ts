/**
 * Type definitions for the note-routing engine.
 *
 * Routing artifacts are authored as vault `.md` notes discovered like parser
 * stages (see `src/utils/parser/types.ts`), but there are TWO file types:
 *   - ACTIONS (`cpn/routes/actions/`) — reusable building blocks (move a note,
 *     set frontmatter, set publish contexts, or run embedded TS).
 *   - OPTIONS (`cpn/routes/options/`) — the user-facing routing choices shown in
 *     the suggester; each composes an ordered list of steps that reference shared
 *     actions (by wikilink, optionally with params) and/or define inline actions.
 *
 * Embedded `code` actions run with a CPN-supplied `libs` toolkit and a per-run
 * `context` in scope (no `import` — vault `.md` never passes through esbuild).
 */

import type { App, TFile } from 'obsidian';
import type { FrontmatterManager } from '../utils/frontmatter';

/** Whether routing runs on a brand-new note or re-routes an existing one. */
export type RoutingMode = 'create' | 'update';

/** Where a discovered action/option came from. `'profile'` is reserved for v2. */
export type RoutingSource = 'built-in' | 'global' | 'profile';

/** The kinds of action the runner knows how to execute. */
export type RoutingActionKind =
	| 'move'
	| 'set-frontmatter'
	| 'publish-contexts'
	| 'insert-template'
	| 'code';

/** Per-option failure policy. */
export type OnError = 'abort' | 'continue';

/** Title-prompt behavior (global default, per-option override). */
export type TitlePromptMode = 'always' | 'only-if-Untitled' | 'off';

// ---------------------------------------------------------------------------
// Action definitions
// ---------------------------------------------------------------------------

/**
 * A discovered/scaffolded routing ACTION — the reusable building block an option
 * composes. Declarative kinds (`move`, `set-frontmatter`, `publish-contexts`)
 * carry their config in frontmatter; `code` carries a compiled TS body.
 */
export interface RoutingActionDefinition {
	/** `cpn-routing-action-name` — unique key for wikilink references + override matching. */
	name: string;
	/** `cpn-routing-action-kind`. */
	kind: RoutingActionKind;
	/** `cpn-description`, if any. */
	description?: string;
	/** `cpn-routing-new-note-only` — skipped when routing an existing note. Default false. */
	newNoteOnly: boolean;
	/** `cpn-routing-idempotent` — if false, skipped in update mode (re-running would clobber). Default true. */
	idempotent: boolean;

	// -- kind-specific declarative config (params may override at the step level) --
	/** `move`: `cpn-routing-target-dir`. */
	targetDir?: string;
	/** `publish-contexts`: `cpn-publish-contexts`. */
	publishContexts?: string[];
	/** `set-frontmatter`: `cpn-routing-frontmatter` object (values may use `$now`/`$ctime` sentinels). */
	frontmatter?: Record<string, unknown>;
	/** `insert-template`: `cpn-routing-template` — raw vault path or `[[wikilink]]` to a Templater template. */
	templatePath?: string;

	// -- code kind only --
	/** Raw TS/JS from the code fence. */
	rawCode?: string;
	/** Populated by the compile step; null until then (and always null for non-code kinds). */
	compiledFn: CompiledRoutingFn | null;

	// -- provenance --
	filePath: string;
	filename: string;
	source: RoutingSource;
	isScaffold: boolean;
}

// ---------------------------------------------------------------------------
// Option definitions + steps
// ---------------------------------------------------------------------------

/** An inline action spec authored directly in an option's `cpn-routing-steps`. */
export interface InlineActionSpec {
	kind: RoutingActionKind;
	name?: string;
	description?: string;
	newNoteOnly?: boolean;
	idempotent?: boolean;
	targetDir?: string;
	publishContexts?: string[];
	frontmatter?: Record<string, unknown>;
	templatePath?: string;
	code?: string;
}

/** A step as authored in `cpn-routing-steps`, before resolution against the action registry. */
export type RawStep =
	| { ref: string; params?: Record<string, unknown> }
	| { inline: InlineActionSpec };

/** A resolved step inside an option's pipeline (concrete, post-resolution). */
export interface RoutingStep {
	action: RoutingActionDefinition;
	/** Per-reference overrides, merged over the action's declarative config (params win). */
	params?: Record<string, unknown>;
	origin: 'reference' | 'inline';
}

/**
 * A discovered/scaffolded routing OPTION — a user-facing routing choice. Its
 * `steps` are resolved from `rawSteps` once every action is known.
 */
export interface RoutingOptionDefinition {
	/** `cpn-routing-option-name` — shown in the suggester. */
	name: string;
	/** `cpn-description` — shown in the suggester. */
	description?: string;
	/** `cpn-routing-on-error`. Default `'abort'`. */
	onError: OnError;
	/** `cpn-routing-title-prompt` — per-option override of the global default. */
	titlePrompt?: TitlePromptMode;

	/** Resolved, ordered pipeline. */
	steps: RoutingStep[];
	/** Pre-resolution step entries as authored. */
	rawSteps: RawStep[];
	/** True when one or more referenced actions failed to resolve (surfaced in settings). */
	degraded: boolean;

	// -- provenance --
	filePath: string;
	filename: string;
	source: RoutingSource;
	isScaffold: boolean;
}

// ---------------------------------------------------------------------------
// Runtime context + compiled function
// ---------------------------------------------------------------------------

/** Per-step runtime context handed to every action executor (and `code` bodies). */
export interface RoutingContext {
	file: TFile;
	mode: RoutingMode;
	option: RoutingOptionDefinition;
	step: RoutingStep;
	/** Effective params for this step (action config overlaid by step params). */
	params: Record<string, unknown>;
	frontmatterManager: FrontmatterManager;
	app: App;
}

/**
 * A `code` action's compiled body. Receives the toolkit + context. Always async
 * (`new AsyncFunction` returns a Promise even without `await`), so callers await.
 * Same arg positions as the parser's `CompiledParserFn` — only the types differ.
 */
export type CompiledRoutingFn = (
	libs: RoutingLibs,
	context: RoutingContext,
	app: App,
	utils: RoutingUtils,
) => Promise<unknown>;

/** Small read-only helper bag injected as the `utils` argument. */
export interface RoutingUtils {
	logger: typeof import('../utils/logging').Logger;
}

/**
 * The bundled toolkit exposed to `code` actions as `libs`. Adding a key is a
 * plugin-code change, by design.
 */
export interface RoutingLibs {
	/** Format the current time (default `YYYY-MM-DD HH:mm`), matching the Templater `created-at`. */
	now: (format?: string) => string;
	/** Format a file's creation time (`file.stat.ctime`) in the same default format. */
	ctimeOf: (file: TFile, format?: string) => string;
	/** Merge/de-dupe frontmatter (array union, object merge, scalar overwrite). */
	mergeFrontmatter: (file: TFile, updates: Record<string, unknown>) => Promise<void>;
	/** Backlink-preserving move/rename via `app.fileManager.renameFile`. */
	renameFile: (file: TFile, newPath: string) => Promise<void>;
	/** Read frontmatter with a manual-YAML fallback for cold-cache (freshly-created) files. */
	readFrontmatter: (file: TFile) => Promise<Record<string, unknown> | null>;
	/**
	 * Run a Templater template against a target file (merges frontmatter + appends
	 * body). Resolves `false` when Templater is absent — the caller decides how to
	 * surface the skip. Note: Templater swallows template parse errors internally
	 * (shows its own Notice, leaves the file unchanged), so a `true` result does
	 * NOT guarantee the template rendered successfully.
	 */
	runTemplaterTemplate: (templateFile: TFile, targetFile: TFile) => Promise<boolean>;
	/** Templater's API if installed (`tp`), else undefined — the V2 trigger-template escape hatch. */
	tp?: unknown;
}

// ---------------------------------------------------------------------------
// Scaffolds + errors
// ---------------------------------------------------------------------------

/** A built-in action's canonical metadata + full scaffold `.md` content. */
export interface BuiltinRoutingActionScaffold {
	name: string;
	kind: RoutingActionKind;
	description: string;
	/** Complete `.md` file content (frontmatter + optional TS code fence). */
	scaffoldContent: string;
}

/** A built-in option's canonical metadata + full scaffold `.md` content. */
export interface BuiltinRoutingOptionScaffold {
	name: string;
	description: string;
	scaffoldContent: string;
}

/** A non-fatal problem encountered while loading an action or option. */
export interface RoutingError {
	filePath: string;
	message: string;
}
