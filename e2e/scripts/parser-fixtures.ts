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

const SHA = (c: string) => c.repeat(64);

/**
 * Non-Markdown vault files, as NoteManager's resolveAttachment would report
 * them (attachment spec P2 §4). Published entries are in the note's
 * attachment list; the others are vault files that don't publish. Anything
 * else (notes, missing files, URLs) → null.
 */
const ATTACHMENTS: Record<string, { sha?: string; fileName: string; kind?: 'image' | 'audio' | 'video' | 'file'; inline?: true }> = {
	'song.mp3': { sha: SHA('a'), fileName: 'song.mp3', kind: 'audio' },
	'pic.png': { sha: SHA('b'), fileName: 'pic.png', kind: 'image' },
	'clip.mp4': { sha: SHA('c'), fileName: 'clip.mp4', kind: 'video' },
	'slides.pdf': { sha: SHA('d'), fileName: 'slides.pdf', kind: 'file' },
	'Media/cat pic.png': { sha: SHA('e'), fileName: 'cat pic.png', kind: 'image' },
	'Media/doc.pdf': { sha: SHA('f'), fileName: 'doc.pdf', kind: 'file' },
	// A PDF on a profile with Show PDFs inline on.
	'deck.pdf': { sha: SHA('2'), fileName: 'deck.pdf', kind: 'file', inline: true },
	'Media/deck.pdf': { sha: SHA('2'), fileName: 'deck.pdf', kind: 'file', inline: true },
	'odd "q" x<y & ü.png': { sha: SHA('1'), fileName: 'odd "q" x<y & ü.png', kind: 'image' },
	'Media/secret.mp3': { fileName: 'secret.mp3' },
	'secret.mp3': { fileName: 'secret.mp3' },
	'a&b>c.png': { fileName: 'a&b>c.png' },
	'x<y.mp3': { fileName: 'x<y.mp3' },
};

export function resolveAttachmentFixture(linkpath: string):
	| { published: true; key: string; fileName: string; kind: 'image' | 'audio' | 'video' | 'file'; inline?: true }
	| { published: false; fileName: string }
	| null {
	const a = ATTACHMENTS[linkpath];
	if (!a) return null;
	if (!a.sha) return { published: false, fileName: a.fileName };
	const render: { published: true; key: string; fileName: string; kind: 'image' | 'audio' | 'video' | 'file'; inline?: true } =
		{ published: true, key: `${a.sha}/${a.fileName}`, fileName: a.fileName, kind: a.kind! };
	if (a.inline) render.inline = true;
	return render;
}

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
	// remark-attachments (attachment spec P2 §4)
	{
		name: 'attachment-embeds',
		input: '![[song.mp3]]\n\n![[pic.png|300]] and ![[pic.png|A diagram]] and ![[clip.mp4|640x360]]\n\n![[slides.pdf#page=3]] and [[slides.pdf|the slides]] and [[song.mp3]]',
	},
	{
		name: 'attachment-markdown',
		input: '![A cat|200](Media/cat%20pic.png) and ![](<Media/cat pic.png>) and [notes **here**](Media/doc.pdf#page=2) and ![ext](https://example.com/x.png) and [abs](/Media/doc.pdf)',
	},
	{
		name: 'attachment-pdf-inline',
		input: '![[deck.pdf#page=3]]\n\n![[deck.pdf|600x800]] and ![The deck](Media/deck.pdf) and [[deck.pdf|the deck]]\n\n## Deck ![[deck.pdf]]',
	},
	{
		name: 'attachment-unpublished',
		input: '![[Media/secret.mp3]] and [[a&b>c.png]] and ![[x<y.mp3]] and [[secret.mp3|my take]] and ![x](Media/secret.mp3) and [[missing & x<y]]',
	},
	{
		name: 'attachment-heading',
		input: '## Listen ![[song.mp3]] ![[pic.png|300]]\n\ntext',
	},
	{
		name: 'attachment-mixed-paragraph',
		input: '![[pic.png]] ![[a]]\n\n![[pic.png]]\n\n![[a]]',
	},
	{
		name: 'attachment-odd-name',
		input: '![[odd "q" x<y & ü.png]] and [[odd "q" x<y & ü.png]]',
	},
	{
		name: 'attachment-in-code',
		input: '`![[song.mp3]]` and\n\n```\n![[pic.png]]\n```',
	},
];
