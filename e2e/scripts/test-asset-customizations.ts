#!/usr/bin/env npx tsx
/**
 * Site-asset customization (route 2: snippet injection) unit test.
 *
 * Exercises the pure parsing + injection logic that turns per-profile `.md`
 * customization notes into snippets injected at named slots in the published
 * index.html / styles.css, plus an end-to-end pass through the REAL
 * renderIndexHtml / renderStylesCss. No Obsidian or AWS — the only transitive
 * `obsidian` import (in the renderer's type deps) is types-only.
 *
 * Guards:
 *   1. parseAssetCustomizationFile — accepts a valid note; rejects bad cpn-type,
 *      bad/missing cpn-slot, and a missing snippet fence.
 *   2. Slot derivation — asset is derived from the slot (no cpn-asset field).
 *   3. applyIndexHtmlSlots / applyStylesCssSlots — inject at the right token,
 *      concatenate same-slot snippets in filename order, no-op absent slots to
 *      '' (no leftover {{…}}), never cross-inject css into html, and are
 *      `$`-safe (a snippet containing $&/$1 survives verbatim).
 *   4. End-to-end — through the real renderIndexHtml, a head-extra <script>
 *      lands before <script src="app.js">, and extra-css lands in styles.css.
 *
 * Run: npx tsx e2e/scripts/test-asset-customizations.ts
 */

import * as parseModule from '../../src/publish/assetCustomizations/parse';
import * as rendererModule from '../../src/publish/siteRenderer';
import type { AssetCustomization } from '../../src/publish/assetCustomizations/types';
import type { PublishingProfile } from '../../src/types';

// tsx/Node ESM sometimes surfaces named src exports under `.default`; unwrap
// (same workaround as test-parser-pipeline.ts / test-site-config-matrix.ts).
const unwrap = (m: any) => (m?.parseAssetCustomizationFile ?? m?.renderIndexHtml ? m : m?.default ?? m);
const {
	parseAssetCustomizationFile,
	isAssetError,
	extractSnippetFence,
	applyIndexHtmlSlots,
	applyStylesCssSlots,
} = unwrap(parseModule);
const { renderIndexHtml, renderStylesCss } = unwrap(rendererModule);

