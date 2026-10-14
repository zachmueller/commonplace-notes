import { scaffold } from './_scaffold-helper';

export const REMARK_HIGHLIGHTS = scaffold({
	name: 'remark-highlights',
	stage: 'remark',
	order: 47,
	description: 'Render Obsidian ==highlights== (and colored ==🔴highlights==) as <mark>.',
	doc: `Built-in stage: wraps \`==text==\` in \`<mark>\`. A leading color emoji (🔴 🟠 🟡
🟢 🔵 🟣, Obsidian's colored highlights) is stripped and recorded as
\`data-highlight="red"\` (etc.). A highlight can wrap links, bold and other inline
markup. Like Obsidian, \`a == b\` stays literal: the opening \`==\` must be followed
by a non-space and the closing one preceded by one. Inline code is left alone.

Runs on MDAST (order 047) — after \`remark-obsidian-links\` (040) so wikilinks
inside highlights are already links, after \`remark-callouts\` (045) so callout
bodies are settled, and before \`remark-rehype\` (050). Heading ids from
\`rehype-slug\` (055) use the text with the emoji already stripped.

🔗 **Coupling:** the emitted \`data-highlight\` values MUST match the
\`mark[data-highlight="…"]\` CSS in the published site (source of truth:
\`infrastructure/assets/index/index.html\`, regenerated into
\`src/publish/siteAssets.ts\` via \`npm run synth:site\`). Keep the emoji→color
palette in this stage in sync with that CSS.`,
	code: `// In scope: libs, context, app, utils — NO imports.
return libs.remarkHighlights;`,
});
