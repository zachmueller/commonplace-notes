import { scaffold } from './_scaffold-helper';

export const REHYPE_STRINGIFY = scaffold({
	name: 'rehype-stringify',
	stage: 'rehype',
	order: 60,
	description: 'Serialize the HAST (HTML) tree to an HTML string.',
	doc: `Built-in stage: the final stage — turns the HTML tree into the HTML
string that gets published. \`allowDangerousHtml\` passes through the raw HTML
preserved by \`remark-rehype\`. This should remain the last stage (highest order).`,
	code: `// In scope: libs, context, app, utils — NO imports.
return [libs.rehypeStringify, { allowDangerousHtml: true }];`,
});
