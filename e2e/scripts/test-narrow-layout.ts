#!/usr/bin/env npx tsx
/**
 * Narrow-screen Layout Test (headless WebKit)
 *
 * Renders the real site files (renderSiteAssets), serves them plus fake note
 * data through request interception, and measures the layout on an emulated
 * iPhone and in a few control viewports. WebKit because the narrow layout is
 * mostly for iPhone Safari.
 *
 * What it guards:
 *   - iPhone: each panel is exactly the screen width, its content doesn't
 *     scroll sideways, the stack snaps one note per swipe, a newly opened note
 *     is scrolled fully into view, and a `;width=` link still renders
 *     full-width while the URL keeps the parameter.
 *   - iPhone header: nothing overflows; the search input hides behind a 🔍
 *     toggle that expands it across the header (16px text, so iOS doesn't
 *     zoom), shows full-width results, and collapses on outside tap and after
 *     picking a result.
 *   - iPhone chat: hidden until the launcher is tapped, then opens as a
 *     full-width bottom sheet with no resize grip and 16px input text.
 *   - The panel breakpoint follows the profile's panelWidth: 300px panels stay
 *     300px on a phone (CSS rewrite: `@media (max-width: 300px)`).
 *   - A narrow desktop window: dragging a panel edge doesn't resize it or
 *     write `;width=` into the URL.
 *   - Desktop: unchanged layout (600px panels, input visible, no toggle, no snap).
 *
 * Needs Playwright's WebKit: npx playwright install webkit
 * Run: npx tsx e2e/scripts/test-narrow-layout.ts
 */

import { webkit, devices, type Browser, type BrowserContextOptions, type Page } from 'playwright-core';
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
const NOTES = [
	{ uid: 'note-a', title: 'Alpha note', hash: 'ha' },
	{ uid: 'note-b', title: 'Bravo note', hash: 'hb' },
	{ uid: 'note-c', title: 'Charlie note', hash: 'hc' },
];

const paragraph = 'A paragraph of ordinary prose that is long enough to wrap several times on a phone screen. ';

function noteJson(n: typeof NOTES[number], i: number) {
	const next = NOTES[(i + 1) % NOTES.length];
	return {
		uid: n.uid, slug: n.uid, title: n.title, hash: n.hash, priorHash: null, lastUpdated: null,
		content: `<p>${paragraph.repeat(4)}</p>`
			+ `<p>Next: <a href="#/u${next.uid}" class="internal-link">${next.title}</a></p>`,
		raw: `${paragraph}\n`, backlinks: [],
	};
}

