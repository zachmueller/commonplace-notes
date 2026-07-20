#!/usr/bin/env npx tsx
/**
 * Diff-viewer (;diff=) Round-Trip Test
 *
 * Exercises the published SPA's `;diff=` sub-parameter (e.g. `#/uABC;diff=pHASH`)
 * by loading the generated SITE_APP_JS into a jsdom window. Pure unit test of the
 * shipped runtime — no real browser or Obsidian.
 *
 * The vendored libraries (jsdiff `Diff`, diff2html `Diff2Html`) are STUBBED in the
 * jsdom window so this test verifies the SPA's WIRING (resolution, orientation,
 * panel identity, URL round-trip, graceful degradation) rather than the libraries'
 * own diff math. A separate browser e2e verifies real rendering + CSS.
 *
 * What it guards:
 *   - parseURLFragment surfaces `;diff=` as params.diff on the segment.
 *   - panelKey folds the diff target into the identity key, so a plain note and a
 *     diffed note are distinct panels (don't dedupe against each other).
 *   - resolveHash resolves t/~/u/p (~ is an alias for t) and throws on unknown types.
 *   - addPanel with params.diff builds a diff (left=target/old, right=base/new),
 *     renders a .diff-body, stores data-diff + data-panel-id, skips comments, and
 *     round-trips `;diff=` through updateURL.
 *   - A malformed/unresolvable diff target degrades to the base note (no .diff-body,
 *     not an error panel); identical versions show a non-fatal notice.
 *
 * Mirrors the harness in test-note-params.ts.
 *
 * Run: npx tsx e2e/scripts/test-diff-params.ts
 */

import { JSDOM } from 'jsdom';
import * as assetsModule from '../../src/publish/siteAssets';

const assets: any =
	(assetsModule as any).SITE_APP_JS !== undefined
		? assetsModule
		: (assetsModule as any).default;
const SITE_APP_JS: string = assets.SITE_APP_JS;

// ---------------------------------------------------------------------------
// Fixtures: fake note JSON the SPA will "fetch"
// ---------------------------------------------------------------------------

const UID = 'abc-123'; // contains a '-' on purpose (exercises panelId handling)
const SLUG = 'my-slug'; // slug that maps to UID via slug-to-uid.json
const CUR_HASH = 'hashcurrent000'; // current published version of UID
const PRIOR_HASH = 'hashprior0000'; // its prior version

// Two versions with genuinely different `raw` so a diff is non-empty.
const RAW_CURRENT = 'line one\nline two changed\nline three\n';
const RAW_PRIOR = 'line one\nline two\n';

function noteJson(hash: string, raw: string, priorHash: string | null) {
	return {
		uid: UID,
		slug: '', // empty slug → URL is just the param path (no decorative prefix)
		title: 'Note ' + UID,
		hash,
		priorHash,
		lastUpdated: null,
		content: '<p>body</p>',
		raw,
		backlinks: []
	};
}

// Minimal Headers stub so the app's cpnAuthGate (reads response.headers.get(...))
// can run against these fixtures without throwing. No auth header / content-type
// means "not gated", which is correct for plain JSON data responses.
const noHeaders = { get: (_name: string) => null };

function jsonResponse(obj: any) {
	return { ok: true, status: 200, headers: noHeaders, json: async () => obj } as any;
}

