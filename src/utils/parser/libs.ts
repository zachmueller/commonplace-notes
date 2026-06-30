/**
 * The bundled toolkit (`libs`) exposed to user parser code.
 *
 * This is the single approved channel for third-party building blocks — adding
 * a key here is a deliberate plugin-code change (bundle + ship), exactly the
 * trade-off Notor's `buildLibs()` lives with. Vault `.md` code can't `import`
 * (it never passes through esbuild), so everything a stage needs comes from
 * `libs` or the runtime `context`.
 *
 * Modeled on `shared/notor/src/extensions/runtime-context/index.ts`.
 *
 * The optional renderers below add real bundle weight (rehype-katex ~0.9MB,
 * rehype-mathjax ~8MB and a transitive `canvas` native dep — marked external in
 * esbuild.config.mjs). They are included by project decision; jsdom tolerates a
 * missing `canvas` at runtime and MathJax SVG output doesn't need it.
 */

import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { visitParents } from 'unist-util-visit-parents';
import { is } from 'unist-util-is';
import { toString as mdastToString } from 'mdast-util-to-string';
import { toString as hastToString } from 'hast-util-to-string';
import * as githubSlugger from 'github-slugger';

// Canonical pipeline stages. These live in `libs` (not `import`ed inside the
// scaffold code) because scaffold bodies run via AsyncFunction in the vault,
// where `import` is a syntax error and no module resolver exists. They're
// already bundled (notes.ts imports them), so exposing them costs nothing.
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';

// Optional plugins, included by project decision. The light ones are imported
// eagerly; the heavy renderers are exposed as LAZY THUNKS (see below) so their
// substantial module-eval cost — and, for mathjax, jsdom's load-time
// `require.resolve('./xhr-sync-worker.js')` — only runs if a stage actually
// uses them. Mirrors Notor's `unpdf: () => import('unpdf')` pattern.
import rehypeRaw from 'rehype-raw';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import remarkMath from 'remark-math';

import remarkObsidianLinks from '../remarkObsidianLinks';
import remarkLineNumbers from '../remarkLineNumbers';
import remarkCallouts from '../remarkCallouts';
import type { ParserLibs, Plugin } from './types';

/**
 * `defineTransform` — wrap a bare `(tree, file) => void` visitor into a proper
 * unified plugin. The ergonomic path for the common "just walk the tree" case,
 * so users don't write the `() => (tree) => {}` attacher boilerplate.
 */
const defineTransform: ParserLibs['defineTransform'] = (fn) =>
	function () {
		return (tree: any, file: any) => {
			fn(tree, file);
		};
	} as Plugin;

let cached: ParserLibs | null = null;

/** Build (and memoize) the `libs` toolkit. Pure — safe to cache process-wide. */
export function buildParserLibs(): ParserLibs {
	if (cached) return cached;
	cached = {
		unified,
		visit,
		visitParents,
		is,
		mdastToString,
		hastToString,
		githubSlugger,
		// canonical stages (so scaffolds/overrides can return them)
		remarkParse,
		remarkGfm,
		remarkRehype,
		rehypeSlug,
		rehypeStringify,
		// CPN-internal factories
		remarkObsidianLinks,
		remarkLineNumbers,
		remarkCallouts,
		// optional plugins — light ones eager
		rehypeRaw,
		rehypeAutolinkHeadings,
		remarkMath,
		// heavy math renderers — lazy thunks: `const k = await libs.rehypeKatex();`
		rehypeKatex: () => import('rehype-katex').then((m) => m.default ?? m),
		rehypeMathjax: () => import('rehype-mathjax').then((m) => m.default ?? m),
		defineTransform,
	};
	return cached;
}
