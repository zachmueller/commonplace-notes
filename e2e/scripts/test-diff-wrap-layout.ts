#!/usr/bin/env npx tsx
/**
 * Diff-viewer Wrap Layout Test (headless Chromium)
 *
 * Loads the generated site styles, the REAL vendored jsdiff + diff2html, and
 * SITE_APP_JS into headless Chromium, opens a `;diff=` panel, and measures the
 * layout. test-diff-params.ts covers the wiring in jsdom (no layout); this
 * covers what jsdom can't: diff2html's side-by-side view is two separate
 * tables, so once long lines wrap, row i must still line up across them.
 *
 * What it guards:
 *   - Wrapped (default): row i has the same top + height on both sides, the
 *     long rows actually wrap, nothing scrolls sideways, and the line-number
 *     gutter fills each row.
 *   - Narrowing then widening the panel keeps rows aligned and lets them
 *     shrink back (ResizeObserver path + clear-before-measure).
 *   - Toggle off: the class and inline row heights are gone and upstream
 *     no-wrap rendering (white-space: pre, horizontal scroll) is back.
 *
 * Run: npx tsx e2e/scripts/test-diff-wrap-layout.ts
 */

import { chromium, type Page } from 'playwright-core';
import * as assetsModule from '../../src/publish/siteAssets';

const assets: any =
	(assetsModule as any).SITE_APP_JS !== undefined
		? assetsModule
		: (assetsModule as any).default;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGIN = 'https://diff-wrap.test';
const UID = 'wrap-note';
const CUR_HASH = 'hashwrapnew0000';
const PRIOR_HASH = 'hashwrapold0000';

const sentence = (i: number) =>
	`Sentence ${i} of a long Markdown paragraph that sits on a single source line, as prose usually does. `;
const paragraph = (n: number) => Array.from({ length: n }, (_, i) => sentence(i + 1)).join('').trim();

// Both sides wrap but to different heights (an edited paragraph that grew),
// plus a long one-sided addition (old side is an empty placeholder) — the two
// ways wrapped side-by-side rows drift apart.
const RAW_OLD = ['# Title', '', paragraph(6), '', 'A short line that gets removed.', '', 'Outro.', ''].join('\n');
const RAW_NEW = [
	'# Title',
	'',
	paragraph(6).replace('Sentence 3', 'Edited sentence 3') + ' ' + paragraph(3),
	'',
	paragraph(8),
	'',
	'Outro.',
	''
].join('\n');

function noteJson(hash: string, raw: string, priorHash: string | null) {
	return {
		uid: UID,
		slug: '',
		title: 'Wrap note',
		hash,
		priorHash,
		lastUpdated: null,
		content: '<p>body</p>',
		raw,
		backlinks: []
	};
}