const failures: string[] = [];
function check(label: string, cond: boolean, detail?: string) {
	if (!cond) failures.push(`${label}${detail ? `: ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a note body: frontmatter + a fenced block. */
function note(frontmatter: Record<string, unknown>, fenceLang: string, body: string): string {
	const fm = Object.entries(frontmatter)
		.map(([k, v]) => `${k}: ${v}`)
		.join('\n');
	return `---\n${fm}\n---\n\n\`\`\`${fenceLang}\n${body}\n\`\`\`\n`;
}

/** Parse a note and assert it succeeded, returning the descriptor. */
function parseOk(
	frontmatter: Record<string, unknown>,
	fenceLang: string,
	body: string,
	filePath: string,
): AssetCustomization {
	const r = parseAssetCustomizationFile(note(frontmatter, fenceLang, body), frontmatter, filePath);
	if (isAssetError(r)) {
		failures.push(`expected parse OK for ${filePath}, got error: ${r.message}`);
		return { asset: 'index.html', slot: 'head-extra', snippet: '', filePath, filename: filePath } as AssetCustomization;
	}
	return r;
}

// ---------------------------------------------------------------------------
// 1 + 2. Parsing & slot derivation
// ---------------------------------------------------------------------------

function testParsing() {
	// Valid head-extra note → index.html, snippet body preserved.
	const shim = '<script>console.log("hi")</script>';
	const okHead = parseOk({ 'cpn-type': 'asset', 'cpn-slot': 'head-extra' }, 'html', shim, 'assets/redirect.md');
	check('head-extra derives index.html', okHead.asset === 'index.html', okHead.asset);
	check('head-extra slot preserved', okHead.slot === 'head-extra');
	check('snippet body extracted', okHead.snippet.trim() === shim, JSON.stringify(okHead.snippet));
	check('filename derived from path', okHead.filename === 'redirect.md', okHead.filename);

	// Valid extra-css note → styles.css.
	const okCss = parseOk({ 'cpn-type': 'asset', 'cpn-slot': 'extra-css' }, 'css', 'body{color:red}', 'assets/tweak.md');
	check('extra-css derives styles.css', okCss.asset === 'styles.css', okCss.asset);

	// Rejections.
	const badType = parseAssetCustomizationFile(
		note({ 'cpn-type': 'parser', 'cpn-slot': 'head-extra' }, 'html', shim),
		{ 'cpn-type': 'parser', 'cpn-slot': 'head-extra' },
		'assets/x.md',
	);
	check('rejects wrong cpn-type', isAssetError(badType) && /cpn-type/.test(badType.message));

	const missingType = parseAssetCustomizationFile(
		note({ 'cpn-slot': 'head-extra' }, 'html', shim),
		{ 'cpn-slot': 'head-extra' },
		'assets/x.md',
	);
	check('rejects missing cpn-type', isAssetError(missingType));

	const badSlot = parseAssetCustomizationFile(
		note({ 'cpn-type': 'asset', 'cpn-slot': 'nonsense' }, 'html', shim),
		{ 'cpn-type': 'asset', 'cpn-slot': 'nonsense' },
		'assets/x.md',
	);
	check('rejects invalid cpn-slot', isAssetError(badSlot) && /cpn-slot/.test(badSlot.message));

	const missingSlot = parseAssetCustomizationFile(
		note({ 'cpn-type': 'asset' }, 'html', shim),
		{ 'cpn-type': 'asset' },
		'assets/x.md',
	);
	check('rejects missing cpn-slot', isAssetError(missingSlot));

	// Missing fence — frontmatter only, no code block.
	const noFence = parseAssetCustomizationFile(
		'---\ncpn-type: asset\ncpn-slot: head-extra\n---\n\njust prose, no fence\n',
		{ 'cpn-type': 'asset', 'cpn-slot': 'head-extra' },
		'assets/x.md',
	);
	check('rejects missing snippet fence', isAssetError(noFence) && /fence/.test(noFence.message));

	// Empty fence → treated as missing.
	check('extractSnippetFence null on empty', extractSnippetFence('```html\n\n```') === null);
	// js/javascript fences accepted.
	check('extractSnippetFence accepts js', extractSnippetFence('```js\nvar a=1;\n```')?.trim() === 'var a=1;');
}

// ---------------------------------------------------------------------------
// 3. Injection into fake templates
// ---------------------------------------------------------------------------

function mk(slot: AssetCustomization['slot'], snippet: string, filename: string): AssetCustomization {
	const asset = slot === 'extra-css' ? 'styles.css' : 'index.html';
	return { asset, slot, snippet, filePath: `assets/${filename}`, filename } as AssetCustomization;
}

function testInjection() {
	const template =
		'<head>{{HEAD_EXTRA}}</head><header>{{HEADER_EXTRA_HTML}}</header>' +
		'<main></main>{{FOOTER_HTML}}<body-end>{{BODY_END_SCRIPTS}}</body-end>';

	// Single injection per slot.
	const one = applyIndexHtmlSlots(template, [mk('head-extra', 'HEAD1', 'a.md')]);
	check('head-extra injected', one.includes('<head>HEAD1</head>'), one);
	check('unused slots emptied (no leftover braces)', !one.includes('{{'), one);

	// Concatenation order = filename ascending, regardless of array order.
	const concat = applyIndexHtmlSlots(template, [
		mk('head-extra', 'ZZZ', 'z.md'),
		mk('head-extra', 'AAA', 'a.md'),
		mk('head-extra', 'MMM', 'm.md'),
	]);
	check('same-slot concatenated in filename order', concat.includes('<head>AAA\nMMM\nZZZ</head>'), concat);

	// css injection is isolated — html replacer must not touch EXTRA_CSS, and
	// css replacer must not touch html tokens.
	const cssTemplate = '.a{}\n/* slot */\n{{EXTRA_CSS}}\n';
	const css = applyStylesCssSlots(cssTemplate, [mk('extra-css', '.custom{color:red}', 'c.md')]);
	check('extra-css injected', css.includes('.custom{color:red}'), css);
	check('extra-css token consumed', !css.includes('{{EXTRA_CSS}}'));
	// An html-targeting customization list must NOT bleed into css output.
	const cssNoHtml = applyStylesCssSlots(cssTemplate, [mk('head-extra', 'SHOULD_NOT_APPEAR', 'h.md')]);
	check('html snippet does not leak into css', !cssNoHtml.includes('SHOULD_NOT_APPEAR'), cssNoHtml);
	// And an html template with only a css customization stays empty at its slots.
	const htmlNoCss = applyIndexHtmlSlots(template, [mk('extra-css', 'CSSONLY', 'c.md')]);
	check('css snippet does not leak into html', !htmlNoCss.includes('CSSONLY'), htmlNoCss);

	// $-safety: a snippet containing $&, $1, $$ must survive verbatim (a literal
	// String.replace replacement would have interpreted these).
	const dollar = 'if (m) location.replace("$&" + "$1" + "$$");';
	const safe = applyIndexHtmlSlots(template, [mk('head-extra', dollar, 'a.md')]);
	check('$-sequences survive verbatim', safe.includes(`<head>${dollar}</head>`), safe);

	// Empty customization list → all tokens emptied, no throw.
	const empty = applyIndexHtmlSlots(template, []);
	check('empty list clears all html tokens', !empty.includes('{{'), empty);
	check('empty list clears css token', !applyStylesCssSlots(cssTemplate, []).includes('{{EXTRA_CSS}}'));
}

// ---------------------------------------------------------------------------
// 4. End-to-end through the real renderers
// ---------------------------------------------------------------------------

function testEndToEnd() {
	const profile = { id: 'p1', name: 'P1', siteCustomization: undefined } as unknown as PublishingProfile;

	const shim = '<script>/*redirect shim*/</script>';
	const html = renderIndexHtml(profile, 'abc123', [mk('head-extra', shim, 'redirect.md')]);
	check('e2e: shim present in output', html.includes(shim), 'shim missing');
	const shimIdx = html.indexOf(shim);
	const appIdx = html.indexOf('app.js');
	check('e2e: head-extra runs before app.js (pre-boot)', shimIdx !== -1 && appIdx !== -1 && shimIdx < appIdx,
		`shimIdx=${shimIdx} appIdx=${appIdx}`);
	check('e2e: no leftover slot tokens in index.html', !/\{\{(HEAD_EXTRA|BODY_END_SCRIPTS|HEADER_EXTRA_HTML|FOOTER_HTML)\}\}/.test(html));
	// Structured substitutions still apply alongside snippet injection.
	check('e2e: home uid script still substituted', html.includes('window.__CPN_HOME_UID__ = "abc123"'));

	// No customizations → tokens still cleared (default arg path).
	const plain = renderIndexHtml(profile, 'abc123');
	check('e2e: default (no customizations) clears tokens', !/\{\{(HEAD_EXTRA|BODY_END_SCRIPTS|HEADER_EXTRA_HTML|FOOTER_HTML)\}\}/.test(plain));

	const css = renderStylesCss(profile, [mk('extra-css', '.brand{color:#09c}', 'brand.md')]);
	check('e2e: extra-css injected into styles.css', css.includes('.brand{color:#09c}'), 'css snippet missing');
	check('e2e: no leftover css token', !css.includes('{{EXTRA_CSS}}'));
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function main() {
	testParsing();
	testInjection();
	testEndToEnd();

	if (failures.length === 0) {
		console.log('All asset-customization cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} asset-customization assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main();
