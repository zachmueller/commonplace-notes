#!/usr/bin/env npx tsx
/**
 * Transclusion Runtime Test
 *
 * Loads the generated SITE_APP_JS into a jsdom window (same approach as
 * test-section-anchors.ts) and checks how the published SPA hydrates
 * `.cpn-transclusion` placeholders emitted by remarkObsidianLinks for
 * `![[Note]]`, `![[Note#Heading]]` and `![[Note#^block]]`.
 *
 * What it guards:
 *   - Embeds resolve by uid to the target's LATEST revision, even when the host
 *     note is an old revision opened via #/p<hash>.
 *   - Whole-note, heading-section (incl. inside a callout) and block extraction
 *     (paragraph, list item keeping its <ol> number, code fence → <pre>).
 *   - Embedded ids / block ids / data-line are moved aside, so the host panel's
 *     heading scroll still lands on the host's own heading.
 *   - The target's same-note links are re-pointed at the target note.
 *   - Inline embeds: a single paragraph flows inline; block content promotes
 *     the span (and a paragraph it sits alone in) to a div.
 *   - Fallbacks: missing section, forbidden (403) and unknown uid → visible
 *     "unavailable" notice; self-embed cycle and depth limit → plain link.
 *   - Embedded code gets a copy button; embedded links open panels.
 *   - The same target embedded many times is fetched once.
 *   - Diff panels never hydrate.
 *   - [[Note#^id]] links scroll to the [data-block-id] block.
 *
 * Run: npx tsx e2e/scripts/test-transclusions-runtime.ts
 */

import { JSDOM } from 'jsdom';
import * as assetsModule from '../../src/publish/siteAssets';

const assets: any =
	(assetsModule as any).SITE_APP_JS !== undefined
		? assetsModule
		: (assetsModule as any).default;
const SITE_APP_JS: string = assets.SITE_APP_JS;

// ---------------------------------------------------------------------------
// Fixtures (content shaped like the publish pipeline's output)
// ---------------------------------------------------------------------------

const T1_NEW = `
<h1 id="intro">Intro</h1>
<p class="line" data-line="2" data-block-id="para">New intro text with <a href="#" data-heading="details" data-same-note="true">self link</a>.</p>
<h2 id="details">Details</h2>
<p>details body</p>
<div data-callout-type="note"><h3 id="inner">Inner</h3><p>inner body</p></div>
<h2 id="list">List</h2>
<ol start="2"><li>two</li><li data-block-id="li3">three<ul><li>nested</li></ul></li></ol>
<pre><code data-block-id="code">x()
</code></pre>
<h1 id="end">End</h1>
<p>end body</p>
`;

const ph = (uid: string, extra = '', tag = 'div') =>
	`<${tag} class="cpn-transclusion" data-uid="${uid}" data-title="Title ${uid}"${extra}><a href="#/u${uid}">Title ${uid}</a></${tag}>`;

const PARENT_OLD = `
<h2 id="intro">Parent Intro</h2>
<p data-block-id="hostblock">host block</p>
<section id="whole">${ph('T1')}</section>
<section id="heading">${ph('T1', ' data-heading="details"')}</section>
<section id="callout-heading">${ph('T1', ' data-heading="inner"')}</section>
<section id="li">${ph('T1', ' data-block="li3"')}</section>
<section id="code">${ph('T1', ' data-block="code"')}</section>
<section id="inline"><p data-line="9">See ${ph('T1', ' data-block="para"', 'span')} here</p></section>
<section id="promote"><p data-line="10">${ph('T1', ' data-heading="list"', 'span')}</p></section>
<section id="gone">${ph('T1', ' data-heading="gone"')}</section>
<section id="forbidden">${ph('F1')}</section>
<section id="missing">${ph('M1')}</section>
<section id="self">${ph('S1')}</section>
<section id="deep">${ph('D1')}</section>
`;

