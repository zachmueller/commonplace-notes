/**
 * Render-time rewrite of `[[UID]]` note-links inside comment bodies for the
 * author-facing Recent Comments panel.
 *
 * Comment bodies persist note-links as the note's UID (`[[JVZ6KPM29N]]`) so the
 * link survives renames. When rendered through Obsidian's Markdown renderer a
 * bare `[[UID]]` would display the UID and resolve to a note literally named
 * after the UID (which doesn't exist). This util rewrites each resolvable
 * `[[UID]]` into `[[<linktext>|<Title>]]` — the linktext (a path-derived,
 * unambiguous reference) makes Obsidian open the correct note, while the alias
 * shows the note's current title. Unresolvable UIDs degrade to plain text (the
 * raw UID) rather than a dead internal link.
 *
 * Pure/dependency-free (no `obsidian` import) so it is unit-testable in isolation;
 * the vault lookup is injected via the resolver callback.
 */

export interface ResolvedCommentLink {
	/** An Obsidian linktext that resolves to the target note (e.g. a vault path). */
	linktext: string;
	/** The note's current display title, used as the link alias. */
	title: string;
}

/** Resolve a note UID to its link target + title, or null when not found locally. */
export type CommentLinkResolver = (uid: string) => ResolvedCommentLink | null;

/**
 * Matches a bare `[[UID]]` token where UID is Crockford Base32 (digits + A–Z
 * minus I/L/O/U). Mirrors the published-site renderer's rule: only bare-UID
 * tokens are transformed, so ordinary wikilinks (`[[Some Note]]`,
 * `[[folder/Note#H|x]]`) and non-UID text are left untouched. `uidLength` is
 * author-configurable (default 8); the `{6,}` floor tolerates shorter configs
 * while limiting false positives on ordinary all-caps text.
 */
const UID_WIKILINK = /\[\[([0-9A-HJKMNP-TV-Z]{6,})\]\]/g;

/**
 * Rewrite bare `[[UID]]` tokens in a comment body:
 *   - resolvable UID → `[[<linktext>|<sanitized title>]]`
 *   - unresolvable UID → the plain UID text (never a dead internal link)
 *
 * The alias is sanitized because `[`, `]`, and `|` would break the wikilink
 * syntax; if the title is empty after sanitizing, the UID is used as the alias.
 */
export function rewriteCommentWikilinks(md: string, resolve: CommentLinkResolver): string {
	return md.replace(UID_WIKILINK, (_whole, uid) => {
		const resolved = resolve(uid);
		if (!resolved) return uid; // not local → plain text
		const alias = resolved.title.replace(/[\[\]|]/g, ' ').replace(/\s+/g, ' ').trim() || uid;
		return `[[${resolved.linktext}|${alias}]]`;
	});
}
