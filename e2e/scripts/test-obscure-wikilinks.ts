#!/usr/bin/env npx tsx
/**
 * Obscure-Raw-Wikilinks Unit Test
 *
 * Exercises the pure scrubber core (scrubRawWikilinks) that backs
 * NoteManager.rewriteRawWikilinks: `[[Note]]` → `[[UID|Note]]` in published raw
 * Markdown, preserving aliases/headings, leaving same-note links and code spans
 * untouched, and keeping all surrounding Markdown byte-for-byte. Also covers
 * Obscure attachment names (links to vault files → `null.<ext>`), splice
 * offsets after escapes/entities/line prefixes, and pipes in table cells.
 *
 * The scrubber takes UID resolution as a callback, so this is a pure unit test —
 * no Obsidian runtime required. A final PARITY block confirms the scrubber
 * rewrites exactly the set of wikilinks the HTML renderer (remarkObsidianLinks)
 * turns into links, so the two can't silently drift.
 *
 * Run: npx tsx e2e/scripts/test-obscure-wikilinks.ts
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import * as scrubModule from '../../src/utils/rewriteRawWikilinks';
import { type ResolveTarget, type ScrubOptions } from '../../src/utils/rewriteRawWikilinks';
import * as obsidianLinksModule from '../../src/utils/remarkObsidianLinks';
import { type ResolvedNoteInfo } from '../../src/utils/remarkObsidianLinks';

// Under tsx's ESM/CJS interop, named exports from src/ modules can land under
// `.default`. Pick the namespace when the export is present, else unwrap once —
// the same idiom the other e2e unit tests use (see test-comment-sanitizer.ts).
const scrubRawWikilinks: typeof import('../../src/utils/rewriteRawWikilinks').scrubRawWikilinks =
	(scrubModule as any).scrubRawWikilinks ?? (scrubModule as any).default?.scrubRawWikilinks;

const remarkObsidianLinks: any =
	(obsidianLinksModule as any).default?.default ??
	(obsidianLinksModule as any).default ??
	obsidianLinksModule;

// ---------------------------------------------------------------------------
// Fake UID resolution
// ---------------------------------------------------------------------------

// note path → UID (uppercase Crockford, as real UIDs are). Anything not here
// resolves to null → sentinel `null`.
const UID_BY_PATH: Record<string, string> = {
	'Intake for Commonplace Notes': 'MB46M5BM92',
	'Note A': 'AAAA1111',
	'Note B': 'BBBB2222',
	'a': 'UIDA',
	'b': 'UIDB'
};

const resolveUid = (notePath: string): string | null => UID_BY_PATH[notePath] ?? null;

// Non-Markdown vault files. By default each resolves with a null hash and
// becomes `null.<ext>`; the "Published" block supplies hashes for a note's list.
const FILES = new Set([
	'Media/2024/song.mp3', 'Media/song.mp3', 'Media/pic.png', 'Media/2024/my pic.png', 'Media/my pic.png',
	'Docs/slides.pdf', 'Docs/a.pdf', 'Docs/README', 'private/scan.pdf', 'pic.png'
]);

/** Paths that don't resolve at all, so the link is left as written. */
const UNRESOLVED = new Set(['Ghost Path']);

/**
 * Mirrors NoteManager.rewriteRawWikilinks: notes by UID, files by extension,
 * and anything else as a note without a UID (today's `[[null|…]]` sentinel).
 */
const resolveTarget: ResolveTarget = (path) => {
	if (UNRESOLVED.has(path)) return null;
	if (FILES.has(path)) {
		const name = path.slice(path.lastIndexOf('/') + 1);
		const dot = name.lastIndexOf('.');
		return { kind: 'file', sha256: null, ext: dot === -1 ? '' : name.slice(dot + 1) };
	}
	return { kind: 'note', uid: resolveUid(path) };
};

const BOTH: ScrubOptions = { notes: true, attachments: true };
const scrub = (raw: string, opts: ScrubOptions = BOTH): string => scrubRawWikilinks(raw, resolveTarget, opts);

// ---------------------------------------------------------------------------
// Scrub cases — exact-string expectations
// ---------------------------------------------------------------------------

