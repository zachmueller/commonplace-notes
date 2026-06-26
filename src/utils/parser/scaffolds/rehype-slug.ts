import { scaffold } from './_scaffold-helper';

export const REHYPE_SLUG = scaffold({
	name: 'rehype-slug',
	stage: 'rehype',
	order: 55,
	description: 'Assign GitHub-style slug ids to every heading.',
	doc: `Built-in stage: gives every heading an \`id\` (GitHub-style slug, with
\`-1\`/\`-2\` dedupe for repeated text), so published section anchors have scroll
targets.

🔗 **Coupling:** these ids MUST match the \`data-heading\` slugs emitted by the
\`remark-obsidian-links\` stage (order 040) — both use \`github-slugger\`. If you
replace this stage, keep producing \`github-slugger\`-compatible ids or section
links from wikilinks will stop scrolling.`,
	code: `// In scope: libs, context, app, utils — NO imports.
return libs.rehypeSlug;`,
});
