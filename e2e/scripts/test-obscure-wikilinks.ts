#!/usr/bin/env npx tsx
/**
 * Obscure-Raw-Wikilinks Unit Test
 *
 * Exercises the pure scrubber core (scrubRawWikilinks) that backs
 * NoteManager.rewriteRawWikilinks: `[[Note]]` → `[[UID|Note]]` in published raw
 * Markdown, preserving aliases/headings, leaving same-note links and code spans
 * untouched, and keeping all surrounding Markdown byte-for-byte.
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
import { type ResolveUid } from '../../src/utils/rewriteRawWikilinks';
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

const resolveUid: ResolveUid = (notePath) => UID_BY_PATH[notePath] ?? null;

// ---------------------------------------------------------------------------
// Scrub cases — exact-string expectations
// ---------------------------------------------------------------------------

interface Case {
	name: string;
	input: string;
	expected: string;
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
	}
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

	for (const c of CASES) {
		const got = scrubRawWikilinks(c.input, resolveUid);
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

	// --- Parity: every wikilink the renderer turns into an <a> must be rewritten
	// by the scrub, and vice versa (resolved/published links only; unpublished
	// renderer spans still get scrubbed to a `null` sentinel, so we compare on
	// "did the [[..]] marker disappear from each output"). The strongest shared
	// invariant: neither output leaves a published `[[Path]]` marker behind, and
	// the scrub output never contains a raw note PATH inside a link target.
	const parityDoc =
		'[[a]] **x** [[b]] and `[[a]]` plus [[Unpublished]] and [[#Self]].';
	const html = await renderHtml(parityDoc);
	const scrubbed = scrubRawWikilinks(parityDoc, resolveUid);

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

	const total = CASES.length + 1;
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