interface Case {
	name: string;
	input: string;
	expected: string;
	/** Defaults to both settings on. */
	opts?: ScrubOptions;
}

const CASES: Case[] = [
	{
		name: 'Basic — path becomes UID, title kept as alias',
		input: 'See [[Intake for Commonplace Notes]] today.',
		expected: 'See [[MB46M5BM92|Intake for Commonplace Notes]] today.'
	},
	{
		name: 'Author alias preserved, only path swapped',
		input: 'See [[Intake for Commonplace Notes|the intake note]].',
		expected: 'See [[MB46M5BM92|the intake note]].'
	},
	{
		name: 'Heading preserved on link side, display = path',
		input: '[[Intake for Commonplace Notes#Summary]]',
		expected: '[[MB46M5BM92#Summary|Intake for Commonplace Notes]]'
	},
	{
		name: 'Heading + alias',
		input: '[[Intake for Commonplace Notes#Summary|see summary]]',
		expected: '[[MB46M5BM92#Summary|see summary]]'
	},
	{
		name: 'Same-note section link left untouched',
		input: 'Jump to [[#My Heading]] below.',
		expected: 'Jump to [[#My Heading]] below.'
	},
	{
		name: 'Unresolved target → null sentinel, original title kept',
		input: 'See [[Some Private Draft]].',
		expected: 'See [[null|Some Private Draft]].'
	},
	{
		name: 'Unresolved target with alias → null sentinel, alias kept',
		input: 'See [[Some Private Draft|this]].',
		expected: 'See [[null|this]].'
	},
	{
		name: 'Multiple pipes — split on first | only',
		input: '[[Note A|a|b]]',
		expected: '[[AAAA1111|a|b]]'
	},
	{
		name: 'Hash inside alias preserved (parsed from link side only)',
		input: '[[Note A|a#b]]',
		expected: '[[AAAA1111|a#b]]'
	},
	{
		name: 'Two links in one paragraph, surrounding text intact',
		input: 'Both [[Note A]] and [[Note B]] matter.',
		expected: 'Both [[AAAA1111|Note A]] and [[BBBB2222|Note B]] matter.'
	},
	{
		name: 'Wikilink inside a fenced code block — untouched',
		input: '```\n[[Note A]]\n```\n',
		expected: '```\n[[Note A]]\n```\n'
	},
	{
		name: 'Wikilink inside inline code — untouched',
		input: 'literal `[[Note A]]` here',
		expected: 'literal `[[Note A]]` here'
	},
	{
		name: 'Link in a list item, surrounding structure verbatim',
		input: '- one [[Note A]]\n- two [[Note B]]\n',
		expected: '- one [[AAAA1111|Note A]]\n- two [[BBBB2222|Note B]]\n'
	},
	{
		name: 'Link inside a blockquote',
		input: '> quote with [[Note A]]\n',
		expected: '> quote with [[AAAA1111|Note A]]\n'
	},
	{
		name: 'No wikilinks — returned unchanged',
		input: '# Title\n\nJust prose, *emphasis*, and a [link](https://example.com).\n',
		expected: '# Title\n\nJust prose, *emphasis*, and a [link](https://example.com).\n'
	},
	{
		name: 'Verbatim preservation of mixed Markdown around the only link',
		input: '## H\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\ntext [[Note A]] end  \n',
		expected: '## H\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\ntext [[AAAA1111|Note A]] end  \n'
	},
	{
		name: 'Embed — ! kept, path swapped for UID',
		input: '![[Note A]]',
		expected: '![[AAAA1111|Note A]]'
	},
	{
		name: 'Block embed + alias — ^id kept verbatim',
		input: '![[Note A#^abc|x]]',
		expected: '![[AAAA1111#^abc|x]]'
	},
	{
		name: 'Block id marker in prose untouched',
		input: 'A paragraph ^intro\n',
		expected: 'A paragraph ^intro\n'
	}
];

// ---------------------------------------------------------------------------
// Splice offsets — `value` isn't a byte copy of the source (P1 §3)
// ---------------------------------------------------------------------------
//
// Each of these used to corrupt `raw`: the splice landed at
// `node.position.start.offset + match.index`, which drifts by every character
// the parser drops before the match (escapes, entities, trailing whitespace,
// continuation-line prefixes).

