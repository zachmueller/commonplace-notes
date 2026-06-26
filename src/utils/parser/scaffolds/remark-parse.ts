import { scaffold } from './_scaffold-helper';

export const REMARK_PARSE = scaffold({
	name: 'remark-parse',
	stage: 'remark',
	order: 10,
	description: 'Parse Markdown into an MDAST syntax tree.',
	doc: `Built-in stage: the Markdown frontend.

⚠️ **Power/risk:** this stage installs the Markdown parser (\`this.Parser\`).
It MUST remain order 010 and stage \`remark\` — every later remark stage operates
on the tree it produces. Overriding it replaces the **entire** Markdown→MDAST
parser; only do so if you are providing a complete, compatible parser. Returning
a different plugin here can break the whole pipeline.`,
	code: `// In scope: libs, context, app, utils — NO imports.
// remark-parse installs this.Parser; returning it bare keeps full
// unified().use() parity so a power-user override could swap the parser.
return libs.remarkParse;`,
});
