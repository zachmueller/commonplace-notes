import { actionScaffold } from './_scaffold-helper';

/**
 * `set-publish-contexts` — set/merge the note's `cpn-publish-contexts`.
 *
 * Parameterized: options supply the contexts via step `params.contexts`. Uses
 * merge semantics (union + de-dupe) so re-routing an existing note adds contexts
 * rather than clobbering them.
 */
export const SET_PUBLISH_CONTEXTS = actionScaffold({
	name: 'set-publish-contexts',
	kind: 'publish-contexts',
	description: 'Add publish contexts to the note (union with any existing).',
	idempotent: true,
	doc: `Sets the \`cpn-publish-contexts\` frontmatter. Supply the contexts per option via a step \`contexts\` param (comma-separated for multiple), e.g.:

\`\`\`
- "[[set-publish-contexts]] contexts: public, local"
\`\`\`

Values are unioned with any existing contexts (de-duplicated), so this is safe to re-run when updating an existing note.`,
});