const OFFSET_CASES: Case[] = [
	{ name: 'Offsets — escape before a link', input: 'a \\* [[Note A]] b', expected: 'a \\* [[AAAA1111|Note A]] b' },
	{ name: 'Offsets — entity before a link', input: 'x &amp; [[Note A]] y', expected: 'x &amp; [[AAAA1111|Note A]] y' },
	{ name: 'Offsets — numeric entities before a link', input: '&#169; &#x41; [[Note A]]', expected: '&#169; &#x41; [[AAAA1111|Note A]]' },
	{ name: 'Offsets — trailing space before a soft break', input: 'a \n[[Note A]] b', expected: 'a \n[[AAAA1111|Note A]] b' },
	{ name: 'Offsets — trailing tab before a soft break', input: 'a\t\n[[Note A]] b', expected: 'a\t\n[[AAAA1111|Note A]] b' },
	{ name: 'Offsets — blockquote continuation line', input: '> a\n> [[Note A]] b\n', expected: '> a\n> [[AAAA1111|Note A]] b\n' },
	{ name: 'Offsets — list-item continuation line', input: '- a\n  [[Note A]] b\n', expected: '- a\n  [[AAAA1111|Note A]] b\n' },
	{ name: 'Offsets — indented paragraph continuation line', input: 'a\n   [[Note A]] b\n', expected: 'a\n   [[AAAA1111|Note A]] b\n' },
	{ name: 'Offsets — nested blockquote in a list', input: '- > a\n  > b [[Note A]]\n', expected: '- > a\n  > b [[AAAA1111|Note A]]\n' },
	{ name: 'Offsets — two links with an escape between them', input: '[[Note A]] \\_ [[Note B]]', expected: '[[AAAA1111|Note A]] \\_ [[BBBB2222|Note B]]' },
	{ name: 'Offsets — escaped brackets still rewritten', input: '\\[\\[Note A]]', expected: '\\[\\[AAAA1111|Note A]]' },
	{ name: 'Offsets — bracket references still rewritten', input: '&#91;&#91;Note A]]', expected: '&#91;&#91;AAAA1111|Note A]]' },
	{ name: 'Offsets — escapes inside heading and alias kept as written', input: '[[Note A#H\\*x|a \\* b]]', expected: '[[AAAA1111#H\\*x|a \\* b]]' },
	{ name: 'Offsets — escape inside the path kept in the display alias', input: '[[Some \\* Draft]]', expected: '[[null|Some \\* Draft]]' },
	{ name: 'Empty alias — replaced with the path', input: '[[Note A|]]', expected: '[[AAAA1111|Note A]]' }
];

// ---------------------------------------------------------------------------
// Pipes in table cells (P1 §3)
// ---------------------------------------------------------------------------

const TABLE_HEAD = '| h | x |\n|---|---|\n';

const TABLE_CASES: Case[] = [
	{ name: 'Table — [[Note]] gets an escaped separator', input: TABLE_HEAD + '| [[Note A]] | x |\n', expected: TABLE_HEAD + '| [[AAAA1111\\|Note A]] | x |\n' },
	{ name: 'Table — [[Note\\|alias]]', input: TABLE_HEAD + '| [[Note A\\|alias]] | x |\n', expected: TABLE_HEAD + '| [[AAAA1111\\|alias]] | x |\n' },
	{ name: 'Table — [[Note#Heading\\|alias]]', input: TABLE_HEAD + '| [[Note A#Heading\\|alias]] | x |\n', expected: TABLE_HEAD + '| [[AAAA1111#Heading\\|alias]] | x |\n' },
	{ name: 'Table — heading, no alias', input: TABLE_HEAD + '| [[Note A#Heading]] | x |\n', expected: TABLE_HEAD + '| [[AAAA1111#Heading\\|Note A]] | x |\n' },
	{ name: 'Table — two links in one cell', input: TABLE_HEAD + '| [[Note A]] [[Note B]] | x |\n', expected: TABLE_HEAD + '| [[AAAA1111\\|Note A]] [[BBBB2222\\|Note B]] | x |\n' },
	{ name: 'Outside a table — bare separator', input: 'p [[Note A]] [[Note A\\|alias]]\n', expected: 'p [[AAAA1111|Note A]] [[AAAA1111\\|alias]]\n' }
];

