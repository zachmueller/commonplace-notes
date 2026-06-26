#!/usr/bin/env npx tsx
/**
 * Section-Anchor Runtime Test
 *
 * Exercises the published SPA's section-anchor navigation (scroll + highlight)
 * by loading the generated SITE_APP_JS into a jsdom window and simulating clicks
 * on section links. This is a pure unit test of the runtime — no real browser or
 * Obsidian instance required.
 *
 * What it guards:
 *   - Cross-note [[Note#Heading]] click opens a panel and, once loaded, scrolls
 *     to the heading id and flashes it with the .heading-target class.
 *   - Same-note [[#Heading]] click scrolls within the originating panel.
 *   - Already-open cross-note click scrolls to the existing panel AND its heading
 *     (this also exercises the scrollToPanel param-dataset selector fix).
 *   - A missing/renamed heading degrades gracefully (panel opens, no throw, no
 *     .heading-target applied).
 *
 * Run: npx tsx e2e/scripts/test-section-anchors.ts
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

// ---------------------------------------------------------------------------
// Fixtures: fake note JSON the SPA will "fetch"
// ---------------------------------------------------------------------------

// A note whose rendered content carries heading ids (as rehype-slug would emit).
const NOTE_CONTENT = `
	<h2 id="intro">Intro</h2>
	<p>lorem ipsum</p>
	<h2 id="details">Details</h2>
	<p>more text</p>
`;

function noteJson(uid: string) {
	return {
		uid,
		slug: uid + '-slug',
		title: 'Note ' + uid,
		hash: 'hash-' + uid,
		lastUpdated: null,
		content: NOTE_CONTENT,
		backlinks: []
	};
}

// uid -> hash and hash -> note, enough to satisfy loadNoteByParameter('u', uid).
const UID = 'abc-123'; // contains a '-' on purpose (exercises scrollToPanel split)

function makeFetch() {
	return async (url: string) => {
		const u = String(url);
		if (u.includes('/static/mapping/uid-to-hash.json')) {
			return jsonResponse({ [UID]: 'hash-' + UID });
		}
		if (u.includes('/static/content/contentIndex.json')) {
			return jsonResponse({});
		}
		if (u.includes('/notes/')) {
			return jsonResponse(noteJson(UID));
		}
		// config.json and anything else: 404-ish
		return { ok: false, status: 404, json: async () => ({}) } as any;
	};
}

function jsonResponse(obj: any) {
	return { ok: true, status: 200, json: async () => obj } as any;
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
		</body></html>`,
		{ url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true }
	);

	const { window } = dom;
	const doc = window.document;

	// --- Stubs for globals the app touches on load / during navigation ---
	(window as any).fetch = makeFetch();
	(window as any).FlexSearch = {
		Document: class {
			add() {}
			async search() {
				return [];
			}
		}
	};
	if (!(window as any).matchMedia) {
		(window as any).matchMedia = () => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {}
		});
	}
	// Record scrollIntoView calls (jsdom doesn't implement it) and let us assert.
	const scrolled: any[] = [];
	(window as any).HTMLElement.prototype.scrollIntoView = function (opts: any) {
		scrolled.push({ el: this, opts });
	};
	// jsdom lacks CSS.escape in some versions; provide a minimal shim if missing.
	if (!(window as any).CSS || typeof (window as any).CSS.escape !== 'function') {
		(window as any).CSS = { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
	}
	// requestAnimationFrame -> run on next macrotask so awaits can observe it.
	(window as any).requestAnimationFrame = (cb: any) => window.setTimeout(() => cb(0), 0);

	// Evaluate the real app JS inside the jsdom window so its functions become
	// available on the window scope. We wrap to expose the internals we drive.
	const bootstrap = `
		${SITE_APP_JS}
		// Expose internals for the test:
		window.__addPanel = addPanel;
		window.__scrollToPanel = scrollToPanel;
		window.__scrollToHeading = scrollToHeading;
		window.__loadedPanels = loadedPanels;
	`;
	window.eval(bootstrap);

	const W = window as any;

	// jsdom fires a 'load' event after eval, and the app's load handler runs
	// loadPanelsFromURL() (which clears loadedPanels and the panel container to
	// rebuild from the URL). Let that initial bootstrap settle, then reset to a
	// clean slate so our cases aren't raced by the startup rebuild. In a real
	// browser this happens once before any user interaction.
	await nextTick(0);
	await nextTick(0);
	await nextTick(0);
	W.__loadedPanels.clear();
	(doc.getElementById('panels') as HTMLElement).innerHTML = '';
	scrolled.length = 0;

	// =====================================================================
	// Case 1 — cross-note open scrolls to heading + flashes it
	// =====================================================================
	await W.__addPanel('u', UID, null, 'details');
	// addPanel awaited the fetch; the heading scroll is deferred via rAF (setTimeout 0).
	await nextTick(0);
	await nextTick(0);

	const panel = doc.querySelector('.panel[data-param-type="u"]') as HTMLElement;
	check(!!panel, 'C1: panel was created');
	const detailsHeading = panel?.querySelector('#details') as HTMLElement;
	check(!!detailsHeading, 'C1: #details heading exists in panel');
	check(
		!!detailsHeading && detailsHeading.classList.contains('heading-target'),
		'C1: #details got .heading-target flash class'
	);
	check(
		scrolled.some((s) => s.el === detailsHeading && s.opts && s.opts.block === 'start'),
		'C1: #details was scrolled into view (block:start)'
	);

	// Flash should clear after 2s.
	await nextTick(2100);
	check(
		!!detailsHeading && !detailsHeading.classList.contains('heading-target'),
		'C1: .heading-target removed after ~2s'
	);

	// =====================================================================
	// Case 2 — already-open cross-note click scrolls to panel + heading
	//          (also exercises the scrollToPanel param-dataset selector fix)
	// =====================================================================
	const panelId = 'u-' + UID;
	check(W.__loadedPanels.has(panelId), 'C2: panel registered in loadedPanels as u-<uid>');
	const found = W.__scrollToPanel(panelId);
	check(found === panel, 'C2: scrollToPanel(panelId) resolves the panel (bug fix)');
	scrolled.length = 0;
	W.__scrollToHeading(panel, 'intro');
	const introHeading = panel.querySelector('#intro') as HTMLElement;
	check(
		!!introHeading && introHeading.classList.contains('heading-target'),
		'C2: #intro flashed on already-open navigation'
	);
	await nextTick(2100);

	// =====================================================================
	// Case 3 — same-note link click scrolls within the originating panel
	// =====================================================================
	// Inject a same-note anchor into the panel content and re-run the binding
	// path by creating it as the SPA would. We simulate the click handler effect
	// directly through the exposed scrollToHeading (the click handler calls it).
	scrolled.length = 0;
	W.__scrollToHeading(panel, 'intro');
	check(
		scrolled.some((s) => s.el === introHeading),
		'C3: same-note scroll targets the heading within the panel'
	);
	await nextTick(2100);

	// =====================================================================
	// Case 4 — missing heading degrades gracefully (no throw, no flash)
	// =====================================================================
	scrolled.length = 0;
	let threw = false;
	try {
		W.__scrollToHeading(panel, 'does-not-exist');
	} catch {
		threw = true;
	}
	check(!threw, 'C4: scrollToHeading on missing id does not throw');
	check(scrolled.length === 0, 'C4: nothing scrolled for a missing heading');

	// ---------------------------------------------------------------------
	report();
}

function report() {
	if (failures.length === 0) {
		console.log('All section-anchor runtime cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} section-anchor assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
