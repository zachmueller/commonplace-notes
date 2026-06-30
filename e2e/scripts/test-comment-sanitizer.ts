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
