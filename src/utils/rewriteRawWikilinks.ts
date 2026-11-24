/**
 * Pure core of the published-raw link scrubber.
 *
 * Two independent rewrites, one per profile setting:
 *
 * - **Obscure wikilinks** (`notes`): a wikilink's note path is replaced by the
 *   target note's UID, with the title carried as an Obsidian inline alias —
 *   e.g. `[[Some Title]]` → `[[ABCD1234|Some Title]]`.
 * - **Obscure attachment names** (`attachments`): a wikilink or inline Markdown
 *   link/image to a non-Markdown vault file gets the file's content hash as
 *   its target, or `null` when it doesn't publish, keeping the extension —
 *   e.g. `![[Media/song.mp3]]` → `![[null.mp3]]`. This hides folder paths.
 *
 * Link resolution is injected as a callback (`resolveTarget`) so this module
 * stays free of any Obsidian runtime dependency and is unit-testable on its
 * own; the Obsidian-backed wrapper lives on NoteManager.rewriteRawWikilinks.
 *
 * Approach: parse with the same remark stages the publish pipeline uses, walk
 * `text` nodes (so wikilinks inside fenced/inline code are skipped, just like
 * the renderer) and, for attachments, `image`/`link` nodes, and match wikilinks in each node's `value` — the same
 * text the renderer matches. Each match is then mapped from value positions to
 * source offsets ({@link buildSourceMap}), because `value` drops escapes,
 * decodes entities and leaves out line prefixes, so it isn't a byte-for-byte
 * copy of the source. Only the note-path span (and, where needed, a new
 * display alias) is spliced into the ORIGINAL string, highest offset first.
 * The heading and alias stay exactly as written, escapes included. A Markdown
 * link or image has only its destination spliced, by the destination's own
 * source span. Splicing —
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
import type { Image, Link, Text } from 'mdast';
import type { Node } from 'unist';
import { parseWikilinkInner } from './wikilinkParse';
import { buildSourceMap } from './markdownSourceMap';

/**
 * What a link path points at:
 *
 * - `note`: a Markdown note, with its UID, or `null` when it has none or isn't
 *   publishable. `null` is written as the literal sentinel `null`, which can't
 *   collide with an all-uppercase Crockford Base32 UID.
 * - `file`: a non-Markdown vault file, with its content hash when it publishes
 *   as an attachment (phase 2), else `null`, and its extension (`''` if none).
 * - `null`: unresolved. The link is left exactly as written.
 */
export type ResolvedTarget =
	| { kind: 'note'; uid: string | null }
	| { kind: 'file'; sha256: string | null; ext: string }
	| null;

export type ResolveTarget = (path: string) => ResolvedTarget;

/** Which link kinds to rewrite: `obscureRawWikilinks` and `obscureRawAttachments`. */
export interface ScrubOptions {
	notes: boolean;
	attachments: boolean;
}

/** `<sha256>.<ext>`, `null.<ext>`, or without the dot when there's no extension. */
export function fileTargetName(sha256: string | null, ext: string): string {
	const id = sha256 ?? 'null';
	return ext ? `${id}.${ext}` : id;
}

