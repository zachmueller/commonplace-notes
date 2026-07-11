import { actionScaffold } from './_scaffold-helper';

/**
 * `move` — relocate the note into a target directory, preserving backlinks.
 *
 * Parameterized: options supply the destination via step `params.dir` (falling
 * back to `cpn-target-dir` if set here). The move uses `app.fileManager.renameFile`
 * so inbound wikilinks update automatically.
 */
export const MOVE = actionScaffold({
	name: 'move',
	kind: 'move',
	description: 'Move the note into a target directory (backlinks update automatically).',
	doc: `Moves the active note into a directory. Supply the destination per option via a step \`params.dir\`, e.g.:

\`\`\`
- { action: "[[move]]", params: { dir: "log" } }
\`\`\`

Uses Obsidian's link-preserving rename. In update mode, moving to a directory the note is already in is a no-op; a conflicting file at the target is skipped (never overwritten).`,
});