const NOTES: Record<string, any> = {
	'h-T1-new': { uid: 'T1', title: 'Target', content: T1_NEW, raw: 'new' },
	'h-T1-old': { uid: 'T1', title: 'Target', content: '<p>OLD content</p>', raw: 'old' },
	'h-P-old': { uid: 'P', title: 'Parent', content: PARENT_OLD, raw: 'a' },
	'h-P-new': { uid: 'P', title: 'Parent', content: ph('T1'), raw: 'b' },
	'h-S1': { uid: 'S1', title: 'Self', content: `<p>self body</p>${ph('S1')}`, raw: '' },
	'h-D1': { uid: 'D1', title: 'D1', content: `<p>d1</p>${ph('D2')}`, raw: '' },
	'h-D2': { uid: 'D2', title: 'D2', content: `<p>d2</p>${ph('D3')}`, raw: '' },
	'h-D3': { uid: 'D3', title: 'D3', content: `<p>d3</p>${ph('D4')}`, raw: '' },
	'h-D4': { uid: 'D4', title: 'D4', content: `<p>d4</p>${ph('D5')}`, raw: '' },
	'h-D5': { uid: 'D5', title: 'D5', content: `<p>d5</p>`, raw: '' },
};
for (const n of Object.values(NOTES)) n.backlinks = [];

const UID_TO_HASH: Record<string, string> = {
	T1: 'h-T1-new', P: 'h-P-new', F1: 'h-F1', S1: 'h-S1',
	D1: 'h-D1', D2: 'h-D2', D3: 'h-D3', D4: 'h-D4', D5: 'h-D5',
};

const fetched: string[] = [];
const noHeaders = { get: () => null };
const forbiddenHeaders = { get: (h: string) => (h === 'x-cpn-auth' ? 'forbidden' : null) };

function makeFetch() {
	return async (url: string) => {
		const u = String(url);
		fetched.push(u);
		if (u.includes('/static/mapping/uid-to-hash.json')) return json(UID_TO_HASH);
		if (u.includes('/static/mapping/slug-to-uid.json')) return json({});
		if (u.includes('/static/content/contentIndex.json')) return json({});
		const m = /\/notes\/([^/]+)\.json$/.exec(u);
		if (m) {
			if (m[1] === 'h-F1') return { ok: false, status: 403, headers: forbiddenHeaders, json: async () => ({}) };
			if (NOTES[m[1]]) return json(JSON.parse(JSON.stringify(NOTES[m[1]])));
		}
		return { ok: false, status: 404, headers: noHeaders, json: async () => ({}) } as any;
	};
}