/**
 * Text outside wikilinks, plus the node-type outline, of a parsed document.
 * The scrub may only change what's inside `[[…]]`, so this must be the same
 * before and after.
 */
function outsideLinks(markdown: string): string {
	const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
	const parts: string[] = [];
	const walk = (node: any): void => {
		parts.push(`<${node.type}>`);
		if (node.type === 'text') parts.push(node.value.replace(/\[\[(.*?)\]\]/g, '[[…]]'));
		else if (typeof node.value === 'string') parts.push(node.value);
		if (typeof node.alt === 'string') parts.push(`alt=${node.alt}`);
		if (typeof node.title === 'string') parts.push(`title=${node.title}`);
		for (const child of node.children ?? []) walk(child);
		parts.push(`</${node.type}>`);
	};
	walk(tree);
	return parts.join('');
}

/** Cell count of every table row, e.g. `2,2,2`. */
function tableShape(markdown: string): string {
	const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
	const rows: number[] = [];
	const walk = (node: any): void => {
		if (node.type === 'tableRow') rows.push(node.children.length);
		for (const child of node.children ?? []) walk(child);
	};
	walk(tree);
	return rows.join(',');
}

// ---------------------------------------------------------------------------
// Obscure attachment names (P1 §4) — every file target is null.<ext> in phase 1
// ---------------------------------------------------------------------------

const PIC = '[[Note A]] ![[Media/pic.png]] ![](Media/pic.png)';