/** A Markdown link/image URL that may point into the vault: no scheme, not `#`, `/` or `//`. */
function isVaultRelativeUrl(url: string): boolean {
	if (url === '' || /^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
	return !url.startsWith('#') && !url.startsWith('/');
}

function safeDecodeUri(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

/** Characters that would end or break a bare Markdown destination. */
function encodeFragment(fragment: string): string {
	return fragment.replace(/[\s()<>]/g, c => encodeURIComponent(c));
}

interface Edit {
	start: number;
	end: number;
	replacement: string;
}

/**
 * Rewrite links in `raw`, leaving everything else byte-for-byte identical:
 *
 * - with `notes`, every `[[wikilink]]` to a note becomes UID form
 *   (`[[Note]]` → `[[UID|Note]]`);
 * - with `attachments`, every wikilink and inline Markdown link/image to a
 *   non-Markdown vault file gets `<sha256>.<ext>` or `null.<ext>` as its target
 *   (`![[Media/song.mp3]]` → `![[null.mp3]]`, `![](Media/pic.png)` →
 *   `![](null.png)`). Aliases, alt text, link text, titles, fragments and the
 *   embed `!` are kept; a file link with no alias never gains its path as
 *   display text.
 *
 * Same-note section links (`[[#Heading]]`), links with no path, unresolved
 * targets, external URLs, reference definitions and raw HTML are untouched.
 */
export function scrubRawWikilinks(raw: string, resolveTarget: ResolveTarget, opts: ScrubOptions): string {
	if (!opts.notes && !opts.attachments) return raw;

	// Fast path. A wikilink's brackets can also be written as escapes
	// (`\[`) or character references (`&#91;`), which the renderer still turns
	// into links, so only skip when neither `[` nor `&` appears.
	if (!raw.includes('[') && !raw.includes('&')) return raw;

	// Match the publish pipeline's text-node segmentation (remark-parse +
	// remark-gfm run before remark-obsidian-links). Positions are on by default.
	const tree = unified().use(remarkParse).use(remarkGfm as Plugin).parse(raw);
	const sourceMap = buildSourceMap(raw);
	const edits: Edit[] = [];

	visitParents(tree, (node: Node, ancestors: Node[]) => {
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		if (start == null || end == null) return;

		if (node.type === 'text') {
			scrubTextNode(node as Text, start, end, ancestors);
		} else if (opts.attachments && (node.type === 'image' || node.type === 'link')) {
			scrubDestination((node as Image | Link).url, start, end);
		}
	});

	/** Wikilinks in a text node's value. */
	function scrubTextNode(node: Text, start: number, end: number, ancestors: Node[]): void {
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

			const target = resolveTarget(notePath);
			if (!target) continue;
			if (target.kind === 'note' && !opts.notes) continue;
			if (target.kind === 'file' && !opts.attachments) continue;

			// Value positions: the path starts right after `[[`; the link side
			// (path + `#heading`) ends at the first `|`, else at `]]`.
			const pathStart = (match.index ?? 0) + 2;
			const pathEnd = pathStart + notePath.length;
			const srcPathStart = map.startOf(pathStart);
			const srcPathEnd = map.endOf(pathEnd - 1);

			if (target.kind === 'file') {
				// Only the path changes. No display text is added: a path fallback
				// would bring the file name back.
				edits.push({
					start: srcPathStart,
					end: srcPathEnd,
					replacement: fileTargetName(target.sha256, target.ext)
				});
				continue;
			}

			const pipeIdx = linkText.indexOf('|');
			const linkSideEnd = pathStart + (pipeIdx === -1 ? linkText.length : pipeIdx);
			const srcLinkSideEnd = map.endOf(linkSideEnd - 1);

			// With no inline alias, the original note path becomes the visible
			// alias (NOT the renderer's `alias || heading || notePath` — we keep
			// the path-as-title so the published title still reads well). It is
			// taken from the source, so any escapes in it survive. An empty alias
			// (`[[Note|]]`) is replaced along with its pipe.
			const display = alias === '' ? separator + raw.slice(srcPathStart, srcPathEnd) : '';
			const replaceEnd = alias === '' ? map.endOf(pathStart + linkText.length - 1) : srcLinkSideEnd;

			// Replace the path, keep `#heading` as written, then add the alias.
			edits.push({
				start: srcPathStart,
				end: replaceEnd,
				replacement: (target.uid ?? 'null') + raw.slice(srcPathEnd, srcLinkSideEnd) + display
			});
		}
	}

	/** The destination of an inline Markdown link or image to a vault file. */
	function scrubDestination(url: string, start: number, end: number): void {
		if (!isVaultRelativeUrl(url)) return;
		const hashIdx = url.indexOf('#');
		const path = safeDecodeUri(hashIdx === -1 ? url : url.slice(0, hashIdx));
		if (path === '') return;

		const target = resolveTarget(path);
		if (target?.kind !== 'file') return;

		// mdast positions cover the whole `![alt](dest "title")`; take the
		// destination's own span from the tokens. A `<…>` destination drops its
		// brackets, since the new target has no spaces.
		const dest = sourceMap.destinationOf(start, end);
		if (!dest) return;
		const fragment = hashIdx === -1 ? '' : '#' + encodeFragment(url.slice(hashIdx + 1));
		edits.push({
			start: dest.start,
			end: dest.end,
			replacement: fileTargetName(target.sha256, target.ext) + fragment
		});
	}

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
