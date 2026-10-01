#!/usr/bin/env npx tsx
/**
 * Site Assets Rendering Unit Test
 *
 * Exercises renderSiteAssets(): the long-cached scripts and styles get
 * content-hashed names, index.html (no-cache) references exactly those names,
 * and the fingerprint publish uses to decide whether to re-push the site code
 * tracks the site files but not config.json.
 *
 * Regression for the zach.nz access-groups failure: publishing never re-pushed
 * app.js after a plugin update, and the old app.js was cached `immutable`
 * under an unchanging name, so readers kept running site code with no
 * access-group support.
 *
 * Pure functions — no AWS SDK or Obsidian imports.
 *
 * Run: npx tsx e2e/scripts/test-site-assets.ts
 */

import * as rendererModule from '../../src/publish/siteRenderer';
import type { PublishingProfile } from '../../src/types';

// tsx/Node ESM sometimes surfaces named src exports under `.default`.
const renderer: any = (rendererModule as any).renderSiteAssets !== undefined
	? rendererModule
	: (rendererModule as any).default;
const { renderSiteAssets, renderIndexHtml } = renderer;

const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string) {
	if (!cond) failures.push(`${label}${detail ? `: ${detail}` : ''}`);
}

function profile(overrides: Partial<PublishingProfile> = {}): PublishingProfile {
	return {
		name: 'Test', id: 'test', lastFullPublishTimestamp: 0, excludedDirectories: [],
		baseUrl: 'https://notes.example.com/', homeNotePath: '', isPublic: true,
		publishContentIndex: true, obscureRawWikilinks: true, publishMechanism: 'AWS',
		...overrides,
	} as PublishingProfile;
}

async function main() {
	const { files, fingerprint } = await renderSiteAssets(profile(), 'HOME123');
	const names = files.map((f: any) => f.name);
	const byName = (re: RegExp) => files.find((f: any) => re.test(f.name));

	// --- Names and upload order ---
	const hashedPatterns: Array<[string, RegExp]> = [
		['styles', /^styles\.[0-9a-f]{12}\.css$/],
		['flexsearch', /^flexsearch\.min\.[0-9a-f]{12}\.js$/],
		['vendor', /^vendor\.[0-9a-f]{12}\.js$/],
		['app', /^app\.[0-9a-f]{12}\.js$/],
	];
	for (const [label, re] of hashedPatterns) {
		check(`${label} has a content-hashed name`, !!byName(re), names.join(', '));
	}
	check('upload order: hashed assets, then index.html, then config.json',
		names.length === 6 && names[4] === 'index.html' && names[5] === 'config.json', names.join(', '));

	// --- Caching headers ---
	for (const f of files) {
		const wantImmutable = f.name !== 'index.html' && f.name !== 'config.json';
		check(`${f.name} cache policy`, wantImmutable
			? f.cacheControl === 'public, max-age=31536000, immutable'
			: f.cacheControl === 'no-cache', f.cacheControl);
	}

	// --- index.html references exactly the hashed names ---
	const html: string = byName(/^index\.html$/).body;
	for (const [label, re] of hashedPatterns) {
		const name = byName(re)?.name;
		check(`index.html loads hashed ${label}`, !!name && html.includes(`"${name}"`), name);
	}
	check('index.html has no unhashed asset references',
		!/(src|href)="(app\.js|vendor\.js|flexsearch\.min\.js|styles\.css)"/.test(html));
	check('index.html has no unfilled path placeholders', !/\{\{[A-Z_]+_PATH\}\}/.test(html));

	// --- Hash tracks content ---
	const app = byName(/^app\./);
	check('app.js hash is stable for the same code', (await renderSiteAssets(profile(), 'HOME123')).files.find((f: any) => f.name === app.name) !== undefined);
	const wide = await renderSiteAssets(profile({ siteCustomization: { siteTitle: '', headerLinks: [], panelWidth: 900, fontFamily: '', themeOverrides: {} } as any }), 'HOME123');
	const wideStyles = wide.files.find((f: any) => /^styles\./.test(f.name));
	check('a styles change renames styles.css', wideStyles?.name !== byName(/^styles\./).name);
	check('a styles change leaves app.js named the same', wide.files.some((f: any) => f.name === app.name));

	// --- Fingerprint: site files yes, config.json no ---
	check('fingerprint is stable', (await renderSiteAssets(profile(), 'HOME123')).fingerprint === fingerprint);
	check('fingerprint changes when the site files change', wide.fingerprint !== fingerprint);
	// fontFamily reaches the site only through config.json.
	const font = await renderSiteAssets(profile({ siteCustomization: { siteTitle: '', headerLinks: [], panelWidth: 600, fontFamily: 'Georgia, serif', themeOverrides: {} } as any }), 'HOME123');
	check('fontFamily changes config.json', font.files[5].body !== files[5].body);
	check('a config.json-only change keeps the fingerprint', font.fingerprint === fingerprint);

	// --- Back-compat: renderIndexHtml defaults to the plain names ---
	const plain: string = renderIndexHtml(profile(), 'HOME123');
	check('renderIndexHtml defaults to plain names',
		plain.includes('src="app.js"') && plain.includes('href="styles.css"') && !/\{\{[A-Z_]+_PATH\}\}/.test(plain));

	report();
}

function report() {
	if (failures.length === 0) {
		console.log('All site asset cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} site asset assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

void main();
