/**
 * Type definitions for the user-extensible Markdown→HTML parser.
 *
 * Users author parser stages as `.md` files in their vault. Each stage's code
 * fence runs with a CPN-supplied `libs` toolkit and a runtime `context` in
 * scope (no `import` statements — vault `.md` never passes through esbuild, so
 * it has no module resolver). This mirrors Notor's extension model; see
 * `shared/notor/src/extensions/`.
 */

import type { App, TFile } from 'obsidian';
import type { Plugin, Processor } from 'unified';
import type { FrontmatterManager } from '../frontmatter';
import type { ResolvedNoteInfo } from '../remarkObsidianLinks';
import type { UrlScheme } from '../urlScheme';

/** Which AST a stage operates on. Metadata/validation only — pipeline order is
 *  driven purely by {@link ParserExtensionDefinition.order}. */
export type ParserStage = 'remark' | 'rehype';

/**
 * Per-note runtime context handed to every stage. Carries the inputs the
 * built-in stages need (today only `remark-obsidian-links`), so user overrides
 * can consume them without importing anything. Rebuilt per note because
 * `file`/`profileId` change.
 */
export interface ParserContext {
	file: TFile;
	profileId: string;
	frontmatterManager: FrontmatterManager;
	resolveInternalLinks: (notePath: string) => Promise<ResolvedNoteInfo | null>;
	urlScheme: UrlScheme;
	/**
	 * Resolved `cpn-style` for this note (`null` if unset) — the same value that
	 * becomes the panel's `cpn-style-<name>` class on the published site. A custom
	 * stage can branch on it (e.g. to emit custom classes styled by that named
	 * style's Custom CSS). Convenience mirror of
	 * `frontmatterManager.getNoteStyle(file)`.
	 */
	noteStyle: string | null;
}

/** Small read-only helper bag injected as the `utils` argument. */
export interface ParserUtils {
	/** Scoped logger — `utils.logger.debug(...)`, `.error(...)`, etc. */
	logger: typeof import('../logging').Logger;
	/** GitHub-style slugger (same instance the built-ins use). */
	slug: (value: string) => string;
}

/**
 * A stage's compiled code fence. Receives the toolkit + context and returns a
 * unified plugin (or `[plugin, options]`). Always async — `new AsyncFunction`
 * returns a Promise even when the body has no `await`, so callers must await.
 */
export type CompiledParserFn = (
	libs: ParserLibs,
	context: ParserContext,
	app: App,
	utils: ParserUtils,
) => Promise<Plugin | [Plugin, unknown] | unknown>;

/** Where a discovered stage came from. `'profile'` is reserved for v2. */
export type ParserSource = 'built-in' | 'global' | 'profile';

/** A discovered or scaffolded parser stage, post-parse and (maybe) post-compile. */
export interface ParserExtensionDefinition {
	/** `cpn-parser-name` — unique key for override matching. */
	name: string;
	/** `cpn-parser-stage`. */
	stage: ParserStage;
	/** `cpn-parser-order` — lower runs first. */
	order: number;
	/** `cpn-description`, if any. */
	description?: string;
	/** Vault-relative file path, or a synthetic `(built-in scaffold: name)` tag. */
	filePath: string;
	/** Filename component — tiebreaker for equal `order`. */
	filename: string;
	source: ParserSource;
	/** True when injected from a built-in scaffold rather than a real vault file. */
	isScaffold: boolean;
	/** Raw TS/JS from the code fence. */
	rawCode: string;
	/** Populated by the compile step; null until then. */
	compiledFn: CompiledParserFn | null;
}

/** A built-in stage's canonical metadata + full scaffold `.md` content. */
export interface BuiltinParserScaffold {
	name: string;
	stage: ParserStage;
	order: number;
	description: string;
	/** Complete `.md` file content (frontmatter + one TS code fence). */
	scaffoldContent: string;
}

/** A non-fatal problem encountered while loading a stage. */
export interface ParserExtensionError {
	filePath: string;
	message: string;
}

/**
 * The bundled toolkit exposed to user code as `libs`. The single approved
 * channel for third-party building blocks — adding a new key is a plugin-code
 * change, by design. Loosely typed (`any` plugin factories) because the values
 * are pre-bundled modules whose exact unified typings vary by major version.
 */
export interface ParserLibs {
	// unified core
	unified: typeof import('unified').unified;
	// unist/mdast/hast traversal + text helpers
	visit: typeof import('unist-util-visit').visit;
	visitParents: typeof import('unist-util-visit-parents').visitParents;
	is: typeof import('unist-util-is').is;
	mdastToString: typeof import('mdast-util-to-string').toString;
	hastToString: typeof import('hast-util-to-string').toString;
	githubSlugger: typeof import('github-slugger');
	// canonical pipeline stages (exposed so scaffolds/overrides can return them;
	// scaffold code can't `import`). Loosely typed — unified plugin shapes vary.
	remarkParse: unknown;
	remarkGfm: unknown;
	remarkRehype: unknown;
	rehypeSlug: unknown;
	rehypeStringify: unknown;
	// CPN-internal factories (so overrides can delegate to the originals)
	remarkObsidianLinks: typeof import('../remarkObsidianLinks').default;
	remarkLineNumbers: typeof import('../remarkLineNumbers').default;
	remarkCallouts: typeof import('../remarkCallouts').default;
	// optional plugins — light ones eager
	rehypeRaw: unknown;
	rehypeAutolinkHeadings: unknown;
	remarkMath: unknown;
	// heavy math renderers — lazy thunks (`await libs.rehypeKatex()`) so their
	// module-eval cost (and jsdom's load-time require for mathjax) is deferred.
	rehypeKatex: () => Promise<unknown>;
	rehypeMathjax: () => Promise<unknown>;
	/** Wrap a raw `(tree, file) => void` transformer into a unified plugin. */
	defineTransform: (fn: (tree: any, file: any) => void) => Plugin;
}

/** Re-export for convenience at call sites. */
export type { Plugin, Processor };
