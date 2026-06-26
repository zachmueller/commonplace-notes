import { scaffold } from './_scaffold-helper';

export const REMARK_REHYPE = scaffold({
	name: 'remark-rehype',
	stage: 'rehype',
	order: 50,
	description: 'Convert the MDAST (Markdown) tree into a HAST (HTML) tree.',
	doc: `Built-in stage: the MDAST→HAST bridge. Every stage before this operates
on the Markdown tree; every stage after operates on the HTML tree. \`stage\` is
\`rehype\` and the order (050) marks the boundary — keep remark stages below it
and rehype stages above it.

\`allowDangerousHtml\` lets raw HTML (e.g. the \`<span class="unpublished-link">\`
emitted by remark-obsidian-links, and any raw HTML in notes) pass through into
the HTML tree; it is paired with the same option on \`rehype-stringify\`.`,
	code: `// In scope: libs, context, app, utils — NO imports.
return [libs.remarkRehype, { allowDangerousHtml: true }];`,
});
