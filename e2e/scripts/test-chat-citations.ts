#!/usr/bin/env npx tsx
/**
 * Chat Citations + Collapse Runtime Test
 *
 * Exercises the published SPA's LLM chat widget by loading the generated
 * SITE_APP_JS into a jsdom window and driving initChat() end-to-end against a
 * stubbed SSE chat response. Pure unit test of the shipped runtime — no real
 * browser, Bedrock, or Obsidian. Mirrors the harness in test-section-anchors.ts.
 *
 * What it guards (the UX improvements in this change):
 *   - Citation links show the note TITLE (resolved via contentIndex.json /
 *     noteTitleMap), not the raw UID.
 *   - Clicking a citation opens the note as a stacked panel in #panels (reusing
 *     addPanel), rather than only mutating the URL hash.
 *   - A citation for a UID missing from the content index falls back to the raw
 *     UID as its text and still links.
 *   - The header collapse button toggles the .cpn-chat-collapsed class and swaps
 *     the chevron glyph / aria state, and clicking the collapsed header expands
 *     it — the conversation is preserved across the toggle (no full close).
 *
 * Run: npx tsx e2e/scripts/test-chat-citations.ts
 */

import { JSDOM } from 'jsdom';
import * as assetsModule from '../../src/publish/siteAssets';

// siteAssets is authored with `export const`, but under tsx's loader the named
// exports surface under a `default` wrapper. Unwrap defensively.
const assets: any =
	(assetsModule as any).SITE_APP_JS !== undefined
		? assetsModule
		: (assetsModule as any).default;
const SITE_APP_JS: string = assets.SITE_APP_JS;
const SITE_CHAT_HTML: string = assets.SITE_CHAT_HTML;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A cited UID present in the content index (resolves to a title) and one that
// is absent (must fall back to the raw UID).
const KNOWN_UID = 'ABCD1234';
const KNOWN_TITLE = 'My Great Note';
const UNKNOWN_UID = 'ZZZZ9999';

const CONTENT_INDEX = {
	[KNOWN_UID]: { title: KNOWN_TITLE, content: 'body of the note' }
};

function noteJson(uid: string) {
	return {
		uid,
		slug: uid + '-slug',
		title: uid === KNOWN_UID ? KNOWN_TITLE : 'Note ' + uid,
		hash: 'hash-' + uid,
		lastUpdated: null,
		content: '<p>note body</p>',
		backlinks: []
	};
}

function jsonResponse(obj: any) {
	return {
		ok: true,
		status: 200,
		headers: { get: () => null },
		json: async () => obj
	} as any;
}

// A ReadableStream-ish body that yields the chat SSE frames the client parses:
// one token, one citation per UID, then done. Frames are separated by a blank
// line, matching the client's `\n\n` split.
function sseChatResponse(uids: string[]) {
	const frames = [
		'data: ' + JSON.stringify({ type: 'token', text: 'Here is an answer.' }),
		...uids.map((uid) => 'data: ' + JSON.stringify({ type: 'citation', uid })),
		'data: ' + JSON.stringify({ type: 'done', conversationId: 'conv-1' })
	];
	const payload = frames.join('\n\n') + '\n\n';
	const bytes = new TextEncoder().encode(payload);
	let sent = false;
	return {
		ok: true,
		status: 200,
		headers: { get: () => null },
		body: {
			getReader() {
				return {
					async read() {
						if (sent) return { value: undefined, done: true };
						sent = true;
						return { value: bytes, done: false };
					}
				};
			}
		}
	} as any;
}

function makeFetch() {
	return async (url: string, _opts?: any) => {
		const u = String(url);
		if (u.includes('config.json')) {
			return jsonResponse({ chatEnabled: true, chatPath: '/api/chat' });
		}
		if (u.includes('/static/content/contentIndex.json')) {
			return jsonResponse(CONTENT_INDEX);
		}
		if (u.includes('/static/mapping/uid-to-hash.json')) {
			return jsonResponse({ [KNOWN_UID]: 'hash-' + KNOWN_UID, [UNKNOWN_UID]: 'hash-' + UNKNOWN_UID });
		}
		if (u.includes('/notes/')) {
			const m = u.match(/\/notes\/([^/.]+)/);
			const key = m ? m[1] : KNOWN_UID;
			// key may be a hash (hash-<uid>) or a uid; normalise to the uid.
			const uid = key.replace(/^hash-/, '');
			return jsonResponse(noteJson(uid));
		}
		if (u.includes('/api/chat')) {
			return sseChatResponse([KNOWN_UID, UNKNOWN_UID]);
		}
		return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) } as any;
	};
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const failures: string[] = [];
function check(cond: boolean, msg: string) {
	if (!cond) failures.push(msg);
}

async function nextTick(ms = 0) {
	return new Promise((r) => setTimeout(r, ms));
}

