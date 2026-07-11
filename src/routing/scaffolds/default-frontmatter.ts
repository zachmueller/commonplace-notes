import { actionScaffold } from './_scaffold-helper';

/**
 * `default-frontmatter` — seed the standard properties on a brand-new note.
 *
 * Reproduces Zach's Templater `defaultFrontmatterAttributes`: a `created-at`
 * timestamp derived from the file's creation time, plus empty `tags`/`aliases`
 * scaffolding. Marked `new-note-only` so re-routing an existing note never
 * clobbers its original `created-at`.
 */
export const DEFAULT_FRONTMATTER = actionScaffold({
	name: 'default-frontmatter',
	kind: 'code',
	description: 'Seed created-at (from the file ctime) plus tags/aliases scaffolding.',
	newNoteOnly: true,
	doc: `Seeds the standard frontmatter for a new note: a \`created-at\` timestamp from the file's creation time, and empty \`tags\`/\`aliases\`. Runs only when routing a new note (skipped in update mode) so it never overwrites an existing \`created-at\`.

Available in scope: \`libs\`, \`context\`, \`app\`, \`utils\`. Edit freely to change the defaults.`,
	code: `await libs.mergeFrontmatter(context.file, {
  'created-at': libs.ctimeOf(context.file),
  tags: null,
  aliases: null,
});`,
});