const ATTACHMENT_CASES: Case[] = [
	// The §4 table, with null in place of the hash.
	{ name: 'Files — embed, folder path dropped', input: '![[Media/2024/song.mp3]]', expected: '![[null.mp3]]' },
	{ name: 'Files — size alias kept', input: '![[Media/pic.png|300]]', expected: '![[null.png|300]]' },
	{ name: 'Files — fragment and alias kept', input: '[[Docs/slides.pdf#page=3|deck]]', expected: '[[null.pdf#page=3|deck]]' },
	{ name: 'Files — plain link', input: '[[Docs/slides.pdf]]', expected: '[[null.pdf]]' },
	{ name: 'Files — excluded file embed', input: '![[private/scan.pdf]]', expected: '![[null.pdf]]' },
	{ name: 'Files — excluded file with alias', input: '[[private/scan.pdf|my scan]]', expected: '[[null.pdf|my scan]]' },
	{ name: 'Files — Markdown image, percent-encoded', input: '![](Media/2024/my%20pic.png)', expected: '![](null.png)' },
	{ name: 'Files — Markdown image, <…> destination', input: '![alt|300](<Media/my pic.png>)', expected: '![alt|300](null.png)' },
	{ name: 'Files — Markdown link', input: '[notes](Docs/a.pdf)', expected: '[notes](null.pdf)' },
	// More shapes.
	{ name: 'Files — fragment only', input: '![[Docs/slides.pdf#page=3]]', expected: '![[null.pdf#page=3]]' },
	{ name: 'Files — no path fallback (closes [[null|Media/song.mp3]] leak)', input: '[[Media/song.mp3]]', expected: '[[null.mp3]]' },
	{ name: 'Files — no extension', input: '[[Docs/README]] and [r](Docs/README)', expected: '[[null]] and [r](null)' },
	{ name: 'Files — Markdown link with title', input: '[notes](Docs/a.pdf "The title")', expected: '[notes](null.pdf "The title")' },
	{ name: 'Files — <…> destination with title', input: "![x](<Media/my pic.png> 'T')", expected: "![x](null.png 'T')" },
	{ name: 'Files — percent-encoded with title', input: '![x](Media/2024/my%20pic.png (T))', expected: '![x](null.png (T))' },
	{ name: 'Files — Markdown fragment kept', input: '[p3](Docs/slides.pdf#page=3)', expected: '[p3](null.pdf#page=3)' },
	{ name: 'Files — image nested in a link', input: '[![a](Media/pic.png)](Docs/a.pdf)', expected: '[![a](null.png)](null.pdf)' },
	{ name: 'Files — link text naming the file is kept (known limitation)', input: '[song.mp3](Media/song.mp3)', expected: '[song.mp3](null.mp3)' },
	// Left alone.
	{ name: 'Files — unresolved Markdown target unchanged', input: '![](Media/missing.png)', expected: '![](Media/missing.png)' },
	{ name: 'Files — unresolved wikilink unchanged', input: '![[Ghost Path]]', expected: '![[Ghost Path]]' },
	{ name: 'Files — Markdown link to a note unchanged', input: '[n](Note A)', expected: '[n](Note A)' },
	{
		name: 'Files — external, anchor, absolute and protocol-relative URLs unchanged',
		input: '![](https://x.com/Media/pic.png) [m](mailto:a@b.c) [h](#Media/pic.png) [abs](/Media/pic.png) [p](//cdn/Media/pic.png)',
		expected: '![](https://x.com/Media/pic.png) [m](mailto:a@b.c) [h](#Media/pic.png) [abs](/Media/pic.png) [p](//cdn/Media/pic.png)'
	},
	{ name: 'Files — reference definition unchanged', input: '![x][ref]\n\n[ref]: Media/pic.png\n', expected: '![x][ref]\n\n[ref]: Media/pic.png\n' },
	{ name: 'Files — raw HTML unchanged', input: '<img src="Media/pic.png">\n\ntext <a href="Docs/a.pdf">a</a>', expected: '<img src="Media/pic.png">\n\ntext <a href="Docs/a.pdf">a</a>' },
	{ name: 'Files — inline code unchanged', input: '`![](Media/pic.png)` `![[Media/pic.png]]`', expected: '`![](Media/pic.png)` `![[Media/pic.png]]`' },
	// The two switches independently.
	{ name: 'Switches — both', input: PIC, expected: '[[AAAA1111|Note A]] ![[null.png]] ![](null.png)' },
	{ name: 'Switches — notes only', input: PIC, expected: '[[AAAA1111|Note A]] ![[Media/pic.png]] ![](Media/pic.png)', opts: { notes: true, attachments: false } },
	{ name: 'Switches — attachments only', input: PIC, expected: '[[Note A]] ![[null.png]] ![](null.png)', opts: { notes: false, attachments: true } },
	{ name: 'Switches — neither', input: PIC, expected: PIC, opts: { notes: false, attachments: false } }
];

// Splice offsets for file targets and Markdown destinations (P1 §3 + §4).
const ATTACHMENT_OFFSET_CASES: Case[] = [
	{ name: 'Offsets (files) — escape before an embed', input: 'a \\* ![[Media/song.mp3]] b', expected: 'a \\* ![[null.mp3]] b' },
	{ name: 'Offsets (files) — entity before a Markdown image', input: 'x &amp; ![](Media/pic.png) y', expected: 'x &amp; ![](null.png) y' },
	{ name: 'Offsets (files) — trailing space before a soft break', input: 'a \n![[Media/pic.png]] ![](Media/pic.png)', expected: 'a \n![[null.png]] ![](null.png)' },
	{ name: 'Offsets (files) — blockquote continuation', input: '> a\n> ![[Media/pic.png]] ![](Media/pic.png)\n', expected: '> a\n> ![[null.png]] ![](null.png)\n' },
	{ name: 'Offsets (files) — list continuation', input: '- a\n  [[Docs/a.pdf]] [notes](Docs/a.pdf)\n', expected: '- a\n  [[null.pdf]] [notes](null.pdf)\n' },
	{ name: 'Offsets (files) — indented continuation', input: 'a\n   [notes](Docs/a.pdf)\n', expected: 'a\n   [notes](null.pdf)\n' },
	{ name: 'Offsets (files) — escaped alt text kept', input: '![a \\* b](<Media/my pic.png>) [[Note A]]', expected: '![a \\* b](null.png) [[AAAA1111|Note A]]' },
	{ name: 'Offsets (files) — escaped brackets', input: '!\\[\\[Media/pic.png]]', expected: '!\\[\\[null.png]]' }
];

