import { actionScaffold } from './_scaffold-helper';

/**
 * `insert-template` — run a Templater template against the routed note.
 *
 * The template is parsed against the note as an explicit target: its frontmatter
 * is merged in and its rendered body is appended. Position in an option's
 * `cpn-routing-steps` decides the behavior — as the only step it "redirects" (the
 * template owns everything); after other steps it "appends".
 */
export const INSERT_TEMPLATE = actionScaffold({
	name: 'insert-template',
	kind: 'insert-template',
	description: 'Run a Templater template against the note (merge frontmatter, append body).',
	newNoteOnly: true,
	template: '[[My Template]]',
	doc: `Runs a Templater template against the routed note via Templater's \`write_template_to_file\` — the template's frontmatter is merged in and its rendered body is appended. Point \`cpn-routing-template\` at a template file (a path or \`[[wikilink]]\`); an option may also override it per step with \`params.template\`.

**Placement decides behavior.** As an option's *only* step it "redirects": the template owns naming, frontmatter, folder, and body — nothing else runs. Placed *after* other steps (\`move\`, \`set-publish-contexts\`, …) it "appends" onto whatever those produced. Several \`insert-template\` steps in one option are allowed and run in order.

**If the template fails to parse,** Templater shows its own error Notice and leaves the note unchanged. Because Templater swallows that error, it does NOT abort the option or trip \`cpn-routing-on-error\`. (A missing/unresolvable template file is different — that DOES abort under \`cpn-routing-on-error: abort\`.)

**Frontmatter merge.** List-valued keys (e.g. \`cpn-publish-contexts\`) are unioned + de-duped, so values set by earlier steps survive. Scalar keys the template also sets will be overwritten by the template — order the step accordingly.

**Titles.** If the template renames the note itself, pair the option with \`cpn-routing-title-prompt: off\` so CPN's title prompt doesn't fight it.

**Update mode.** Defaults to \`cpn-routing-new-note-only: true\`, so re-routing an existing note skips this step (no duplicate body). Set \`cpn-routing-new-note-only: false\` to also run when updating.

**Requires Templater.** If Templater isn't installed/enabled, this step is skipped with a Notice (it does not abort the option).`,
});
