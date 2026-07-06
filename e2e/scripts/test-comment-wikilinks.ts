#!/usr/bin/env npx tsx
/**
 * Recent Comments panel [[UID]] link rewrite test.
 *
 * The author-facing Recent Comments panel rewrites bare [[UID]] note-links in
 * comment bodies into [[<linktext>|<Title>]] (resolvable UID) or plain UID text
 * (unresolvable) BEFORE handing the body to Obsidian's Markdown renderer, so the
 * link shows the note's current title and opens the correct local note. This
 * exercises the pure string rewrite (rewriteCommentWikilinks) with a stub
 * resolver — no Obsidian, no vault, no DOM.
 *
 * Run: npx tsx e2e/scripts/test-comment-wikilinks.ts
 */

import * as commentWikilinksModule from '../../src/utils/commentWikilinks';
import type { CommentLinkResolver } from '../../src/utils/commentWikilinks';

// Under tsx's loader a `export const`/`export function` module can surface its
// named exports under a `default` wrapper; unwrap defensively (mirrors the
// siteAssets import in the sibling comment tests).
const mod: any =
	(commentWikilinksModule as any).rewriteCommentWikilinks !== undefined
		? commentWikilinksModule
		: (commentWikilinksModule as any).default;
const rewriteCommentWikilinks: (md: string, resolve: CommentLinkResolver) => string =
	mod.rewriteCommentWikilinks;

const failures: string[] = [];
function check(cond: boolean, msg: string) {
	if (!cond) failures.push(msg);
}

function main() {
	// Stub resolver: two known UIDs, everything else unresolved.
	const resolve: CommentLinkResolver = (uid) => {
		if (uid === 'JVZ6KPM29N') return { linktext: 'Notes/My Note', title: 'My Note' };
		if (uid === 'ABCDEF1234') return { linktext: 'Second Note', title: 'Second Note' };
		if (uid === 'P1PE0T2T3E') return { linktext: 'Weird', title: 'a|b] [c' };
		return null;
	};

	// Resolved UID -> [[linktext|Title]].
	check(
		rewriteCommentWikilinks('see [[JVZ6KPM29N]] here', resolve) === 'see [[Notes/My Note|My Note]] here',
		`resolved UID rewrites to [[linktext|Title]] — got: ${rewriteCommentWikilinks('see [[JVZ6KPM29N]] here', resolve)}`,
	);

	// Unresolved (valid-shape) UID -> plain UID text, no brackets.
	{
		const out = rewriteCommentWikilinks('x [[ZZZZZZ9999]] y', resolve);
		check(out === 'x ZZZZZZ9999 y', `unresolved UID becomes plain text — got: ${out}`);
		check(!out.includes('[[') && !out.includes(']]'), 'unresolved UID leaves no wikilink brackets');
	}

	// Two links + surrounding text: both rewrite, text preserved.
	{
		const out = rewriteCommentWikilinks('a [[JVZ6KPM29N]] b [[ABCDEF1234]] c', resolve);
		check(
			out === 'a [[Notes/My Note|My Note]] b [[Second Note|Second Note]] c',
			`two links both rewrite — got: ${out}`,
		);
	}

	// Non-UID wikilinks are left untouched (lowercase, spaces, headings, aliases).
	check(
		rewriteCommentWikilinks('[[Some Note]]', resolve) === '[[Some Note]]',
		'spaced/titled wikilink is left untouched',
	);
	check(
		rewriteCommentWikilinks('[[folder/Note#Heading|alias]]', resolve) === '[[folder/Note#Heading|alias]]',
		'path/heading/alias wikilink is left untouched',
	);
	check(
		rewriteCommentWikilinks('[[lowercase]]', resolve) === '[[lowercase]]',
		'lowercase (non-Crockford) wikilink is left untouched',
	);

	// Alias sanitization: a title containing | or ] must not break the wikilink.
	{
		// title 'a|b] [c' -> strip []| -> 'a b  c' -> collapse whitespace -> 'a b c'.
		const out = rewriteCommentWikilinks('[[P1PE0T2T3E]]', resolve);
		check(out === '[[Weird|a b c]]', `title with |/] is sanitized in the alias — got: ${out}`);
		// Exactly one opening + one closing bracket pair (well-formed link).
		check((out.match(/\[\[/g) || []).length === 1 && (out.match(/\]\]/g) || []).length === 1,
			`sanitized link stays well-formed — got: ${out}`);
	}

	// A body with no wikilinks is returned unchanged.
	check(
		rewriteCommentWikilinks('just some **markdown** text', resolve) === 'just some **markdown** text',
		'body without wikilinks is unchanged',
	);

	report();
}

function report() {
	if (failures.length === 0) {
		console.log('All comment wikilink rewrite cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} comment wikilink assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main();
