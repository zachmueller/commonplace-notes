import { actionScaffold } from './_scaffold-helper';

/**
 * `ensure-uid` — give the routed note a stable CPN UID (`cpn-uid`) if it lacks one.
 *
 * The UID backs the note's published URL, so it must be stable: this action
 * never overwrites an existing id. It's safe to re-run and runs in both create
 * and update mode. Zero-config — no kind-specific frontmatter or step params.
 */
export const ENSURE_UID = actionScaffold({
	name: 'ensure-uid',
	kind: 'ensure-uid',
	description: 'Assign the note a stable CPN UID (cpn-uid) if it does not already have one.',
	newNoteOnly: false,
	idempotent: true,
	doc: `Ensures the routed note has a \`cpn-uid\` — the stable identifier that backs its published URL. If the note already has one, it's left untouched; otherwise a new id is generated at the vault's configured UID length and written to frontmatter **immediately** (so it's durably on disk before any later step runs).

**Unconditional.** The id is minted whenever this step runs, regardless of publish contexts — you added the step deliberately. Place it *before* \`set-publish-contexts\` if you want to guarantee the id exists by the time the note is opted into publishing.

**Stable + safe to re-run.** It never overwrites an existing \`cpn-uid\`, so re-routing an existing note (update mode) is a no-op when one is already present. Zero-config: there's nothing to set in frontmatter or per-step params.`,
});
