#!/usr/bin/env npx tsx
/**
 * Error-panel Details Test (headless WebKit, iPhone emulation)
 *
 * Renders the real site files (renderSiteAssets), serves them plus fake note
 * data through request interception, and opens notes whose loads fail in
 * different ways. Runs under WebKit with Playwright's iPhone profile because
 * the Details exist to diagnose failures readers hit on iPhone Safari, and
 * WebKit's error text (e.g. "Load failed") differs from Chromium's.
 *
 * What it guards:
 *   - Every error panel has a collapsed <details> naming the exception and
 *     the browser.
 *   - Fetch failures also name the request: note JSON that isn't JSON, a
 *     missing note file, a failing mapping file, and a network-level abort
 *     (which has no response, so no Response line).
 *   - A uid that isn't in the mapping says so, with no Request line.
 *   - The panel escapes the uid from the URL (no HTML injection).
 *   - A note that loads fine shows no error panel.
 *
 * Needs Playwright's WebKit: npx playwright install webkit
 * Run: npx tsx e2e/scripts/test-error-details.ts
 */

import { webkit, devices, type Page, type Route } from 'playwright-core';
import * as rendererModule from '../../src/publish/siteRenderer';
import type { PublishingProfile } from '../../src/types';

// tsx/Node ESM sometimes surfaces named src exports under `.default`.
const renderer: any = (rendererModule as any).renderSiteAssets !== undefined
	? rendererModule
	: (rendererModule as any).default;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGIN = 'https://notes.example.com';
const GOOD = 'good-note';
const NOT_JSON = 'not-json';
const MISSING_FILE = 'missing-file';
const ABORTED = 'aborted';

const UID_TO_HASH: Record<string, string> = {
	[GOOD]: 'hgood',
	[NOT_JSON]: 'hnotjson',
	[MISSING_FILE]: 'hmissing',
	[ABORTED]: 'haborted',
};

function profile(): PublishingProfile {
	return {
		name: 'Test', id: 'test', lastFullPublishTimestamp: 0, excludedDirectories: [],
		baseUrl: ORIGIN + '/', homeNotePath: '', isPublic: true,
		publishContentIndex: true, obscureRawWikilinks: true, publishMechanism: 'AWS',
	} as PublishingProfile;
}

const goodNote = {
	uid: GOOD, slug: 'good', title: 'Good note', hash: 'hgood', priorHash: null,
	lastUpdated: null, content: '<p>Good body</p>', raw: 'Good body\n', backlinks: [],
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string) {
	if (!cond) failures.push(`${label}${detail ? `: ${detail}` : ''}`);
}

interface PanelInfo {
	ok: number;
	errorText: string;
	detail: string | null;
	detailsOpen: boolean | null;
	injectedImgs: number;
}

// Open `#/u<uid>` in a fresh document and report what the first panel shows.
async function open(page: Page, uid: string): Promise<PanelInfo> {
	// Leave first: a goto that only changes the hash is a same-document
	// navigation, which would keep the SPA's cached mappings and old panels.
	await page.goto('about:blank');
	await page.goto(`${ORIGIN}/#/u${encodeURIComponent(uid)}`);
	await page.waitForSelector('#panels .panel', { timeout: 10000 });
	return page.evaluate(() => {
		const err = document.querySelector('#panels .panel.error');
		const details = err ? err.querySelector('details.error-details') as HTMLDetailsElement | null : null;
		return {
			ok: document.querySelectorAll('#panels .panel:not(.error)').length,
			errorText: err ? (err.textContent || '').replace(/\s+/g, ' ').trim() : '',
			detail: details ? (details.querySelector('pre')!.textContent || '') : null,
			detailsOpen: details ? details.open : null,
			injectedImgs: err ? err.querySelectorAll('img').length : 0,
		};
	});
}

