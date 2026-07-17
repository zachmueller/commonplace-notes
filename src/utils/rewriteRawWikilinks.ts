/**
 * Pure core of the published-raw wikilink scrubber.
 *
 * Rewrites `[[wikilinks]]` in raw Markdown so the human-readable note path is
 * replaced by the target note's UID, with the title carried as an Obsidian
 * inline alias — e.g. `[[Some Title]]` → `[[ABCD1234|Some Title]]`. UID lookup
 * is injected as a callback (`resolveUid`) so this module stays free of any
 * Obsidian runtime dependency and is unit-testable on its own; the
 * Obsidian-backed wrapper lives on NoteManager.rewriteRawWikilinks.
 *
 * Approach: parse with the same remark stages the publish pipeline uses, walk
 * only `text` nodes (so wikilinks inside fenced/inline code are skipped, just
 * like the renderer), compute each rewrite, then splice the replacements back
 * into the ORIGINAL string by source offset (descending, so earlier offsets
 * stay valid). Splicing — rather than re-stringifying the mdast — preserves the
 * author's Markdown byte-for-byte (there is no remark-stringify dependency, and
 * a round-trip would reflow lists/emphasis/tables).
 */

import { unified } from 'unified';
import type { Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';
import type { Text } from 'mdast';
import { parseWikilinkInner } from './wikilinkParse';

/**
 * Resolve a wikilink's note path to the target note's UID, or `null` when the
 * target has no resolvable UID (missing, non-markdown, or not publishable). A
 * `null` result is rendered as the literal sentinel `null`, which cannot
 * collide with an all-uppercase Crockford Base32 UID.
 */
export type ResolveUid = (notePath: string) => string | null;

/**
 * Rewrite every `[[wikilink]]` in `raw` to UID form, leaving everything else
 * byte-for-byte identical. Same-note section links (`[[#Heading]]`) and links
 * with no note path are left untouched.
 */
export function scrubRawWikilinks(raw: string, resolveUid: ResolveUid): string {
	// Fast path — nothing to do if there are no wikilinks at all.
	if (!raw.includes('[[')) return raw;

	// Match the publish pipeline's text-node segmentation (remark-parse +
	// remark-gfm run before remark-obsidian-links). Positions are on by default,
	// giving each text node a source offset to splice against.
	const tree = unified().use(remarkParse).use(remarkGfm as Plugin).parse(raw);

	interface Edit {
		start: number;
		end: number;
		replacement: string;
	}
	const edits: Edit[] = [];

	visit(tree, 'text', (node: Text) => {
		if (!node.position || node.position.start.offset == null) return;
		const base: number = node.position.start.offset;
		const value: string = node.value;

		for (const match of value.matchAll(/\[\[(.*?)\]\]/g)) {
			const [fullMatch, linkText] = match;
			const { notePath, heading, alias, isSameNote } = parseWikilinkInner(linkText);

			// Same-note section links (`[[#Heading]]`) and any malformed link with
			// no note path are left exactly as written.
			if (isSameNote || notePath === '') continue;

			const linkTarget = resolveUid(notePath) ?? 'null';

			// Keep the heading on the link side; the visible alias is the author's
			// inline alias, else the original note path (NOT the renderer's
			// `alias || heading || notePath` — we deliberately keep the path-as-title
			// here so the published title still reads well).
			const linkSide = heading ? `${linkTarget}#${heading}` : linkTarget;
			const display = alias !== '' ? alias : notePath;
			const replacement = `[[${linkSide}|${display}]]`;

			const start = base + (match.index ?? 0);
			edits.push({ start, end: start + fullMatch.length, replacement });
		}
	});

	if (edits.length === 0) return raw;

	// Apply highest-offset-first so each splice leaves earlier offsets valid
	// (same invariant as the renderer's descending-index splice).
	edits.sort((a, b) => b.start - a.start);
	let out = raw;
	for (const edit of edits) {
		out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
	}
	return out;
}
