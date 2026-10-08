import { scaffold } from './_scaffold-helper';

export const REMARK_BLOCK_IDS = scaffold({
	name: 'remark-block-ids',
	stage: 'remark',
	order: 35,
	description: 'Turn Obsidian ^block-id markers into data-block-id attributes.',
	doc: `Built-in stage: strips Obsidian block-id markers (\`Some text ^intro\`, or a
standalone \`^tbl\` line after a table/list/quote/code block) and records the id as
a \`data-block-id\` attribute on the block. List items carry the id on the \`<li>\`.

Runs on MDAST (order 035) — after \`line-numbers\` (030), whose attributes it
preserves, and before \`remark-obsidian-links\` (040), so \`![[Note]] ^id\` is a
clean embed-only paragraph by the time embeds are detected.

🔗 **Coupling:** the published SPA resolves block links (\`data-heading="^id"\`,
emitted by \`remark-obsidian-links\`) and block embeds (\`data-block="id"\`)
against these \`data-block-id\` attributes. If you customize the attribute name,
block links and embeds stop finding their targets.`,
	code: `// In scope: libs, context, app, utils — NO imports.
return libs.remarkBlockIds;`,
});
