import { actionScaffold } from './_scaffold-helper';

/**
 * `code-example` — a documented starting point for authoring custom `code`
 * actions. Demonstrates the injected `(libs, context, app, utils)` signature,
 * the `libs` helpers, and the Templater escape hatch (`libs.tp`).
 */
export const CODE_EXAMPLE = actionScaffold({
	name: 'code-example',
	kind: 'code',
	description: 'Template for a custom code action — copy and edit.',
	doc: `A starting point for your own \`code\` action. The body runs with these in scope:

- \`libs\` — \`now(fmt?)\`, \`ctimeOf(file, fmt?)\`, \`mergeFrontmatter(file, updates)\`, \`renameFile(file, path)\`, \`readFrontmatter(file)\`, and \`tp\` (Templater's API if installed).
- \`context\` — \`{ file, mode, option, step, params, frontmatterManager, app }\`.
- \`app\` — the Obsidian \`App\`.
- \`utils\` — \`{ logger }\`.

The return value is ignored; the action runs for its side effects. Reference it from an option as \`- "[[code-example]]"\`.`,
	code: `// Example: stamp a routed-at timestamp, and branch on create vs update.
utils.logger.debug('code-example running', { mode: context.mode, file: context.file.path });

await libs.mergeFrontmatter(context.file, {
  'routed-at': libs.now(),
});

// Templater escape hatch (undefined if Templater isn't installed):
// if (libs.tp) { /* await libs.tp.file.include('[[some-template]]'); */ }`,
});