async function main() {
	const dom = new JSDOM(
		`<!DOCTYPE html><html><body>
			<div class="panels-container" id="panels"></div>
			${SITE_CHAT_HTML}
		</body></html>`,
		{ url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true }
	);

	const { window } = dom;
	const doc = window.document;
	const W = window as any;

	// --- Stubs for globals the app touches on load / during chat ---
	W.fetch = makeFetch();
	W.__CPN_CONFIG__ = { chatEnabled: true, chatPath: '/api/chat' };
	W.__CPN_CONFIG_READY__ = Promise.resolve(W.__CPN_CONFIG__);
	W.FlexSearch = {
		Document: class {
			add() {}
			async search() {
				return [];
			}
		}
	};
	if (!W.matchMedia) {
		W.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
	}
	W.HTMLElement.prototype.scrollIntoView = function () {};
	if (!W.CSS || typeof W.CSS.escape !== 'function') {
		W.CSS = { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
	}
	W.requestAnimationFrame = (cb: any) => window.setTimeout(() => cb(0), 0);
	// The chat body-signing path needs crypto.subtle.digest; jsdom exposes a
	// read-only `crypto` with no `subtle`, so plain assignment silently no-ops —
	// defineProperty is required to stub it.
	Object.defineProperty(W, 'crypto', {
		value: { subtle: { digest: async () => new ArrayBuffer(32) } },
		configurable: true
	});
	W.TextEncoder = TextEncoder;
	W.TextDecoder = TextDecoder;

	// Evaluate the real app JS and expose the internals we assert on. Do NOT
	// call initChat() manually: jsdom fires DOMContentLoaded after eval, which
	// runs the app's own initChat once. Calling it again would double-bind the
	// collapse listeners (two handlers each toggle the class, netting to no-op).
	window.eval(`
		${SITE_APP_JS}
		window.__loadedPanels = loadedPanels;
	`);

	// Let the app's own 'load' (loadPanelsFromURL) and 'DOMContentLoaded'
	// (initChat, which awaits __CPN_CONFIG_READY__) handlers settle, then reset
	// the panel stack so our assertions start from a clean slate.
	for (let i = 0; i < 6; i++) await nextTick(0);
	W.__loadedPanels.clear();
	(doc.getElementById('panels') as HTMLElement).innerHTML = '';

	// =====================================================================
	// Open the panel and submit a question (handlers are already bound).
	// =====================================================================
	const launcher = doc.getElementById('cpn-chat-launcher') as HTMLButtonElement;
	const panel = doc.getElementById('cpn-chat-panel') as HTMLElement;
	const header = doc.getElementById('cpn-chat-header') as HTMLElement;
	const collapseBtn = doc.getElementById('cpn-chat-collapse') as HTMLButtonElement;
	const form = doc.getElementById('cpn-chat-form') as HTMLFormElement;
	const input = doc.getElementById('cpn-chat-input') as HTMLTextAreaElement;

	check(!!launcher && !launcher.hidden, 'launcher revealed after initChat (chat enabled)');

	// Open the panel.
	launcher.click();
	check(!panel.hidden, 'panel opens on launcher click');
	check(launcher.hidden, 'launcher hides once panel is open');

	// Ask a question — the stubbed SSE response streams a token + two citations.
	input.value = 'what is this?';
	form.dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));

	// Let the async fetch + stream read + renderCitations (awaits loadNoteIndexOnce) settle.
	for (let i = 0; i < 10; i++) await nextTick(0);

	// =====================================================================
	// Case 1 — citations resolve UID -> title, missing UID falls back to UID
	// =====================================================================
	const citationLinks = Array.from(
		panel.querySelectorAll('.cpn-chat-citations a')
	) as HTMLAnchorElement[];
	check(citationLinks.length === 2, `C1: two citation links rendered (got ${citationLinks.length})`);

	const knownLink = citationLinks.find((a) => a.getAttribute('href') === '#/u' + KNOWN_UID);
	const unknownLink = citationLinks.find((a) => a.getAttribute('href') === '#/u' + UNKNOWN_UID);
	check(!!knownLink, 'C1: known citation link has href #/u<uid>');
	check(!!knownLink && knownLink.textContent === KNOWN_TITLE, `C1: known citation shows the title (got "${knownLink?.textContent}")`);
	check(!!unknownLink, 'C1: unknown citation link exists');
	check(!!unknownLink && unknownLink.textContent === UNKNOWN_UID, `C1: unknown citation falls back to raw UID (got "${unknownLink?.textContent}")`);

	// =====================================================================
	// Case 2 — clicking a citation opens a stacked panel via addPanel
	// =====================================================================
	check(W.__loadedPanels.size === 0, 'C2: no panels open before clicking a citation');
	knownLink!.click();
	for (let i = 0; i < 6; i++) await nextTick(0);

	const opened = doc.querySelector('#panels .panel[data-param-type="u"]') as HTMLElement;
	check(!!opened, 'C2: clicking a citation appended a note panel to #panels');
	check(W.__loadedPanels.has('u-' + KNOWN_UID), 'C2: panel registered as u-<uid> in loadedPanels');

	// =====================================================================
	// Case 3 — collapse toggle preserves the conversation (no full close)
	// =====================================================================
	const msgCountBefore = panel.querySelectorAll('.cpn-chat-msg').length;
	check(msgCountBefore >= 2, 'C3: user + assistant messages present before collapse');

	collapseBtn.click();
	check(panel.classList.contains('cpn-chat-collapsed'), 'C3: collapse button adds .cpn-chat-collapsed');
	check(!panel.hidden, 'C3: panel is NOT hidden (collapsed, not closed)');
	check(launcher.hidden, 'C3: launcher does NOT return on collapse');
	check(collapseBtn.textContent === '⌃', 'C3: glyph flips to up-chevron when collapsed');
	check(collapseBtn.getAttribute('aria-expanded') === 'false', 'C3: aria-expanded=false when collapsed');
	check(
		panel.querySelectorAll('.cpn-chat-msg').length === msgCountBefore,
		'C3: messages preserved while collapsed'
	);

	// Clicking the collapsed header expands it again.
	header.click();
	check(!panel.classList.contains('cpn-chat-collapsed'), 'C3: clicking header expands the panel');
	check(collapseBtn.textContent === '⌄', 'C3: glyph flips back to down-chevron when expanded');
	check(collapseBtn.getAttribute('aria-expanded') === 'true', 'C3: aria-expanded=true when expanded');
	check(
		panel.querySelectorAll('.cpn-chat-msg').length === msgCountBefore,
		'C3: conversation intact after expand'
	);

	report();
}

function report() {
	if (failures.length === 0) {
		console.log('All chat-citation runtime cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} chat-citation assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
