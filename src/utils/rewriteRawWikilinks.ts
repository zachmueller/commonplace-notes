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
 * like the renderer), and match wikilinks in each node's `value` — the same
 * text the renderer matches. Each match is then mapped from value positions to
 * source offsets ({@link buildSourceMap}), because `value` drops escapes,
 * decodes entities and leaves out line prefixes, so it isn't a byte-for-byte
 * copy of the source. Only the note-path span (and, where needed, a new
 * display alias) is spliced into the ORIGINAL string, highest offset first.
 * The heading and alias stay exactly as written, escapes included. Splicing —
 * rather than re-stringifying the mdast — preserves the author's Markdown
 * byte-for-byte (there is no remark-stringify dependency, and a round-trip
 * would reflow lists/emphasis/tables).
 *
 * Inside a GFM table cell an unescaped `|` ends the cell, so the display
 * separator the scrubber adds there is written `\|`.
 */

import { unified } from 'unified';
import type { Plugin } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visitParents } from 'unist-util-visit-parents';
import type { Text } from 'mdast';
import type { Node } from 'unist';
import { parseWikilinkInner } from './wikilinkParse';
import { buildSourceMap } from './markdownSourceMap';

/**
 * Resolve a wikilink's note path to the target note's UID, or `null` when the
 * target has no resolvable UID (missing, non-markdown, or not publishable). A
 * `null` result is rendered as the literal sentinel `null`, which cannot
 * collide with an all-uppercase Crockford Base32 UID.
 */
export type ResolveUid = (notePath: string) => string | null;

interface Edit {
	start: number;
	end: number;
	replacement: string;
}

/**
 * Rewrite every `[[wikilink]]` in `raw` to UID form, leaving everything else
 * byte-for-byte identical. Same-note section links (`[[#Heading]]`) and links
 * with no note path are left untouched.
 */
export function scrubRawWikilinks(raw: string, resolveUid: ResolveUid): string {
	// Fast path. A wikilink's brackets can also be written as escapes
	// (`\[`) or character references (`&#91;`), which the renderer still turns
	// into links, so only skip when neither `[` nor `&` appears.
	if (!raw.includes('[') && !raw.includes('&')) return raw;

	// Match the publish pipeline's text-node segmentation (remark-parse +
	// remark-gfm run before remark-obsidian-links). Positions are on by default.
	const tree = unified().use(remarkParse).use(remarkGfm as Plugin).parse(raw);
	const sourceMap = buildSourceMap(raw);
	const edits: Edit[] = [];

	visitParents(tree, 'text', (node: Text, ancestors: Node[]) => {
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		if (start == null || end == null) return;
		const value: string = node.value;
		if (!value.includes('[[')) return;

		const map = sourceMap.mapTextNode(start, end, value);
		// The tokens didn't rebuild this value; leave the node as written
		// rather than splice at a guessed offset.
		if (!map) return;

		const inTable = ancestors.some(a => a.type === 'tableCell');
		const separator = inTable ? '\\|' : '|';

		for (const match of value.matchAll(/\[\[(.*?)\]\]/g)) {
			const [, linkText] = match;
			const { notePath, alias, isSameNote } = parseWikilinkInner(linkText);

			// Same-note section links (`[[#Heading]]`) and any malformed link with
			// no note path are left exactly as written.
			if (isSameNote || notePath === '') continue;

			// Value positions: the path starts right after `[[`; the link side
			// (path + `#heading`) ends at the first `|`, else at `]]`.
			const pathStart = (match.index ?? 0) + 2;
			const pathEnd = pathStart + notePath.length;
			const pipeIdx = linkText.indexOf('|');
			const linkSideEnd = pathStart + (pipeIdx === -1 ? linkText.length : pipeIdx);

			const srcPathStart = map.startOf(pathStart);
			const srcPathEnd = map.endOf(pathEnd - 1);
			const srcLinkSideEnd = map.endOf(linkSideEnd - 1);

			const linkTarget = resolveUid(notePath) ?? 'null';

			// With no inline alias, the original note path becomes the visible
			// alias (NOT the renderer's `alias || heading || notePath` — we keep
			// the path-as-title so the published title still reads well). It is
			// taken from the source, so any escapes in it survive.
			// An empty alias (`[[Note|]]`) is replaced along with its pipe.
			const display = alias === '' ? separator + raw.slice(srcPathStart, srcPathEnd) : '';
			const replaceEnd = alias === '' ? map.endOf(pathStart + linkText.length - 1) : srcLinkSideEnd;

			// Replace the path, keep `#heading` as written, then add the alias.
			edits.push({
				start: srcPathStart,
				end: replaceEnd,
				replacement: linkTarget + raw.slice(srcPathEnd, srcLinkSideEnd) + display
			});
		}
	});

	return applyEdits(raw, edits);
}

/** Apply non-overlapping edits highest-offset-first so earlier offsets stay valid. */
function applyEdits(raw: string, edits: Edit[]): string {
	if (edits.length === 0) return raw;
	edits.sort((a, b) => b.start - a.start);
	let out = raw;
	for (const edit of edits) {
		out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
	}
	return out;
}