function json(obj: any) {
	return { ok: true, status: 200, headers: noHeaders, json: async () => obj } as any;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const failures: string[] = [];
function check(cond: boolean, msg: string) {
	if (!cond) failures.push(msg);
}
const nextTick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function settle() {
	for (let i = 0; i < 10; i++) await nextTick(0);
}

async function main() {
	const dom = new JSDOM(
		`<!DOCTYPE html><html><body><div class="panels-container" id="panels"></div></body></html>`,
		{ url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true }
	);
	const { window } = dom;
	const doc = window.document;
	const W = window as any;

	W.fetch = makeFetch();
	W.FlexSearch = { Document: class { add() {} async search() { return []; } } };
	if (!W.matchMedia) W.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
	const scrolled: any[] = [];
	W.HTMLElement.prototype.scrollIntoView = function (opts: any) {
		scrolled.push({ el: this, opts });
	};
	if (!W.CSS || typeof W.CSS.escape !== 'function') {
		W.CSS = { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
	}
	W.requestAnimationFrame = (cb: any) => window.setTimeout(() => cb(0), 0);
	// Diff vendor stubs (SITE_APP_JS expects the vendor bundle's globals).
	W.Diff = { createTwoFilesPatch: () => 'patch' };
	W.Diff2Html = { html: () => '<div class="d2h-stub">diff</div>' };

	window.eval(`
		${SITE_APP_JS}
		window.__addPanel = addPanel;
		window.__scrollToHeading = scrollToHeading;
		window.__loadedPanels = loadedPanels;
	`);

	// Let the startup loadPanelsFromURL run, then reset.
	await settle();
	W.__loadedPanels.clear();
	(doc.getElementById('panels') as HTMLElement).innerHTML = '';
	fetched.length = 0;

	const fetchCount = (hash: string) => fetched.filter((u) => u.endsWith(`/notes/${hash}.json`)).length;

	// =====================================================================
	// D — diff panels never hydrate
	// =====================================================================
	await W.__addPanel('u', 'P', null, null, { diff: 'ph-P-old' });
	await settle();
	const diffPanel = doc.querySelector('.panel.diff-panel');
	check(!!diffPanel, 'D: diff panel rendered');
	check(fetchCount('h-T1-new') === 0, 'D: diff panel did not fetch embedded notes');
	W.__loadedPanels.clear();
	(doc.getElementById('panels') as HTMLElement).innerHTML = '';

	// =====================================================================
	// Old host revision (#/p) — everything below runs against this panel
	// =====================================================================
	await W.__addPanel('p', 'h-P-old');
	await settle();
	const panel = doc.querySelector('.panel[data-param-type="p"]') as HTMLElement;
	check(!!panel, 'host: old-revision panel created');
	const sec = (id: string) => panel.querySelector(`#${id}`) as HTMLElement;
	const loaded = (id: string) => sec(id)?.querySelector('.cpn-transclusion') as HTMLElement;

	// W1 — whole note, latest revision
	const whole = loaded('whole');
	check(whole?.dataset.state === 'loaded', 'W1: whole-note embed loaded');
	check(!!whole?.textContent?.includes('New intro text'), 'W1: shows the LATEST target revision');
	check(!whole?.textContent?.includes('OLD content'), 'W1: not the old target revision');
	check(!!whole?.textContent?.includes('end body'), 'W1: whole note includes the end');
	check(!!whole?.querySelector('a.cpn-transclusion-source'), 'W1: source link appended');

	// W2 — ids moved aside; the host heading scroll targets the host
	check(panel.querySelectorAll('#intro').length === 1, 'W2: only one #intro in the panel');
	check(panel.querySelector('#intro')?.textContent === 'Parent Intro', 'W2: #intro is the host heading');
	check(!whole?.querySelector('[id], [data-block-id], [data-line]'), 'W2: embedded ids/block ids/lines renamed');
	check(!!whole?.querySelector('[data-cpn-tid="intro"]'), 'W2: original id kept as data-cpn-tid');
	scrolled.length = 0;
	W.__scrollToHeading(panel, 'intro');
	check(scrolled.some((s) => s.el === panel.querySelector('#intro')), 'W2: scrollToHeading hits the host heading');

	// W3 — same-note link re-pointed at the target note
	const selfLink = whole?.querySelector('a[data-heading="details"]') as HTMLAnchorElement;
	check(selfLink?.getAttribute('href') === '#/uT1', 'W3: same-note link points at the target');
	check(selfLink?.dataset.sameNote === undefined, 'W3: same-note marker removed');

	// H1 — heading section stops at the next same-or-higher heading
	const heading = loaded('heading');
	const headingText = heading?.textContent || '';
	check(!!heading?.querySelector('h2[data-cpn-tid="details"]'), 'H1: section starts with its heading');
	check(headingText.includes('details body') && headingText.includes('inner body'), 'H1: section body (incl. callout) included');
	check(!headingText.includes('three') && !headingText.includes('Intro'), 'H1: section stops at the next h2');

	// H2 — heading inside a callout: section is bounded by the callout
	const inner = loaded('callout-heading');
	check(!!inner?.textContent?.includes('inner body'), 'H2: callout-nested heading section found');
	check(!inner?.textContent?.includes('List'), 'H2: callout-nested section bounded by its wrapper');

	// B1 — list item keeps its number and children
	const li = loaded('li');
	const ol = li?.querySelector('ol');
	check(ol?.getAttribute('start') === '3', `B1: <ol start="3"> keeps the item number (got ${ol?.getAttribute('start')})`);
	check(!!li?.textContent?.includes('nested') && !li?.textContent?.includes('two'), 'B1: only that item (with children)');

	// B2 — code fence → <pre> with a copy button
	const code = loaded('code');
	check(!!code?.querySelector('pre > code'), 'B2: code block embeds its <pre>');
	check(!!code?.querySelector('pre > .copy-code-button'), 'B2: copy button added to embedded code');

	// I1 — inline single paragraph flows into the sentence
	const inlineP = sec('inline')?.querySelector('p') as HTMLElement;
	const inline = inlineP?.querySelector('.cpn-transclusion') as HTMLElement;
	check(inline?.tagName === 'SPAN' && inline.dataset.state === 'loaded', 'I1: inline embed stays a loaded span');
	check(!inline?.querySelector('p'), 'I1: paragraph unwrapped inline');
	check(!!inlineP?.textContent?.match(/^See New intro text with self link\..*here$/s), `I1: reads as one sentence (got ${JSON.stringify(inlineP?.textContent)})`);

	// I2 — block content in an inline embed alone in its paragraph → promoted
	const promoted = sec('promote');
	check(!promoted?.querySelector('p[data-line="10"]'), 'I2: host paragraph retagged');
	check(!!promoted?.querySelector('div[data-line="10"] > div.cpn-transclusion--loaded'), 'I2: placeholder promoted to a div');
	check(!!promoted?.querySelector('ol[start="2"]'), 'I2: block content injected');

	// F1 — missing section / forbidden / unknown uid → visible notice
	const gone = loaded('gone');
	check(gone?.dataset.state === 'section-missing', 'F1: missing heading → section-missing');
	check(!!gone?.textContent?.includes('Embedded section unavailable'), 'F1: section-missing notice shown');
	const forbidden = loaded('forbidden');
	check(forbidden?.dataset.state === 'unavailable', 'F1: 403 → unavailable');
	check(!!forbidden?.textContent?.includes('Embedded note unavailable') && !!forbidden?.querySelector('a[href="#/uF1"]'), 'F1: forbidden notice links to the note');
	check(loaded('missing')?.dataset.state === 'unavailable', 'F1: unknown uid → unavailable');

	// C1 — self-embed stops at the cycle
	const self = loaded('self');
	check(self?.dataset.state === 'loaded' && !!self.textContent?.includes('self body'), 'C1: self-embedding note embedded once');
	const selfInner = self?.querySelector('.cpn-transclusion') as HTMLElement;
	check(selfInner?.dataset.state === 'cycle', 'C1: its embed of itself stops (cycle)');

	// C2 — depth limit
	const deepText = loaded('deep')?.textContent || '';
	check(deepText.includes('d4') && !deepText.includes('d5'), 'C2: nesting stops at the depth limit');
	check(!!sec('deep')?.querySelector('[data-uid="D5"][data-state="depth"]'), 'C2: D5 left as a link (depth)');
	check(fetchCount('h-D5') === 0, 'C2: beyond-limit note not fetched');

	// N1 — one fetch for many embeds of the same target
	check(fetchCount('h-T1-new') === 1, `N1: target fetched once (got ${fetchCount('h-T1-new')})`);

	// L1 — an embedded link opens a panel
	const source = whole?.querySelector('a.cpn-transclusion-source') as HTMLElement;
	source?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
	await settle();
	check(!!doc.querySelector('.panel[data-panel-id="u-T1"]'), 'L1: clicking an embedded link opens the target panel');

	// L2 — [[Note#^id]] block link scrolls to the [data-block-id] block
	const tPanel = doc.querySelector('.panel[data-panel-id="u-T1"]') as HTMLElement;
	scrolled.length = 0;
	W.__scrollToHeading(tPanel, '^para');
	const paraEl = tPanel?.querySelector('.content > [data-block-id="para"]');
	check(!!paraEl && scrolled.some((s) => s.el === paraEl), 'L2: ^id scroll targets the data-block-id block');
	scrolled.length = 0;
	W.__scrollToHeading(tPanel, '^code');
	check(scrolled.some((s) => s.el?.tagName === 'PRE'), 'L2: ^id on a code fence scrolls to its <pre>');
	scrolled.length = 0;
	W.__scrollToHeading(panel, '^hostblock');
	check(scrolled.length === 1 && scrolled[0].el.textContent === 'host block', 'L2: host block ids unaffected by embeds');

	report();
}

function report() {
	if (failures.length === 0) {
		console.log('All transclusion runtime cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} transclusion runtime assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
