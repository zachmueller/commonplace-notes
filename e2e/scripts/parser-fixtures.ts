/**
 * Shared fixture corpus for the parser-pipeline regression tests.
 *
 * Used by:
 *   - capture-parser-golden.ts  (snapshots the LEGACY pipeline output)
 *   - test-parser-pipeline.ts   (asserts the NEW manager pipeline matches)
 *
 * Exercises every built-in stage: GFM tables/strikethrough (remark-gfm),
 * line metadata (line-numbers), wikilink resolution + unpublished spans +
 * same-note anchors (remark-obsidian-links), heading slug ids (rehype-slug),
 * and raw-HTML passthrough (remark-rehype/rehype-stringify allowDangerousHtml).
 */

/** Note paths treated as published; everything else → unpublished span. */
export const PUBLISHED = new Set(['a', 'b', 'c', 'alpha', 'beta']);

export interface Fixture {
	name: string;
	input: string;
}

export const PARSER_FIXTURES: Fixture[] = [
	{ name: 'plain-paragraph', input: 'Just a plain paragraph with some text.' },
	{ name: 'single-wikilink', input: 'See [[a]] for details.' },
	{
		name: 'multi-wikilink-with-formatting',
		input: '[[a]] **bold** [[b]] _em_ [[c]]',
	},
	{
		name: 'mixed-resolution',
		input: '[[a]] and **x** [[missing]] and [[b]]',
	},
	{
		name: 'heading-and-section-wikilink',
		input: '## Section\n\n[[a|Display]] then **y** then [[b#Section]]',
	},
	{
		name: 'same-note-anchor',
		input: '## My Heading\n\nJump to [[#My Heading]].',
	},
	{
		name: 'duplicate-headings',
		input: '## Dup\n\ntext\n\n## Dup\n\nmore',
	},
	{
		name: 'gfm-table-and-strikethrough',
		input: '| a | b |\n| - | - |\n| 1 | 2 |\n\n~~struck~~ and a list:\n\n- [ ] todo\n- [x] done',
	},
	{
		name: 'explicit-markdown-link-adjacent',
		input: '[text](https://example.com) [[a]] [[b]]',
	},
	{
		name: 'raw-html-passthrough',
		input: 'Inline <kbd>Ctrl</kbd> and a <div class="x">block</div>.',
	},
];
