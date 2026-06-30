#!/usr/bin/env npx tsx
/**
 * Per-note URL parameter Round-Trip Test
 *
 * Exercises the published SPA's per-note `;key=value` URL-fragment parameters
 * (e.g. `#/uABC;width=800`) by loading the generated SITE_APP_JS into a jsdom
 * window. Pure unit test of the shipped runtime — no real browser or Obsidian.
 *
 * What it guards:
 *   - parseURLFragment splits a segment into {type, value, params}, decoding
 *     both key and value, ignoring tokens with no '=', last-wins on duplicates,
 *     and surviving values that contain encoded ';' / '=' delimiters.
 *   - serializeParams emits `;key=value` with encoded values in stable
 *     alphabetical key order, and '' for empty/absent params.
 *   - End-to-end width round-trip: loading `#/u<uid>;width=800` applies 800px to
 *     the panel and updateURL() re-serializes `;width=800`; the default 600px is
 *     omitted from the URL; a malformed/out-of-range inbound width falls back to
 *     the default (and is therefore omitted).
 *
 * Mirrors the harness in test-section-anchors.ts.
 *
 * Run: npx tsx e2e/scripts/test-note-params.ts
 */

import { JSDOM } from 'jsdom';
import * as assetsModule from '../../src/publish/siteAssets';
import * as urlSchemeModule from '../../src/utils/urlScheme';

// siteAssets is authored with `export const`, but under tsx's loader the named
// exports surface under a `default` wrapper. Unwrap defensively.
const assets: any =
	(assetsModule as any).SITE_APP_JS !== undefined
		? assetsModule
		: (assetsModule as any).default;
const SITE_APP_JS: string = assets.SITE_APP_JS;

// Plugin-side serializer — must stay symmetric with the SPA's serializeParams.
const urlScheme: any =
	(urlSchemeModule as any).serializeParams !== undefined
		? urlSchemeModule
		: (urlSchemeModule as any).default;
const pluginSerializeParams: (p?: Record<string, string | number>) => string =
	urlScheme.serializeParams;
const formatNoteStackUrl: (segs: any[], scheme: string) => string | null =
	urlScheme.formatNoteStackUrl;

// ---------------------------------------------------------------------------
// Fixtures: fake note JSON the SPA will "fetch"
// ---------------------------------------------------------------------------

const UID = 'abc-123'; // contains a '-' on purpose (exercises panelId split)

function noteJson(uid: string) {
	return {
		uid,
		slug: '', // empty slug → URL is just the param path (no decorative prefix)
		title: 'Note ' + uid,
		hash: 'hash-' + uid,
		lastUpdated: null,
		content: '<p>body</p>',
		backlinks: []
	};
}

