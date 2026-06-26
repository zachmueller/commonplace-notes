import { scaffold } from './_scaffold-helper';

export const REMARK_GFM = scaffold({
	name: 'remark-gfm',
	stage: 'remark',
	order: 20,
	description: 'GitHub Flavored Markdown: tables, strikethrough, task lists, autolinks.',
	doc: `Built-in stage: adds GFM support (tables, ~~strikethrough~~, task lists,
literal autolinks). To disable GFM, replace the body with a no-op plugin:
\`return function () {};\``,
	code: `// In scope: libs, context, app, utils — NO imports.
return libs.remarkGfm;`,
});