const ATTACHMENT_TABLE_CASES: Case[] = [
	{ name: 'Table (files) — ![[pic.png\\|300]]', input: TABLE_HEAD + '| ![[pic.png\\|300]] | x |\n', expected: TABLE_HEAD + '| ![[null.png\\|300]] | x |\n' },
	{ name: 'Table (files) — ![alt\\|300](pic.png)', input: TABLE_HEAD + '| ![alt\\|300](pic.png) | x |\n', expected: TABLE_HEAD + '| ![alt\\|300](null.png) | x |\n' },
	{ name: 'Table (files) — [[Docs/a.pdf]]', input: TABLE_HEAD + '| [[Docs/a.pdf]] | x |\n', expected: TABLE_HEAD + '| [[null.pdf]] | x |\n' },
	{ name: 'Outside a table (files) — bare separator kept', input: '![[pic.png|300]]', expected: '![[null.png|300]]' }
];

// ---------------------------------------------------------------------------
// HTML renderer (for parity), mirroring NoteManager.markdownToHtml's chain
// ---------------------------------------------------------------------------

async function renderHtml(markdown: string): Promise<string> {
	const processor = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkObsidianLinks, {
			frontmatterManager: {} as any,
			urlScheme: 'current',
			resolveInternalLinks: async (notePath: string): Promise<ResolvedNoteInfo | null> => {
				const uid = resolveUid(notePath);
				return uid ? { uid, title: notePath, published: true } : null;
			}
		})
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeSlug)
		.use(rehypeStringify, { allowDangerousHtml: true });
	return (await processor.process(markdown)).toString();
}