function jsonResponse(obj: any) {
	return { ok: true, status: 200, json: async () => obj } as any;
}

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
		return { ok: false, status: 404, json: async () => ({}) } as any;
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
// Compare plain objects ignoring key order (param-object key order is an
// insertion-order artifact; serialization sorts keys, so order doesn't matter).
function eqObj(actual: Record<string, unknown>, expected: Record<string, unknown>, msg: string) {
	const sort = (o: Record<string, unknown>) =>
		JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
	if (sort(actual) !== sort(expected)) {
		failures.push(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
	}
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

	// Evaluate the real app JS inside the jsdom window and expose internals.
	const bootstrap = `
		${SITE_APP_JS}
		window.__parseURLFragment = parseURLFragment;
		window.__serializeParams = serializeParams;
		window.__updateURL = updateURL;
		window.__addPanel = addPanel;
		window.__loadedPanels = loadedPanels;
		window.__PANEL_DEFAULT_WIDTH = PANEL_DEFAULT_WIDTH;
		window.__PANEL_MIN_WIDTH = PANEL_MIN_WIDTH;
		window.__PANEL_MAX_WIDTH = PANEL_MAX_WIDTH;
	`;
	window.eval(bootstrap);

	const W = window as any;

	// Let the initial load handler settle, then reset to a clean slate.
	await nextTick(0);
	await nextTick(0);
	await nextTick(0);
	W.__loadedPanels.clear();
	(doc.getElementById('panels') as HTMLElement).innerHTML = '';

	// =====================================================================
	// A. parseURLFragment — segment + params shape
	// =====================================================================
	eq(
		W.__parseURLFragment('#/uABC;width=800'),
		[{ type: 'u', value: 'ABC', params: { width: '800' } }],
		'A1: single segment with one param'
	);
	eq(
		W.__parseURLFragment('#/uABC;width=800/uDEF'),
		[
			{ type: 'u', value: 'ABC', params: { width: '800' } },
			{ type: 'u', value: 'DEF', params: {} }
		],
		'A2: stack — params attach per-segment, second has empty params'
	);
	eq(
		W.__parseURLFragment('#/uABC'),
		[{ type: 'u', value: 'ABC', params: {} }],
		'A3: no params → params is {}'
	);
	// Last-wins on duplicate keys.
	eq(
		W.__parseURLFragment('#/uABC;width=300;width=800')[0].params,
		{ width: '800' },
		'A4: duplicate keys are last-wins'
	);
	// Token with no '=' is ignored (lenient).
	eq(
		W.__parseURLFragment('#/uABC;width=800;junk')[0].params,
		{ width: '800' },
		'A5: token with no "=" is ignored'
	);
	// Order-independent / multiple keys decode.
	eqObj(
		W.__parseURLFragment('#/uABC;b=2;a=1')[0].params,
		{ a: '1', b: '2' },
		'A6: multiple keys parsed regardless of order'
	);
	// A value containing encoded ';' and '=' survives (only the FIRST '=' splits).
	{
		const p = W.__parseURLFragment('#/uABC;note=a%3Bb%3Dc')[0].params;
		eq(p, { note: 'a;b=c' }, 'A7: encoded ";" and "=" decode inside a value');
	}
	// The id value itself is still decoded as before.
	eq(
		W.__parseURLFragment('#/u%20space;width=800')[0],
		{ type: 'u', value: ' space', params: { width: '800' } },
		'A8: id value is decoded independently of params'
	);

	// =====================================================================
	// B. serializeParams — SPA and plugin agree, deterministic order
	// =====================================================================
	eq(W.__serializeParams({}), '', 'B1: empty params → ""');
	eq(W.__serializeParams({ width: 800 }), ';width=800', 'B2: single param');
	eq(W.__serializeParams({ b: 2, a: 1 }), ';a=1;b=2', 'B3: keys emitted alphabetically');
	eq(
		W.__serializeParams({ note: 'a;b=c' }),
		';note=a%3Bb%3Dc',
		'B4: reserved ";"/"=" in a value are encoded'
	);
	// Plugin-side serializer is byte-identical to the SPA one (symmetry contract).
	for (const sample of [{}, { width: 800 }, { b: 2, a: 1 }, { note: 'a;b=c' }]) {
		eq(
			pluginSerializeParams(sample as any),
			W.__serializeParams(sample),
			'B5: plugin serializeParams matches SPA for ' + JSON.stringify(sample)
		);
	}
	// Plugin stack builder emits the same per-segment suffixes.
	eq(
		formatNoteStackUrl(
			[
				{ type: 'u', value: 'ABC', params: { width: 800 } },
				{ type: 'u', value: 'DEF' }
			],
			'current'
		),
		'#/uABC;width=800/uDEF',
		'B6: formatNoteStackUrl serializes per-segment params'
	);

	// Round-trip: parse(serialize(x)) recovers x (values become strings).
	{
		const url = '#/uABC' + W.__serializeParams({ width: 800, note: 'a;b=c' });
		const back = W.__parseURLFragment(url)[0];
		eq(
			back,
			{ type: 'u', value: 'ABC', params: { note: 'a;b=c', width: '800' } },
			'B7: parse(serialize(...)) round-trips'
		);
	}

	// =====================================================================
	// C. End-to-end width: apply on load + re-serialize via updateURL
	// =====================================================================
	const panelOf = () => doc.querySelector('.panel[data-param-type="u"]') as HTMLElement;

	// C1 — inbound width=800 applies to the panel and round-trips into the URL.
	await W.__addPanel('u', UID, null, null, { width: '800' });
	await nextTick(0);
	{
		const panel = panelOf();
		check(!!panel, 'C1: panel created for width case');
		eq(panel?.style.width, '800px', 'C1: inline width applied from URL param');
		eq(panel?.dataset.width, '800', 'C1: data-width recorded');
		W.__updateURL(true);
		eq(window.location.hash, '#/u' + UID + ';width=800', 'C1: updateURL re-emits ;width=800');
	}

	// Reset.
	W.__loadedPanels.clear();
	(doc.getElementById('panels') as HTMLElement).innerHTML = '';
	window.history.replaceState(null, '', '/');

	// C2 — default width (600) is NOT serialized into the URL.
	await W.__addPanel('u', UID, null, null, { width: '600' });
	await nextTick(0);
	{
		const panel = panelOf();
		check(!panel?.dataset.width, 'C2: default width leaves data-width unset');
		eq(panel?.style.width, '', 'C2: default width sets no inline style');
		W.__updateURL(true);
		eq(window.location.hash, '#/u' + UID, 'C2: default width omitted from URL');
	}

	// Reset.
	W.__loadedPanels.clear();
	(doc.getElementById('panels') as HTMLElement).innerHTML = '';
	window.history.replaceState(null, '', '/');

	// C3 — malformed inbound width falls back to default (and is omitted).
	await W.__addPanel('u', UID, null, null, { width: 'abc' });
	await nextTick(0);
	{
		const panel = panelOf();
		check(!panel?.dataset.width, 'C3: malformed width → no data-width');
		eq(panel?.style.width, '', 'C3: malformed width → no inline style (default)');
		W.__updateURL(true);
		eq(window.location.hash, '#/u' + UID, 'C3: malformed width omitted from URL');
	}

	// Reset.
	W.__loadedPanels.clear();
	(doc.getElementById('panels') as HTMLElement).innerHTML = '';
	window.history.replaceState(null, '', '/');

	// C4 — out-of-range inbound width (> MAX) falls back to default.
	await W.__addPanel('u', UID, null, null, { width: String(W.__PANEL_MAX_WIDTH + 500) });
	await nextTick(0);
	{
		const panel = panelOf();
		check(!panel?.dataset.width, 'C4: out-of-range width → no data-width (fallback)');
		eq(panel?.style.width, '', 'C4: out-of-range width → no inline style (default)');
	}

	report();
}

function report() {
	if (failures.length === 0) {
		console.log('All per-note URL parameter cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} per-note-param assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
