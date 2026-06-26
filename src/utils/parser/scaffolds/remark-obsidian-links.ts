import { scaffold } from './_scaffold-helper';

export const REMARK_OBSIDIAN_LINKS = scaffold({
	name: 'remark-obsidian-links',
	stage: 'remark',
	order: 40,
	description: 'Resolve [[wikilinks]] to published-note URLs (or unpublished spans).',
	doc: `Built-in stage: rewrites \`[[wikilinks]]\` into links to published notes,
or into \`<span class="unpublished-link">\` for unresolved/unpublished targets.
All inputs come from \`context\` (the per-note runtime context), so this stage is
rebuilt for every note. Returns \`[plugin, options]\` for full \`use()\` parity.

🔗 **Coupling:** heading slugs emitted here as \`data-heading\` use
\`github-slugger\` and MUST match the heading \`id\`s assigned by the
\`rehype-slug\` stage (order 055) — that's how the published SPA scrolls to a
section. If you customize either stage's slugging, keep both in sync.`,
	code: `// In scope: libs, context, app, utils — NO imports.
// Options are read from context so the stage stays pure/per-note.
return [libs.remarkObsidianLinks, {
  frontmatterManager: context.frontmatterManager,
  urlScheme: context.urlScheme,
  resolveInternalLinks: context.resolveInternalLinks,
}];`,
});