function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
	let failures = 0;
	let publishedCount = 0;

	for (const c of [...CASES, ...ATTACHMENT_CASES]) {
		const got = scrub(c.input, c.opts);
		if (got === c.expected) {
			console.log(`PASS  ${c.name}`);
		} else {
			failures++;
			console.log(`FAIL  ${c.name}`);
			console.log(`        input:    ${JSON.stringify(c.input)}`);
			console.log(`        expected: ${JSON.stringify(c.expected)}`);
			console.log(`        got:      ${JSON.stringify(got)}`);
		}
	}

	// --- Published targets (attachment spec P2 §4, "Raw scrub: published
	// targets"): files in the note's attachment list get `<sha256>.<ext>`, as
	// NoteManager.rewriteRawWikilinks supplies them (by vault path).
	{
		const SHA_SONG = 'a'.repeat(64);
		const SHA_README = 'c'.repeat(64);
		// The note's list in `embeds` mode: only embedded files, but every
		// reference to a listed file resolves to its hash.
		const LIST = new Map([['Media/2024/song.mp3', SHA_SONG], ['Docs/README', SHA_README]]);
		const withList: ResolveTarget = (path) => {
			const t = resolveTarget(path);
			if (t?.kind !== 'file') return t;
			return { ...t, sha256: LIST.get(path) ?? null };
		};
		const PUBLISHED_CASES: Array<[string, string, string]> = [
			['Published — embed gets <sha256>.<ext>', '![[Media/2024/song.mp3]]', `![[${SHA_SONG}.mp3]]`],
			['Published — unlisted file stays null.<ext>', '![[Media/pic.png|300]]', '![[null.png|300]]'],
			['Published — no extension → <sha256>, unlisted → null', '[[Docs/README]] [x](Docs/a.pdf) ![[Docs/README]]', `[[${SHA_README}]] [x](null.pdf) ![[${SHA_README}]]`],
			['Published — plain link to a file the note also embeds (embeds mode)', '![[Media/2024/song.mp3]] and [[Media/2024/song.mp3|again]]', `![[${SHA_SONG}.mp3]] and [[${SHA_SONG}.mp3|again]]`],
			['Published — Markdown image', '![s](Media/2024/song.mp3)', `![s](${SHA_SONG}.mp3)`],
		];
		for (const [name, input, expected] of PUBLISHED_CASES) {
			const got = scrubRawWikilinks(input, withList, BOTH);
			publishedCount++;
			if (got === expected) console.log(`PASS  ${name}`);
			else {
				failures++;
				console.log(`FAIL  ${name}`);
				console.log(`        expected: ${JSON.stringify(expected)}`);
				console.log(`        got:      ${JSON.stringify(got)}`);
			}
		}
	}

	// --- Splice offsets and table pipes: exact output, plus the invariant that
	// only the inside of links changed, plus (tables) the same cell layout.
	for (const c of [...OFFSET_CASES, ...TABLE_CASES, ...ATTACHMENT_OFFSET_CASES, ...ATTACHMENT_TABLE_CASES]) {
		const got = scrub(c.input, c.opts);
		const problems: string[] = [];
		if (got !== c.expected) problems.push(`expected ${JSON.stringify(c.expected)}`);
		if (outsideLinks(got) !== outsideLinks(c.input)) problems.push('text outside links changed when parsed again');
		if (tableShape(got) !== tableShape(c.input)) {
			problems.push(`table shape ${tableShape(c.input)} → ${tableShape(got)}`);
		}
		if (problems.length === 0) {
			console.log(`PASS  ${c.name}`);
		} else {
			failures++;
			console.log(`FAIL  ${c.name}`);
			console.log(`        input:    ${JSON.stringify(c.input)}`);
			console.log(`        got:      ${JSON.stringify(got)}`);
			for (const p of problems) console.log(`        - ${p}`);
		}
	}

	// --- Parity: every wikilink the renderer turns into an <a> must be rewritten
	// by the scrub, and vice versa (resolved/published links only; unpublished
	// renderer spans still get scrubbed to a `null` sentinel, so we compare on
	// "did the [[..]] marker disappear from each output"). The strongest shared
	// invariant: neither output leaves a published `[[Path]]` marker behind, and
	// the scrub output never contains a raw note PATH inside a link target.
	const parityDoc =
		'[[a]] **x** [[b]] and `[[a]]` plus [[Unpublished]] and [[#Self]].';
	const html = await renderHtml(parityDoc);
	const scrubbed = scrub(parityDoc);

	const parityErrors: string[] = [];
	// Renderer converts both published links to anchors (2), inline-code [[a]]
	// stays literal, unpublished → span, same-note → anchor.
	if (count(html, 'href="#/uUIDA"') !== 1) parityErrors.push('renderer missing anchor for a');
	if (count(html, 'href="#/uUIDB"') !== 1) parityErrors.push('renderer missing anchor for b');
	// Scrub: published links become UID form, unpublished becomes null sentinel,
	// inline-code and same-note are untouched.
	if (!scrubbed.includes('[[UIDA|a]]')) parityErrors.push('scrub missing [[UIDA|a]]');
	if (!scrubbed.includes('[[UIDB|b]]')) parityErrors.push('scrub missing [[UIDB|b]]');
	if (!scrubbed.includes('[[null|Unpublished]]')) parityErrors.push('scrub missing null sentinel for Unpublished');
	if (!scrubbed.includes('`[[a]]`')) parityErrors.push('scrub wrongly touched inline-code link');
	if (!scrubbed.includes('[[#Self]]')) parityErrors.push('scrub wrongly touched same-note link');

	if (parityErrors.length === 0) {
		console.log('PASS  Parity — scrub and renderer agree on which links are real');
	} else {
		failures++;
		console.log('FAIL  Parity — scrub and renderer agree on which links are real');
		console.log(`        html:    ${html.trim()}`);
		console.log(`        scrubbed:${JSON.stringify(scrubbed)}`);
		for (const e of parityErrors) console.log(`        - ${e}`);
	}

	const total = CASES.length + ATTACHMENT_CASES.length + OFFSET_CASES.length + TABLE_CASES.length
		+ ATTACHMENT_OFFSET_CASES.length + ATTACHMENT_TABLE_CASES.length + publishedCount + 1;
	console.log('');
	if (failures === 0) {
		console.log(`All ${total} obscure-wikilink cases passed.`);
		process.exit(0);
	} else {
		console.log(`${failures}/${total} obscure-wikilink cases FAILED.`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
