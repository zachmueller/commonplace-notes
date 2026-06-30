/**
 * Shared parsing for the inner text of an Obsidian wikilink (`[[...]]`).
 *
 * Both the HTML renderer ({@link ./remarkObsidianLinks}) and the published-raw
 * scrubber ({@link ./notes}.NoteManager.rewriteRawWikilinks) need to break a
 * wikilink's inner text into its note path, heading, and alias. Keeping that
 * single interpretation here ensures the two never drift: whatever the renderer
 * turns into a link, the scrubber rewrites the same way (and vice versa).
 *
 * The regex that *finds* wikilinks in a text node — `/\[\[(.*?)\]\]/g` — lives
 * at each call site; this helper only parses the already-captured inner text
 * (the part between `[[` and `]]`).
 */

export interface ParsedWikilink {
	/** Note path before any `#`/`|`. Empty string for same-note links (`[[#Heading]]`). */
	notePath: string;
	/** Heading after the first `#` (on the link side, before `|`). Empty if none. */
	heading: string;
	/** Inline alias after the first `|`. Empty if none. */
	alias: string;
	/** True for same-note section links like `[[#Heading]]` (no note path, has a heading). */
	isSameNote: boolean;
}

/**
 * Parse the inner text of a wikilink (between `[[` and `]]`).
 *
 * Splits on the FIRST `|` (alias) and the FIRST `#` (heading), so a `|` inside
 * the alias or a `#` inside the heading is preserved verbatim:
 *
 * - `Note`               → { notePath: 'Note', heading: '', alias: '' }
 * - `Note|the note`      → { notePath: 'Note', heading: '', alias: 'the note' }
 * - `Note#Section`       → { notePath: 'Note', heading: 'Section', alias: '' }
 * - `Note#Sec|a|b`       → { notePath: 'Note', heading: 'Sec', alias: 'a|b' }
 * - `Note|a#b`           → { notePath: 'Note', heading: '', alias: 'a#b' }
 * - `#Heading`           → { notePath: '', heading: 'Heading', alias: '', isSameNote: true }
 */
export function parseWikilinkInner(linkText: string): ParsedWikilink {
	// Split on the first '|' → [link, alias]. The '#' is parsed from the link
	// side only, so a '#' appearing inside the alias is left untouched.
	const pipeIdx = linkText.indexOf('|');
	const link = pipeIdx === -1 ? linkText : linkText.slice(0, pipeIdx);
	const alias = pipeIdx === -1 ? '' : linkText.slice(pipeIdx + 1);

	const hashIdx = link.indexOf('#');
	const notePath = hashIdx === -1 ? link : link.slice(0, hashIdx);
	const heading = hashIdx === -1 ? '' : link.slice(hashIdx + 1);

	return {
		notePath,
		heading,
		alias,
		isSameNote: notePath === '' && heading !== ''
	};
}
