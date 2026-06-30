import { scaffold } from './_scaffold-helper';

export const REMARK_CALLOUTS = scaffold({
	name: 'remark-callouts',
	stage: 'remark',
	order: 45,
	description: 'Render Obsidian [!type] callout blockquotes as styled callout boxes.',
	doc: `Built-in stage: transforms blockquotes whose first line is \`[!type] Title\`
into the callout markup the published site CSS targets — a container carrying
\`data-callout-type="<canonical>"\` with a leading \`data-callout-title\` child.
Foldable callouts (\`[!type]-\` collapsed, \`[!type]+\` expanded) render as native
\`<details>\`/\`<summary>\`, so folding needs zero JavaScript on the published site.
Blockquotes without the marker are left untouched.

Runs on MDAST (order 045) — after \`remark-obsidian-links\` (040) so wikilinks
inside callout bodies are already resolved, and before \`remark-rehype\` (050).

🔗 **Coupling:** the emitted \`data-callout-type\` values MUST match the
\`[data-callout-type="…"]\` CSS in the published site (source of truth:
\`infrastructure/assets/index/index.html\`, regenerated into
\`src/publish/siteAssets.ts\` via \`npm run synth:site\`). Keep the type list and
aliases in this stage in sync with that CSS.`,
	code: `// In scope: libs, context, app, utils — NO imports.
return libs.remarkCallouts;`,
});
