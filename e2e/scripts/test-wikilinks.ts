#!/usr/bin/env npx tsx
/**
 * Wikilink Parsing Regression Test
 *
 * Guards against the splice-index-corruption bug in remarkObsidianLinks where
 * paragraphs containing several `[[wikilinks]]` would only convert the first
 * few links to HTML, leaving later links as raw `[[...]]` plaintext.
 *
 * Root cause: replacements were collected with indices captured during
 * traversal, then applied in ascending order. The first splice expanded one
 * text node into many, shifting later siblings' indices so subsequent
 * replacements targeted the wrong node. The fix applies splices in descending
 * index order so earlier (lower-index) positions stay valid.
 *
 * This is a pure unit test of the remark plugin — it does NOT require a running
 * Obsidian instance. The plugin's `obsidian`/`FrontmatterManager` imports are
 * type-only, so we stub the Obsidian-dependent option and drive the same
 * unified() chain that NoteManager.markdownToHtml assembles.
 *
 * Run: npx tsx e2e/scripts/test-wikilinks.ts
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import * as obsidianLinksModule from '../../src/utils/remarkObsidianLinks';
import { type ResolvedNoteInfo } from '../../src/utils/remarkObsidianLinks';

// The plugin uses `export default`. Under tsx's ESM loader the default can be
// double-wrapped ({ default: { default: fn } }) so a plain default import yields
// an object, not the attacher function — unified().use() then silently no-ops and
// no wikilinks convert. Unwrap defensively so the harness exercises the real plugin.
const remarkObsidianLinks: any =
	(obsidianLinksModule as any).default?.default ??
	(obsidianLinksModule as any).default ??
	obsidianLinksModule;

// ---------------------------------------------------------------------------
// Test pipeline
// ---------------------------------------------------------------------------

// Note paths that resolve as published; everything else is treated as
// unresolved/unpublished and rendered as a non-clickable span.
const PUBLISHED = new Set(['a', 'b', 'c', 'alpha', 'beta']);

async function render(markdown: string): Promise<string> {
	const processor = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkObsidianLinks, {
			// Only referenced as a type inside the plugin; never dereferenced.
			frontmatterManager: {} as any,
			urlScheme: 'current',
			resolveInternalLinks: async (
				notePath: string
			): Promise<ResolvedNoteInfo | null> => {
				if (PUBLISHED.has(notePath)) {
					return { uid: `UID-${notePath}`, title: notePath, published: true };
				}
				return null;
			}
		})
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeSlug)
		.use(rehypeStringify, { allowDangerousHtml: true });

	const result = await processor.process(markdown);
	return result.toString();
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

interface Case {
	name: string;
	input: string;
	anchors: number; // expected <a ...> count (published links)
	spans: number; // expected unpublished-link span count
	extra?: (html: string) => string | null; // optional extra check; return error msg or null
}

const CASES: Case[] = [
	{
		name: 'Baseline — single plain wikilink',
		input: 'See [[a]] for details.',
		anchors: 1,
		spans: 0
	},
	{
		name: 'Reported failure — 3 links split by inline formatting',
		input: '[[a]] **bold** [[b]] _em_ [[c]]',
		anchors: 3,
		spans: 0
	},
	{
		name: 'Inline code splits the paragraph',
		input: 'start [[a]] then `code` then [[b]] end',
		anchors: 2,
		spans: 0
	},
	{
		name: 'Mixed resolution — published + unpublished in one paragraph',
		input: '[[a]] and **x** [[missing]] and [[b]]',
		anchors: 2,
		spans: 1
	},
	{
		name: 'Alias + heading display text (slugged data-heading matches rendered id)',
		input: '## Section\n\n[[a|Display]] then **y** then [[b#Section]]',
		anchors: 2,
		spans: 0,
		extra: (html) => {
			if (!html.includes('>Display<')) return 'missing alias display text "Display"';
			if (!html.includes('>Section<')) return 'missing heading display text "Section"';
			// data-heading is now slugged (lowercased) to match rehype-slug's id
			if (!html.includes('data-heading="section"'))
				return 'resolved heading link missing data-heading="section"';
			// rehype-slug should assign id="section" to the rendered heading, and it
			// must match the link's data-heading exactly (the central correctness goal)
			if (!html.includes('id="section"'))
				return 'rendered heading missing id="section"';
			return null;
		}
	},
	{
		name: 'Same-note section link is clickable (not an unpublished span)',
		input: '## My Heading\n\nJump to [[#My Heading]].',
		anchors: 1,
		spans: 0,
		extra: (html) => {
			if (!html.includes('id="my-heading"')) return 'rendered heading missing id="my-heading"';
			if (!html.includes('data-same-note="true"'))
				return 'same-note link missing data-same-note="true"';
			if (!html.includes('data-heading="my-heading"'))
				return 'same-note link missing slugged data-heading="my-heading"';
			if (html.includes('class="unpublished-link"'))
				return 'same-note link should be clickable, not an unpublished span';
			return null;
		}
	},
	{
		name: 'Duplicate headings get -1/-2 dedupe ids (render side)',
		input: '## Dup\n\ntext\n\n## Dup\n\nmore',
		anchors: 0,
		spans: 0,
		extra: (html) => {
			if (!html.includes('id="dup"')) return 'first duplicate heading missing id="dup"';
			if (!html.includes('id="dup-1"')) return 'second duplicate heading missing id="dup-1"';
			return null;
		}
	},
	{
		name: 'Adjacent to an explicit Markdown link',
		input: '[text](https://example.com) [[a]] [[b]]',
		anchors: 3, // explicit md link + 2 wikilinks
		spans: 0,
		extra: (html) =>
			html.includes('href="https://example.com"')
				? null
				: 'explicit markdown link was lost'
	}
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
	let failures = 0;

	for (const c of CASES) {
		const html = await render(c.input);
		const errors: string[] = [];

		const leftover = count(html, '[[') + count(html, ']]');
		if (leftover > 0) errors.push(`found ${leftover} leftover [[ or ]] markers`);

		const anchors = count(html, '<a ');
		if (anchors !== c.anchors)
			errors.push(`expected ${c.anchors} <a> anchors, got ${anchors}`);

		const spans = count(html, 'class="unpublished-link"');
		if (spans !== c.spans)
			errors.push(`expected ${c.spans} unpublished spans, got ${spans}`);

		if (c.extra) {
			const extraErr = c.extra(html);
			if (extraErr) errors.push(extraErr);
		}

		if (errors.length === 0) {
			console.log(`PASS  ${c.name}`);
		} else {
			failures++;
			console.log(`FAIL  ${c.name}`);
			console.log(`        input:  ${c.input}`);
			console.log(`        output: ${html.trim()}`);
			for (const e of errors) console.log(`        - ${e}`);
		}
	}

	console.log('');
	if (failures === 0) {
		console.log(`All ${CASES.length} wikilink cases passed.`);
		process.exit(0);
	} else {
		console.log(`${failures}/${CASES.length} wikilink cases FAILED.`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