function profile(overrides: Record<string, unknown> = {}): PublishingProfile {
	return {
		name: 'Test', id: 'test', lastFullPublishTimestamp: 0, excludedDirectories: [],
		baseUrl: ORIGIN + '/', homeNotePath: '', isPublic: true,
		publishContentIndex: true, obscureRawWikilinks: true, publishMechanism: 'AWS',
		siteCustomization: {
			siteTitle: 'Notes', panelWidth: 600, fontFamily: '', themeOverrides: {},
			headerLinks: [{ label: 'About', url: '#/unote-a' }, { label: 'Projects', url: '#/unote-b' }],
		},
		chat: { enabled: true },
		infrastructureState: { chat: { enabled: true, knowledgeBaseId: 'kb-test' } },
		...overrides,
	} as unknown as PublishingProfile;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const failures: string[] = [];
function check(label: string, cond: boolean, detail?: unknown) {
	if (!cond) failures.push(`${label}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ''}`);
}
const near = (a: number, b: number, tol = 1.5) => Math.abs(a - b) <= tol;

async function openSite(browser: Browser, contextOptions: BrowserContextOptions, site: PublishingProfile, hash: string) {
	const { files } = await renderer.renderSiteAssets(site);
	const siteFiles = new Map<string, any>(files.map((f: any) => [`/${f.name}`, f]));
	const context = await browser.newContext(contextOptions);
	const page = await context.newPage();
	page.on('pageerror', (err) => failures.push(`page error: ${err.message}`));
	await page.addInitScript('window.__name = (fn) => fn;');
	await page.route('**/*', (route) => {
		const p = new URL(route.request().url()).pathname;
		const json = (obj: unknown) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
		const file = siteFiles.get(p === '/' ? '/index.html' : p);
		if (file) return route.fulfill({ status: 200, contentType: file.contentType, body: file.body });
		if (p === '/static/mapping/uid-to-hash.json') return json(Object.fromEntries(NOTES.map((n) => [n.uid, n.hash])));
		if (p === '/static/mapping/slug-to-uid.json') return json({});
		if (p === '/static/content/contentIndex.json') {
			return json(Object.fromEntries(NOTES.map((n) => [n.uid, { title: n.title, content: paragraph }])));
		}
		const i = NOTES.findIndex((n) => p === `/notes/${n.hash}.json`);
		if (i !== -1) return json(noteJson(NOTES[i], i));
		return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
	});
	await page.goto(`${ORIGIN}/${hash}`);
	await page.waitForSelector('#panels .panel');
	await settle(page);
	return { page, close: () => context.close() };
}

// Let smooth scrolls and snapping finish.
async function settle(page: Page) {
	await page.waitForTimeout(700);
}

async function panelLayout(page: Page) {
	return page.evaluate(() => {
		const container = document.getElementById('panels')!;
		const panels = Array.from(container.querySelectorAll('.panel')) as HTMLElement[];
		return {
			containerWidth: container.clientWidth,
			scrollLeft: container.scrollLeft,
			snapType: getComputedStyle(container).scrollSnapType,
			panels: panels.map((p) => ({
				uid: p.dataset.uid,
				width: p.getBoundingClientRect().width,
				left: p.getBoundingClientRect().left,
				overflowX: p.scrollWidth - p.clientWidth,
			})),
		};
	});
}

async function visible(page: Page, selector: string) {
	return page.evaluate((sel) => {
		const el = document.querySelector(sel) as HTMLElement | null;
		if (!el) return false;
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
	}, selector);
}

const IPHONE = { ...devices['iPhone 15'] };

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function iphonePanels(browser: Browser) {
	const { page, close } = await openSite(browser, IPHONE, profile(), '#/unote-a/unote-b/unote-c');
	try {
		const layout = await panelLayout(page);
		const w = layout.containerWidth;
		check('iPhone: three panels', layout.panels.length === 3, layout.panels.length);
		for (const p of layout.panels) {
			check(`iPhone: ${p.uid} is screen width`, near(p.width, w), { width: p.width, screen: w });
			check(`iPhone: ${p.uid} doesn't scroll sideways`, p.overflowX <= 1, p.overflowX);
		}
		check('iPhone: stack snaps on x', layout.snapType.includes('x') && layout.snapType.includes('mandatory'), layout.snapType);

		// A swipe that stops partway snaps to a whole note.
		await page.evaluate((x) => { document.getElementById('panels')!.scrollLeft = x; }, w * 0.7);
		await settle(page);
		const afterSwipe = await panelLayout(page);
		check('iPhone: partial swipe snaps to a note', near(afterSwipe.scrollLeft % w, 0) || near(afterSwipe.scrollLeft % w, w),
			afterSwipe.scrollLeft);

		// Following a link from the first note opens the new one fully in view.
		await page.evaluate(() => { document.getElementById('panels')!.scrollLeft = 0; });
		await settle(page);
		await page.evaluate(() => {
			const link = document.querySelector('.panel[data-uid="note-c"] a.internal-link') as HTMLElement;
			link.click();
		});
		await settle(page);
		const afterOpen = await panelLayout(page);
		const opened = afterOpen.panels.find((p) => p.uid === 'note-a');
		check('iPhone: link target panel present', !!opened);
		if (opened) check('iPhone: opened note is fully in view', near(opened.left, 0), opened.left);
	} finally {
		await close();
	}

	// A shared `;width=` link still renders full-width but keeps the parameter.
	const wide = await openSite(browser, IPHONE, profile(), '#/unote-a;width=900');
	try {
		const layout = await panelLayout(wide.page);
		check('iPhone: ;width= panel is still screen width', near(layout.panels[0].width, layout.containerWidth), layout.panels[0].width);
		const hash = await wide.page.evaluate(() => location.hash);
		check('iPhone: ;width= kept in the URL', hash.includes(';width=900'), hash);
	} finally {
		await wide.close();
	}
}

async function iphoneHeader(browser: Browser) {
	const { page, close } = await openSite(browser, IPHONE, profile(), '#/unote-a');
	try {
		const header = await page.evaluate(() => {
			const h = document.querySelector('.header') as HTMLElement;
			return { scrollWidth: h.scrollWidth, clientWidth: h.clientWidth };
		});
		check('header: nothing overflows', header.scrollWidth <= header.clientWidth, header);
		check('header: search input hidden', !(await visible(page, '#search-input')));
		check('header: 🔍 toggle shown', await visible(page, '#search-toggle'));
		check('header: theme toggle shown', await visible(page, '#theme-toggle'));

		await page.tap('#search-toggle');
		const open = await page.evaluate(() => {
			const input = document.getElementById('search-input') as HTMLElement;
			const r = input.getBoundingClientRect();
			return {
				width: r.width,
				headerWidth: (document.querySelector('.header') as HTMLElement).clientWidth,
				focused: document.activeElement === input,
				fontSize: getComputedStyle(input).fontSize,
				expanded: document.getElementById('search-toggle')!.getAttribute('aria-expanded'),
			};
		});
		check('search open: input spans the header', open.width >= open.headerWidth - 40, open);
		check('search open: input focused', open.focused);
		check('search open: 16px text (no iOS zoom)', open.fontSize === '16px', open.fontSize);
		check('search open: aria-expanded', open.expanded === 'true', open.expanded);
		check('search open: header links hidden', !(await visible(page, '.header-left')));

		await page.fill('#search-input', 'Bravo');
		await page.waitForSelector('#search-results.active .search-result-item[data-uid]');
		const results = await page.evaluate(() => {
			const r = document.getElementById('search-results')!.getBoundingClientRect();
			return { left: r.left, width: r.width, screen: window.innerWidth };
		});
		check('search results span the screen', near(results.left, 0) && near(results.width, results.screen), results);

		await page.tap('.search-result-item[data-uid="note-b"]');
		await settle(page);
		check('picking a result collapses search', !(await page.evaluate(() =>
			document.querySelector('.header')!.classList.contains('search-open'))));
		check('picking a result opens the note', await page.evaluate(() =>
			!!document.querySelector('.panel[data-uid="note-b"]')));

		await page.tap('#search-toggle');
		await page.tap('.panel[data-uid="note-b"] p');
		check('tapping outside collapses search', !(await page.evaluate(() =>
			document.querySelector('.header')!.classList.contains('search-open'))));
	} finally {
		await close();
	}
}

async function iphoneChat(browser: Browser) {
	const { page, close } = await openSite(browser, IPHONE, profile(), '#/unote-a');
	try {
		await page.waitForSelector('#cpn-chat-launcher:not([hidden])');
		check('chat: panel hidden until opened', !(await visible(page, '#cpn-chat-panel')));
		await page.tap('#cpn-chat-launcher');
		const sheet = await page.evaluate(() => {
			const p = document.getElementById('cpn-chat-panel')!.getBoundingClientRect();
			const input = document.getElementById('cpn-chat-input') as HTMLElement;
			return {
				left: p.left, right: p.right, bottom: p.bottom, height: p.height,
				screenW: window.innerWidth, screenH: window.innerHeight,
				fontSize: getComputedStyle(input).fontSize,
			};
		});
		check('chat: full-width sheet', near(sheet.left, 0) && near(sheet.right, sheet.screenW), sheet);
		check('chat: anchored to the bottom', near(sheet.bottom, sheet.screenH), sheet);
		check('chat: tall enough to read', sheet.height >= sheet.screenH * 0.5, sheet);
		check('chat: 16px input text (no iOS zoom)', sheet.fontSize === '16px', sheet.fontSize);
		check('chat: no resize grip', !(await visible(page, '#cpn-chat-resize')));
	} finally {
		await close();
	}
}

async function customPanelWidth(browser: Browser) {
	const site = profile({
		siteCustomization: { siteTitle: 'Notes', panelWidth: 300, fontFamily: '', themeOverrides: {}, headerLinks: [] },
	});
	check('panelWidth 300 moves the breakpoint', renderer.renderStylesCss(site).includes('@media (max-width: 300px)'));
	const { page, close } = await openSite(browser, IPHONE, site, '#/unote-a/unote-b');
	try {
		const layout = await panelLayout(page);
		check('panelWidth 300: panels stay 300px on a phone', layout.panels.every((p) => near(p.width, 300)), layout.panels);
		check('panelWidth 300: no snapping', !layout.snapType.includes('mandatory'), layout.snapType);
	} finally {
		await close();
	}
}

async function narrowDesktopDrag(browser: Browser) {
	const { page, close } = await openSite(browser, { viewport: { width: 500, height: 800 } }, profile(), '#/unote-a');
	try {
		const before = await panelLayout(page);
		const edge = before.panels[0].left + before.panels[0].width - 3;
		await page.mouse.move(edge, 400);
		await page.mouse.down();
		await page.mouse.move(edge - 150, 400, { steps: 5 });
		await page.mouse.up();
		await settle(page);
		const after = await panelLayout(page);
		const hash = await page.evaluate(() => location.hash);
		check('narrow window: drag leaves the panel full-width', near(after.panels[0].width, after.containerWidth), after.panels[0].width);
		check('narrow window: drag writes no ;width=', !hash.includes('width='), hash);
	} finally {
		await close();
	}
}

async function desktop(browser: Browser) {
	const { page, close } = await openSite(browser, { viewport: { width: 1400, height: 900 } }, profile(), '#/unote-a/unote-b');
	try {
		const layout = await panelLayout(page);
		check('desktop: 600px panels', layout.panels.every((p) => near(p.width, 600)), layout.panels);
		check('desktop: no snapping', !layout.snapType.includes('mandatory'), layout.snapType);
		check('desktop: search input shown', await visible(page, '#search-input'));
		check('desktop: no 🔍 toggle', !(await visible(page, '#search-toggle')));
		check('desktop: header links shown', await visible(page, '.header-left'));
	} finally {
		await close();
	}
}

async function main() {
	const browser = await webkit.launch();
	try {
		await iphonePanels(browser);
		await iphoneHeader(browser);
		await iphoneChat(browser);
		await customPanelWidth(browser);
		await narrowDesktopDrag(browser);
		await desktop(browser);
	} finally {
		await browser.close();
	}

	if (failures.length) {
		console.error(`FAIL (${failures.length}):`);
		for (const f of failures) console.error(`  - ${f}`);
		process.exit(1);
	}
	console.log('All narrow-screen layout cases passed.');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