function expectDetail(label: string, info: PanelInfo, includes: string[], excludes: string[] = []) {
	check(`${label}: error panel shown`, info.errorText.includes('Unable to load the note'), info.errorText);
	check(`${label}: has Details`, info.detail !== null);
	check(`${label}: Details collapsed by default`, info.detailsOpen === false);
	const detail = info.detail || '';
	check(`${label}: names the browser`, /Browser: .*iPhone/.test(detail), detail);
	for (const s of includes) check(`${label}: Details include ${JSON.stringify(s)}`, detail.includes(s), detail);
	for (const s of excludes) check(`${label}: Details omit ${JSON.stringify(s)}`, !detail.includes(s), detail);
}

async function main() {
	const { files } = await renderer.renderSiteAssets(profile());
	const siteFiles = new Map<string, any>(files.map((f: any) => [`/${f.name}`, f]));
	let failMapping = false;

	const browser = await webkit.launch();
	try {
		const context = await browser.newContext({ ...devices['iPhone 15'] });
		const page = await context.newPage();
		page.on('pageerror', (err) => failures.push(`page error: ${err.message}`));

		await page.route('**/*', async (route: Route) => {
			const p = new URL(route.request().url()).pathname;
			const json = (obj: unknown) =>
				route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
			const file = siteFiles.get(p === '/' ? '/index.html' : p);
			if (file) return route.fulfill({ status: 200, contentType: file.contentType, body: file.body });
			if (p === '/static/mapping/uid-to-hash.json') {
				return failMapping
					? route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' })
					: json(UID_TO_HASH);
			}
			if (p === '/static/mapping/slug-to-uid.json') return json({});
			if (p === '/static/content/contentIndex.json') return json({});
			if (p === '/notes/hgood.json') return json(goodNote);
			// Labelled JSON but isn't: what response.json() sees from a stray HTML page.
			if (p === '/notes/hnotjson.json') {
				return route.fulfill({ status: 200, contentType: 'application/json', body: '<!DOCTYPE html><p>nope</p>' });
			}
			if (p === '/notes/haborted.json') return route.abort('failed');
			return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
		});

		// --- A note that loads fine: no error panel ---
		const good = await open(page, GOOD);
		check('good note: renders', good.ok === 1 && good.errorText === '', good.errorText);

		// --- Note JSON that isn't JSON ---
		expectDetail('non-JSON note body', await open(page, NOT_JSON), [
			'SyntaxError:',
			'Request: /notes/hnotjson.json',
			'Response: HTTP 200, application/json',
		]);

		// --- Note file missing ---
		expectDetail('missing note file', await open(page, MISSING_FILE), [
			'HTTP error! status: 404',
			'Request: /notes/hmissing.json',
			'Response: HTTP 404',
		]);

		// --- Network-level failure: request named, no response ---
		expectDetail('aborted note fetch', await open(page, ABORTED), [
			'TypeError:',
			'Request: /notes/haborted.json',
		], ['Response:']);

		// --- Uid not in the mapping: no request to blame ---
		expectDetail('unknown uid', await open(page, 'no-such-uid'), [
			'Could not resolve note hash',
		], ['Request:']);

		// --- Uid from the URL is escaped, not injected ---
		const hostile = await open(page, '<img src=x onerror="window.__pwned=1">');
		check('hostile uid: no <img> injected', hostile.injectedImgs === 0);
		check('hostile uid: shown as text', hostile.errorText.includes('<img src=x'), hostile.errorText);
		check('hostile uid: no script ran', !(await page.evaluate(() => (window as any).__pwned)));

		// --- Mapping file failing ---
		failMapping = true;
		expectDetail('failing mapping file', await open(page, GOOD), [
			'HTTP error! status: 500',
			'Request: /static/mapping/uid-to-hash.json',
			'Response: HTTP 500, text/plain',
		]);
	} finally {
		await browser.close();
	}

	if (failures.length) {
		console.error(`FAIL (${failures.length}):`);
		for (const f of failures) console.error(`  - ${f}`);
		process.exit(1);
	}
	console.log('PASS: error panel Details name the failure, request, and browser');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
