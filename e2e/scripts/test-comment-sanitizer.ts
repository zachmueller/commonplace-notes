#!/usr/bin/env npx tsx
/**
 * Comment Markdown Sanitizer Adversarial Test
 *
 * The published comment client renders attacker-controlled Markdown from a
 * world-readable, CDN-cached JSON file, so its safe-subset renderer is the sole
 * XSS boundary. This loads the shipped SITE_APP_JS into a jsdom window and
 * exercises renderMarkdown() against injection payloads, asserting that no
 * executable/dangerous HTML survives while the safe subset still renders.
 *
 * Pure unit test of the shipped runtime — no real browser or Obsidian.
 * Mirrors the harness in test-note-params.ts.
 *
 * Run: npx tsx e2e/scripts/test-comment-sanitizer.ts
 */

import { JSDOM } from 'jsdom';
import * as assetsModule from '../../src/publish/siteAssets';

const assets: any =
	(assetsModule as any).SITE_APP_JS !== undefined
		? assetsModule
		: (assetsModule as any).default;
const SITE_APP_JS: string = assets.SITE_APP_JS;

const failures: string[] = [];
function check(cond: boolean, msg: string) {
	if (!cond) failures.push(msg);
}

function main() {
	const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
	const win: any = dom.window;

	// Execute the app JS in the jsdom window context. Its top-level `function`
	// declarations (renderMarkdown, renderInline, escapeHtml) become window
	// properties. The script wires DOM listeners on load; that is harmless here.
	try {
		win.eval(SITE_APP_JS);
	} catch (err) {
		// The app may throw while wiring listeners against a bare DOM; the
		// function declarations are still hoisted onto the window before any throw
		// at the bottom of the script — but if renderMarkdown is missing, fail.
	}

	const renderMarkdown: (s: string) => string = win.renderMarkdown;
	if (typeof renderMarkdown !== 'function') {
		failures.push('renderMarkdown was not exposed on the window — cannot run sanitizer tests');
		return report();
	}

	const mustNotContain = (input: string, needle: string, label: string) => {
		const out = renderMarkdown(input).toLowerCase();
		check(!out.includes(needle.toLowerCase()), `${label}: output must not contain "${needle}" — got: ${out}`);
	};
	const mustContain = (input: string, needle: string, label: string) => {
		const out = renderMarkdown(input);
		check(out.includes(needle), `${label}: output should contain "${needle}" — got: ${out}`);
	};

	// --- XSS payloads must be neutralized ---
	mustNotContain('<script>alert(1)</script>', '<script', 'raw <script> escaped');
	mustNotContain('<img src=x onerror=alert(1)>', '<img', 'raw <img> escaped (no live element)');
	// The literal text "onerror" may survive *escaped* (it is inert inside
	// &lt;img&gt;); what must never appear is a live element carrying it.
	mustNotContain('<img src=x onerror=alert(1)>', '<img src=x onerror', 'no live img with event handler');
	mustNotContain('[click](javascript:alert(1))', 'javascript:', 'javascript: link dropped');
	mustNotContain('[x](data:text/html;base64,PHNjcmlwdD4=)', 'data:', 'data: link dropped');
	mustNotContain('<a href="javascript:alert(1)">x</a>', '<a href="javascript', 'raw anchor escaped');
	mustNotContain('<iframe src=evil></iframe>', '<iframe', 'iframe escaped');
	mustNotContain('<svg/onload=alert(1)>', '<svg', 'svg escaped');
	mustNotContain('plain & <b>bold</b>', '<b>', 'raw <b> passthrough blocked');

	// --- Safe subset must still render ---
	mustContain('**bold**', '<strong>bold</strong>', 'bold renders');
	mustContain('*italic*', '<em>italic</em>', 'italic renders');
	mustContain('__bold__', '<strong>bold</strong>', 'underscore bold renders');
	mustContain('_italic_', '<em>italic</em>', 'underscore italic renders');
	// CommonMark: underscores inside a word are NOT emphasis (unlike asterisks).
	mustNotContain('foo_bar_baz', '<em>', 'intraword single underscore stays literal');
	mustNotContain('snake_case_name', '<em>', 'snake_case stays literal');
	mustNotContain('a__b__c', '<strong>', 'intraword double underscore stays literal');
	// Underscores in a link path are guarded on both sides and left intact.
	mustContain('[x](https://e.com/a_b_c)', 'href="https://e.com/a_b_c"', 'underscores in link path preserved');
	mustContain('`code`', '<code>code</code>', 'code span renders');
	mustContain('[CPN](https://example.com)', 'href="https://example.com"', 'https link renders');
	mustContain('[mail](mailto:a@b.com)', 'href="mailto:a@b.com"', 'mailto link renders');
	mustContain('hello world', '<p>hello world</p>', 'paragraph wraps');
	{
		const out = renderMarkdown('- one\n- two');
		check(out.includes('<ul>') && out.includes('<li>one</li>'), `list renders — got: ${out}`);
	}
	// A safe link must carry rel/nofollow hardening.
	mustContain('[x](https://e.com)', 'rel="nofollow noopener noreferrer"', 'links hardened with rel');

	// --- [[UID]] wikilink note-links ---
	// Seed a known uid->title mapping. setNoteIndex is a hoisted function on the
	// window; it populates the noteTitleMap that renderInline resolves against.
	// UIDs are Crockford Base32 (uppercase A-Z minus I/L/O/U, plus digits).
	if (typeof win.setNoteIndex === 'function') {
		win.setNoteIndex({
			JVZ6KPM29N: { title: 'My Note', content: '' },
			// Valid Crockford Base32 UID (no I/L/O/U) whose title carries raw HTML.
			ESCAPE0TST: { title: 'A <b>bold</b> title', content: '' },
		});

		// Resolved UID -> in-site note anchor with the CURRENT title as link text.
		mustContain('[[JVZ6KPM29N]]', 'href="#/uJVZ6KPM29N"', 'resolved wikilink emits #/u note anchor');
		mustContain('[[JVZ6KPM29N]]', 'class="comment-wikilink"', 'resolved wikilink carries comment-wikilink class');
		mustContain('[[JVZ6KPM29N]]', '>My Note<', 'resolved wikilink shows the current title');
		mustNotContain('[[JVZ6KPM29N]]', '[[jvz6kpm29n]]', 'resolved wikilink leaves no raw [[UID]] text');
		// The resolved title is author-controlled and must pass through escapeHtml.
		mustNotContain('[[ESCAPE0TST]]', '<b>bold</b>', 'wikilink title is escaped (no raw HTML)');
		mustContain('[[ESCAPE0TST]]', '&lt;b&gt;bold&lt;/b&gt;', 'wikilink title escaped entities present');

		// Unknown UID (valid shape, not in the index) -> greyed-out inert span.
		mustContain('[[ABCDEF1234]]', 'class="unpublished-link"', 'unresolved wikilink is greyed-out');
		mustNotContain('[[ABCDEF1234]]', 'href="#/u', 'unresolved wikilink is not a live link');
	} else {
		failures.push('setNoteIndex was not exposed on the window — cannot test wikilink rendering');
	}

	// A [[ ]] token that is NOT a valid UID must never become a link and must
	// stay escaped. This guards the XSS boundary: [[<script>]] and [[Some Title]]
	// fall through the strict UID regex untouched.
	mustNotContain('[[<script>alert(1)</script>]]', '<script', 'non-UID wikilink stays escaped (no live script)');
	mustNotContain('[[<script>alert(1)</script>]]', 'href="#/u', 'non-UID wikilink is not a link');
	mustNotContain('[[<script>alert(1)</script>]]', 'unpublished-link', 'non-UID wikilink is not treated as a UID');
	mustNotContain('[[Some Title]]', 'href="#/u', 'lowercase/spaced wikilink is not a UID link');

	// --- Comment editor chip serialize/deserialize round-trip ---
	// The composer/reply/edit inputs are contenteditable editors that show a
	// [[UID]] link as a name chip while serializing back to the exact [[UID]]
	// Markdown that is stored. getValue() must be byte-identical to what the old
	// <textarea> produced, so nothing downstream (backend/render) changes.
	const buildCommentEditor = win.buildCommentEditor;
	if (typeof buildCommentEditor === 'function' && typeof win.setNoteIndex === 'function') {
		win.setNoteIndex({
			JVZ6KPM29N: { title: 'My Note', content: '' },
			ABCDEF1234: { title: 'Second Note', content: '' },
		});

		// setValue deserializes [[UID]] into chips; getValue serializes back.
		const ed = buildCommentEditor('see [[JVZ6KPM29N]] here', '');
		const chips = ed.el.querySelectorAll('.comment-chip[data-uid="JVZ6KPM29N"]');
		check(chips.length === 1, `editor renders one chip for the UID — got ${chips.length}`);
		check(chips.length === 1 && chips[0].textContent === 'My Note',
			`chip shows the note title — got: ${chips.length ? chips[0].textContent : '(none)'}`);
		check(ed.getValue() === 'see [[JVZ6KPM29N]] here',
			`round-trips a single link — got: ${JSON.stringify(ed.getValue())}`);

		// Two links plus surrounding text.
		const md2 = 'a [[JVZ6KPM29N]] b [[ABCDEF1234]] c';
		const ed2 = buildCommentEditor(md2, '');
		check(ed2.el.querySelectorAll('.comment-chip').length === 2,
			`two links -> two chips — got ${ed2.el.querySelectorAll('.comment-chip').length}`);
		check(ed2.getValue() === md2, `round-trips two links — got: ${JSON.stringify(ed2.getValue())}`);

		// An unknown-but-valid UID still becomes a chip (labeled with the raw UID)
		// and round-trips unchanged.
		const ed3 = buildCommentEditor('x [[ZZZZZZ9999]] y', '');
		check(ed3.el.querySelectorAll('.comment-chip[data-uid="ZZZZZZ9999"]').length === 1,
			'unknown UID still becomes a chip');
		check(ed3.getValue() === 'x [[ZZZZZZ9999]] y',
			`unknown-UID chip round-trips — got: ${JSON.stringify(ed3.getValue())}`);

		// clear() empties the editor (so :empty placeholder shows).
		ed.clear();
		check(ed.getValue() === '', `clear() empties the editor — got: ${JSON.stringify(ed.getValue())}`);

		// Chip title is set via textContent, never innerHTML — no HTML injection.
		// (UID is valid Crockford Base32: no I/L/O/U.)
		win.setNoteIndex({ HTM0CHP123: { title: '<img src=x onerror=alert(1)>', content: '' } });
		const ed4 = buildCommentEditor('[[HTM0CHP123]]', '');
		check(!/<img/i.test(ed4.el.innerHTML), 'chip title is not injected as raw HTML');
		check(ed4.getValue() === '[[HTM0CHP123]]',
			`chip with HTML-ish title still round-trips as UID — got: ${JSON.stringify(ed4.getValue())}`);
	} else {
		failures.push('buildCommentEditor/setNoteIndex not exposed on the window — cannot test chip round-trip');
	}

	report();
}

function report() {
	if (failures.length === 0) {
		console.log('All comment sanitizer cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} sanitizer assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main();