function makeFetch() {
	return async (url: string) => {
		const u = String(url);
		if (u.includes('/static/mapping/uid-to-hash.json')) {
			return jsonResponse({ [UID]: CUR_HASH });
		}
		if (u.includes('/static/mapping/slug-to-uid.json')) {
			return jsonResponse({ [SLUG]: UID });
		}
		if (u.includes('/static/content/contentIndex.json')) {
			return jsonResponse({});
		}
		if (u.includes(`/notes/${CUR_HASH}.json`)) {
			return jsonResponse(noteJson(CUR_HASH, RAW_CURRENT, PRIOR_HASH));
		}
		if (u.includes(`/notes/${PRIOR_HASH}.json`)) {
			return jsonResponse(noteJson(PRIOR_HASH, RAW_PRIOR, null));
		}
		// Any other note hash (e.g. an unresolvable diff target) → 404.
		return { ok: false, status: 404, headers: noHeaders, json: async () => ({}) } as any;
	};
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const failures: string[] = [];
function check(cond: boolean, msg: string) {
	if (!cond) failures.push(msg);
}
function eq(actual: unknown, expected: unknown, msg: string) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) failures.push(`${msg} (expected ${e}, got ${a})`);
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
	(window as any).HTMLElement.prototype.scrollIntoView = function () {};
	if (!(window as any).CSS || typeof (window as any).CSS.escape !== 'function') {
		(window as any).CSS = { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
	}
	(window as any).requestAnimationFrame = (cb: any) => window.setTimeout(() => cb(0), 0);

	// --- Stub the vendored diff libraries (we test wiring, not their math) ---
	// Capture the exact args createTwoFilesPatch is called with so the test can
	// assert orientation (old/left = target.raw, new/right = base.raw).
	const diffCalls: any[] = [];
	(window as any).Diff = {
		createTwoFilesPatch: (oldName: string, newName: string, oldStr: string, newStr: string) => {
			diffCalls.push({ oldName, newName, oldStr, newStr });
			return `PATCH(${oldName}->${newName})`;
		}
	};
	const d2hCalls: any[] = [];
	(window as any).Diff2Html = {
		html: (patch: string, opts: any) => {
			d2hCalls.push({ patch, opts });
			return `<div class="d2h-wrapper">stub for ${patch}</div>`;
		}
	};

	// Evaluate the real app JS inside the jsdom window and expose internals.
	const bootstrap = `
		${SITE_APP_JS}
		window.__parseURLFragment = parseURLFragment;
		window.__updateURL = updateURL;
		window.__addPanel = addPanel;
		window.__loadedPanels = loadedPanels;
		window.__panelKey = panelKey;
		window.__resolveHash = resolveHash;
	`;
	window.eval(bootstrap);

	const W = window as any;

	// Let the initial load handler settle, then reset to a clean slate.
	await nextTick(0);
	await nextTick(0);
	await nextTick(0);
	W.__loadedPanels.clear();
	(doc.getElementById('panels') as HTMLElement).innerHTML = '';
	window.history.replaceState(null, '', '/');

	// =====================================================================
	// A. parseURLFragment surfaces ;diff= as params.diff
	// =====================================================================
	eq(
		W.__parseURLFragment('#/uABC;diff=pHASH'),
		[{ type: 'u', value: 'ABC', params: { diff: 'pHASH' } }],
		'A1: ;diff= parsed into params.diff'
	);
	eq(
		W.__parseURLFragment('#/uABC;diff=pHASH;width=800')[0].params,
		{ diff: 'pHASH', width: '800' },
		'A2: ;diff= coexists with ;width='
	);

	// =====================================================================
	// B. panelKey folds the diff target into the identity key
	// =====================================================================
	eq(W.__panelKey('u', 'ABC', {}), 'u-ABC', 'B1: plain note key');
	eq(W.__panelKey('u', 'ABC', { diff: 'pHASH' }), 'u-ABC;diff=pHASH', 'B2: diff key includes target');
	check(
		W.__panelKey('u', 'ABC', { diff: 'pHASH' }) !== W.__panelKey('u', 'ABC', {}),
		'B3: diff and plain keys differ'
	);

	// =====================================================================
	// C. resolveHash resolves t/~/u/p and throws on unknown
	// =====================================================================
	eq(await W.__resolveHash('p', 'literalhash'), 'literalhash', 'C1: p resolves to itself');
	eq(await W.__resolveHash('u', UID), CUR_HASH, 'C2: u resolves via uid-to-hash');
	eq(await W.__resolveHash('t', SLUG), CUR_HASH, 'C2t: t resolves via slug-to-uid → uid-to-hash');
	eq(await W.__resolveHash('~', SLUG), CUR_HASH, 'C2~: ~ is an alias for t (same resolution)');
	{
		let threw = false;
		try { await W.__resolveHash('z', 'x'); } catch { threw = true; }
		check(threw, 'C3: unknown type throws (deprecated d falls here too)');
	}
	{
		let threw = false;
		try { await W.__resolveHash('d', 'x'); } catch { threw = true; }
		check(threw, 'C4: legacy d type throws (no longer a stub)');
	}

	// =====================================================================
	// D. addPanel with ;diff= renders a diff panel (orientation + wiring)
	// =====================================================================
	diffCalls.length = 0;
	d2hCalls.length = 0;
	await W.__addPanel('u', UID, null, null, { diff: 'p' + PRIOR_HASH });
	await nextTick(0);
	{
		const panel = doc.querySelector('.panel') as HTMLElement;
		check(!!panel, 'D1: diff panel created');
		check(!!panel?.querySelector('.diff-body'), 'D2: panel has a .diff-body');
		check(!panel?.classList.contains('error'), 'D3: diff panel is not an error panel');
		eq(panel?.dataset.diff, 'p' + PRIOR_HASH, 'D4: data-diff stores the target');
		eq(panel?.dataset.panelId, `u-${UID};diff=p${PRIOR_HASH}`, 'D5: data-panel-id is the diff key');
		// Comments region must NOT be present on a diff panel.
		check(!panel?.querySelector('.comments'), 'D6: diff panel has no comments region');
		// Orientation: old/left = target (prior) raw, new/right = base (current) raw.
		check(diffCalls.length === 1, 'D7: createTwoFilesPatch called once');
		eq(diffCalls[0]?.oldStr, RAW_PRIOR, 'D8: left/old side is the diff target (prior) raw');
		eq(diffCalls[0]?.newStr, RAW_CURRENT, 'D9: right/new side is the base (current) raw');
		eq(diffCalls[0]?.oldName, PRIOR_HASH, 'D10: old label is the target hash');
		eq(diffCalls[0]?.newName, CUR_HASH, 'D11: new label is the base hash');
		// diff2html invoked side-by-side with word matching.
		eq(d2hCalls[0]?.opts?.outputFormat, 'side-by-side', 'D12: side-by-side output');
		eq(d2hCalls[0]?.opts?.matching, 'words', 'D13: word-level matching');
		// URL round-trip.
		W.__updateURL(true);
		eq(window.location.hash, `#/u${UID};diff=p${PRIOR_HASH}`, 'D14: updateURL re-emits ;diff=');
	}

	// =====================================================================
	// E. A diff panel and the plain note coexist (distinct keys)
	// =====================================================================
	await W.__addPanel('u', UID); // plain note, no diff
	await nextTick(0);
	{
		const panels = doc.querySelectorAll('.panel');
		eq(panels.length, 2, 'E1: plain note opens as a SEPARATE panel from the diff');
		// The plain panel has content, no diff-body.
		const plain = Array.from(panels).find(p => !(p as HTMLElement).dataset.diff) as HTMLElement;
		check(!!plain?.querySelector('.content'), 'E2: plain panel renders note content');
		check(!plain?.querySelector('.diff-body'), 'E3: plain panel has no diff-body');
	}

	// =====================================================================
	// E2. Re-requesting the SAME diff dedupes (no second panel)
	// =====================================================================
	await W.__addPanel('u', UID, null, null, { diff: 'p' + PRIOR_HASH });
	await nextTick(0);
	eq(doc.querySelectorAll('.panel').length, 2, 'E4: re-opening same diff does not add a panel');

	// Reset.
	W.__loadedPanels.clear();
	(doc.getElementById('panels') as HTMLElement).innerHTML = '';
	window.history.replaceState(null, '', '/');

	// =====================================================================
	// F. Graceful degradation: unresolvable diff target → base note only
	// =====================================================================
	await W.__addPanel('u', UID, null, null, { diff: 'pdoesnotexist' });
	await nextTick(0);
	{
		const panel = doc.querySelector('.panel') as HTMLElement;
		check(!!panel, 'F1: panel still created on bad diff target');
		check(!panel?.classList.contains('error'), 'F2: bad diff does NOT error the panel');
		check(!panel?.querySelector('.diff-body'), 'F3: no diff-body on failed diff');
		check(!!panel?.querySelector('.content'), 'F4: base note content rendered instead');
		check(!!panel?.querySelector('.diff-notice'), 'F5: a non-fatal notice is shown');
		check(!panel?.dataset.diff, 'F6: no data-diff pinned for a failed diff');
		// The failed diff must NOT be re-emitted into the URL.
		W.__updateURL(true);
		eq(window.location.hash, `#/u${UID}`, 'F7: failed diff omitted from URL');
	}

	// Reset.
	W.__loadedPanels.clear();
	(doc.getElementById('panels') as HTMLElement).innerHTML = '';
	window.history.replaceState(null, '', '/');

	// =====================================================================
	// G. Identical versions → "no differences" notice, no diff body
	// =====================================================================
	// Diff the current note against ITS OWN hash (same raw both sides).
	await W.__addPanel('u', UID, null, null, { diff: 'p' + CUR_HASH });
	await nextTick(0);
	{
		const panel = doc.querySelector('.panel') as HTMLElement;
		check(!panel?.querySelector('.diff-body'), 'G1: identical versions render no diff-body');
		check(!!panel?.querySelector('.diff-notice'), 'G2: identical versions show a notice');
		check(!panel?.dataset.diff, 'G3: identical-version diff not pinned to URL');
	}

	// Reset.
	W.__loadedPanels.clear();
	(doc.getElementById('panels') as HTMLElement).innerHTML = '';
	window.history.replaceState(null, '', '/');

	// =====================================================================
	// H. Error panel (base note unresolvable) still stores data-panel-id
	//    so the close button (which reads it) can delete the right key.
	// =====================================================================
	await W.__addPanel('u', 'no-such-uid', null, null, null);
	await nextTick(0);
	{
		const panel = doc.querySelector('.panel') as HTMLElement;
		check(panel?.classList.contains('error'), 'H1: unresolvable base note → error panel');
		eq(panel?.dataset.panelId, 'u-no-such-uid', 'H2: error panel stores its panel key');
	}

	report();
}

function report() {
	if (failures.length === 0) {
		console.log('All diff-viewer (;diff=) cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} diff-viewer assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