const SHELL = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>${assets.SITE_STYLES_CSS.replace('{{EXTRA_CSS}}', '')}</style>
</head><body>
<div class="panels-container" id="panels"></div>
<script src="/flexsearch.js"></script>
<script src="/vendor.js"></script>
<script src="/app.js"></script>
</body></html>`;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const failures: string[] = [];
function check(cond: boolean, msg: string) {
	if (!cond) failures.push(msg);
}

async function frames(page: Page, n = 3) {
	await page.evaluate(
		(count) =>
			new Promise<void>((resolve) => {
				const step = (left: number) => (left ? requestAnimationFrame(() => step(left - 1)) : resolve());
				step(count);
			}),
		n
	);
}

interface Layout {
	wrapped: boolean;
	rows: number;
	maxTopDelta: number;
	maxHeightDelta: number;
	maxGutterDelta: number;
	minRowHeight: number;
	maxRowHeight: number;
	overflowing: boolean;
	inlineHeights: number;
	ctnWhiteSpace: string;
}

// Measure the open diff panel: cross-side row alignment, gutter coverage,
// horizontal overflow, and whether inline row heights are set.
async function measure(page: Page): Promise<Layout> {
	return page.evaluate(() => {
		const panel = document.querySelector('.diff-panel') as HTMLElement;
		const sides = Array.from(panel.querySelectorAll('.d2h-file-side-diff')) as HTMLElement[];
		const [left, right] = sides.map((s) => Array.from(s.querySelectorAll('tbody tr')) as HTMLElement[]);
		let maxTopDelta = 0;
		let maxHeightDelta = 0;
		let maxGutterDelta = 0;
		let minRowHeight = Infinity;
		let maxRowHeight = 0;
		for (let i = 0; i < Math.min(left.length, right.length); i++) {
			const a = left[i].getBoundingClientRect();
			const b = right[i].getBoundingClientRect();
			maxTopDelta = Math.max(maxTopDelta, Math.abs(a.top - b.top));
			maxHeightDelta = Math.max(maxHeightDelta, Math.abs(a.height - b.height));
			minRowHeight = Math.min(minRowHeight, a.height);
			maxRowHeight = Math.max(maxRowHeight, a.height);
		}
		for (const tr of left.concat(right)) {
			const gutter = tr.querySelector('.d2h-code-side-linenumber') as HTMLElement | null;
			if (gutter) {
				maxGutterDelta = Math.max(
					maxGutterDelta,
					Math.abs(gutter.getBoundingClientRect().height - tr.getBoundingClientRect().height)
				);
			}
		}
		const ctn = panel.querySelector('.d2h-code-line-ctn') as HTMLElement;
		return {
			wrapped: panel.classList.contains('diff-wrap'),
			rows: left.length === right.length ? left.length : -1,
			maxTopDelta,
			maxHeightDelta,
			maxGutterDelta,
			minRowHeight,
			maxRowHeight,
			overflowing: sides.some((s) => s.scrollWidth > s.clientWidth + 1),
			inlineHeights: left.concat(right).filter((tr) => tr.style.height !== '').length,
			ctnWhiteSpace: getComputedStyle(ctn).whiteSpace
		};
	});
}

function checkAligned(l: Layout, label: string) {
	check(l.wrapped, `${label}: panel has diff-wrap`);
	check(l.rows > 0, `${label}: both sides have the same row count (got ${l.rows})`);
	check(l.maxTopDelta < 1, `${label}: row tops line up across sides (max delta ${l.maxTopDelta.toFixed(2)}px)`);
	check(l.maxHeightDelta < 1, `${label}: row heights match across sides (max delta ${l.maxHeightDelta.toFixed(2)}px)`);
	check(l.maxRowHeight > 2.5 * l.minRowHeight, `${label}: long rows wrap (max ${l.maxRowHeight}px vs min ${l.minRowHeight}px)`);
	check(!l.overflowing, `${label}: no horizontal scroll`);
	check(l.maxGutterDelta < 1, `${label}: gutter fills each row (max delta ${l.maxGutterDelta.toFixed(2)}px)`);
	check(l.ctnWhiteSpace === 'pre-wrap', `${label}: content is pre-wrap (got ${l.ctnWhiteSpace})`);
}

async function setPanelWidth(page: Page, px: number) {
	await page.evaluate((w) => {
		const panel = document.querySelector('.diff-panel') as HTMLElement;
		panel.style.width = w + 'px';
		panel.style.flexBasis = w + 'px';
	}, px);
	// .panel animates width (transition: all 0.3s); let it settle, then give
	// the ResizeObserver a frame to sync.
	await page.waitForTimeout(450);
	await frames(page);
}

async function main() {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
		page.on('pageerror', (err) => failures.push(`page error: ${err.message}`));
		// tsx (esbuild keepNames) wraps named functions in __name(...), which then
		// leaks into page.evaluate callbacks; give the page a no-op definition.
		await page.addInitScript('window.__name = (fn) => fn;');

		await page.route('**/*', async (route) => {
			const url = new URL(route.request().url());
			const p = url.pathname;
			const json = (obj: unknown) =>
				route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
			if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: SHELL });
			if (p === '/flexsearch.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: assets.FLEXSEARCH_MIN_JS });
			if (p === '/vendor.js') return route.fulfill({ status: 200, contentType: 'text/javascript', body: assets.VENDOR_JS });
			if (p === '/app.js') {
				// Expose the internals this test drives (same pattern as test-diff-params.ts).
				const body = `${assets.SITE_APP_JS}\nwindow.__addPanel = addPanel;\nwindow.__loadedPanels = loadedPanels;`;
				return route.fulfill({ status: 200, contentType: 'text/javascript', body });
			}
			if (p.endsWith('/static/mapping/uid-to-hash.json')) return json({ [UID]: CUR_HASH });
			if (p.endsWith('/static/mapping/slug-to-uid.json')) return json({});
			if (p.endsWith('/static/content/contentIndex.json')) return json({});
			if (p.endsWith(`/notes/${CUR_HASH}.json`)) return json(noteJson(CUR_HASH, RAW_NEW, PRIOR_HASH));
			if (p.endsWith(`/notes/${PRIOR_HASH}.json`)) return json(noteJson(PRIOR_HASH, RAW_OLD, null));
			return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
		});

		await page.goto(ORIGIN + '/');
		await page.waitForLoadState('load');
		await frames(page);

		// Clean slate (the load handler may have opened a fallback panel), then
		// open the diff with wrapping at its default.
		await page.evaluate(async ([uid, prior]) => {
			localStorage.removeItem('diffWrap');
			(window as any).__loadedPanels.clear();
			document.getElementById('panels')!.innerHTML = '';
			await (window as any).__addPanel('u', uid, null, null, { diff: 'p' + prior });
		}, [UID, PRIOR_HASH]);
		await page.waitForSelector('.diff-panel .d2h-file-side-diff');
		await setPanelWidth(page, 900);

		// --- A. Default: wrapped and aligned -------------------------------
		const wide = await measure(page);
		checkAligned(wide, 'A (900px)');

		// --- B. Narrow, then widen again ------------------------------------
		await setPanelWidth(page, 420);
		const narrow = await measure(page);
		checkAligned(narrow, 'B1 (420px)');
		check(narrow.maxRowHeight > wide.maxRowHeight, 'B2: narrowing makes the long rows taller');

		await setPanelWidth(page, 900);
		const rewide = await measure(page);
		checkAligned(rewide, 'B3 (back to 900px)');
		check(
			Math.abs(rewide.maxRowHeight - wide.maxRowHeight) < 1,
			`B4: widening lets rows shrink back (${rewide.maxRowHeight}px vs ${wide.maxRowHeight}px)`
		);

		// --- C. Toggle off: today's no-wrap rendering -----------------------
		await page.click('.diff-panel .diff-wrap-toggle input');
		await frames(page);
		const off = await measure(page);
		check(!off.wrapped, 'C1: toggle off removes diff-wrap');
		check(off.inlineHeights === 0, `C2: inline row heights cleared (${off.inlineHeights} left)`);
		check(off.ctnWhiteSpace === 'pre', `C3: content back to white-space: pre (got ${off.ctnWhiteSpace})`);
		check(off.overflowing, 'C4: long lines scroll horizontally again');
		check(off.maxTopDelta < 1, 'C5: unwrapped rows still line up');
		check((await page.evaluate(() => localStorage.getItem('diffWrap'))) === 'off', 'C6: off persisted');

		// --- D. Toggle back on ---------------------------------------------
		await page.click('.diff-panel .diff-wrap-toggle input');
		await frames(page);
		checkAligned(await measure(page), 'D (re-enabled)');
	} finally {
		await browser.close();
	}

	if (failures.length === 0) {
		console.log('All diff wrap layout cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} diff wrap layout assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
