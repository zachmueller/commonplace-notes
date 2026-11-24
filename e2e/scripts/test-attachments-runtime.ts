#!/usr/bin/env npx tsx
/**
 * Attachment Runtime Test (attachment spec P2 §9, §10 "Site")
 *
 * Loads the generated SITE_APP_JS into jsdom (as test-transclusions-runtime.ts
 * does) and checks the published SPA's attachment handling:
 *
 *   U  hydrateAttachments URL building and encoding: area prefix, odd names,
 *      fragments, bad keys skipped, a second pass leaves elements alone, no
 *      innerHTML.
 *   S  Embedded-note scoping: a gated host's own files load from its
 *      restricted area, an embedded public note's files from attachments/.
 *   E  Each HEAD branch of the media error handler: 401 (sign-in label, no
 *      automatic reload, link reloads); 403 restricted with whoami signedIn
 *      false (sign-in link) and true (unavailable); 403 public (unavailable);
 *      404; 2xx for audio and video (can't play + Download) and img
 *      (unavailable); network failure (unavailable).
 *   D  Diff: hash-to-name rewriting (dotted and bare hashes, one hash under two
 *      names, null.<ext> and missing lists left alone), the bytes-only change
 *      notice "The text is identical. Attachments changed: …", the notice
 *      above a real diff, and escaping of names in notices.
 *
 * Run: npx tsx e2e/scripts/test-attachments-runtime.ts
 */

import { JSDOM, VirtualConsole } from 'jsdom';
import * as assetsModule from '../../src/publish/siteAssets';

const assets: any = (assetsModule as any).SITE_APP_JS !== undefined ? assetsModule : (assetsModule as any).default;
const SITE_APP_JS: string = assets.SITE_APP_JS;

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

const img = (sha: string, name: string, extra = '') => `<img class="cpn-attachment cpn-attachment-image" data-cpn-attachment="${sha}/${name}" alt="${name}" loading="lazy"${extra}>`;
const audio = (sha: string, name: string) => `<audio class="cpn-attachment cpn-attachment-audio" controls preload="metadata" data-cpn-attachment="${sha}/${name}"></audio>`;
const ph = (uid: string) => `<div class="cpn-transclusion" data-uid="${uid}" data-title="${uid}"><a href="#/u${uid}">${uid}</a></div>`;

const NOTES: Record<string, { areas: string[]; note: any }> = {
	// A gated host (restricted/fam/) embedding a public note.
	'h-G': { areas: ['restricted/fam/'], note: { uid: 'G', title: 'Gated', gated: true, raw: '', content: `<p>${img(A, 'host.png')}</p>${ph('PUB')}` } },
	'h-PUB': { areas: [''], note: { uid: 'PUB', title: 'Public', raw: '', content: `<p>${audio(B, 'pub song.mp3')}</p>` } },
	// Diff revisions: bytes-only change, Obscure attachment names on.
	'h-v1': { areas: [''], note: { uid: 'V', title: 'V', raw: `Listen ![[${A}.mp3]] and [[${C}]]`, content: '<p>v1</p>', attachments: [{ key: `${A}/song.mp3`, name: 'song.mp3', size: 1 }, { key: `${C}/LICENSE`, name: 'LICENSE', size: 1 }] } },
	'h-v2': { areas: [''], note: { uid: 'V', title: 'V', raw: `Listen ![[${B}.mp3]] and [[${C}]]`, content: '<p>v2</p>', attachments: [{ key: `${B}/song.mp3`, name: 'song.mp3', size: 1 }, { key: `${C}/LICENSE`, name: 'LICENSE', size: 1 }] } },
	'h-v3': { areas: [''], note: { uid: 'V', title: 'V', raw: `New text ![[${B}.mp3]]`, content: '<p>v3</p>', attachments: [{ key: `${B}/a<b>&.mp3`, name: 'a<b>&.mp3', size: 1 }] } },
};
for (const n of Object.values(NOTES)) n.note.backlinks = [];
const UID_TO_HASH: Record<string, string> = { G: 'h-G', PUB: 'h-PUB', V: 'h-v2' };

type HeadReply = number | 'network';
let headReply: HeadReply = 404;
let whoami = { groups: ['fam'], signedIn: true };
const fetched: Array<{ url: string; init?: any }> = [];
const noHeaders = { get: () => null };

function json(obj: any, status = 200) {
	return { ok: status >= 200 && status < 300, status, headers: noHeaders, json: async () => obj } as any;
}

function makeFetch() {
	return async (url: string, init?: any) => {
		const u = String(url);
		fetched.push({ url: u, init });
		if (init?.method === 'HEAD') {
			if (headReply === 'network') throw new TypeError('Failed to fetch');
			return { ok: headReply >= 200 && headReply < 300, status: headReply, headers: noHeaders } as any;
		}
		if (u.endsWith('/restricted/whoami')) return json(whoami);
		if (u.includes('static/mapping/uid-to-hash.json')) return json(u.includes('restricted/') ? {} : UID_TO_HASH);
		if (u.includes('static/mapping/slug-to-uid.json')) return json({});
		if (u.includes('static/content/contentIndex.json')) return json({});
		const m = /^\/((?:restricted\/[a-z0-9-]+\/)?)notes\/([^/]+)\.json$/.exec(u);
		if (m) {
			const entry = NOTES[m[2]];
			if (entry && entry.areas.includes(m[1])) return json(JSON.parse(JSON.stringify(entry.note)));
			return { ok: false, status: 403, headers: noHeaders, json: async () => ({}) } as any;
		}
		return { ok: false, status: 404, headers: noHeaders, json: async () => ({}) } as any;
	};
}

const failures: string[] = [];
let checks = 0;
function check(cond: boolean, msg: string) {
	checks++;
	if (!cond) failures.push(msg);
}
const nextTick = (ms = 0) => new Promise(r => setTimeout(r, ms));
async function settle() {
	for (let i = 0; i < 15; i++) await nextTick(0);
}

async function main() {
	// jsdom can't navigate, so a location.reload() surfaces as a
	// "Not implemented: navigation" jsdomError: count those as reloads.
	let reloads = 0;
	const virtualConsole = new VirtualConsole();
	virtualConsole.on('jsdomError', (e: Error) => {
		if (/navigation/.test(e.message)) reloads++;
		else console.error(e);
	});
	const dom = new JSDOM(
		`<!DOCTYPE html><html><body><div class="header-right"></div><div class="panels-container" id="panels"></div></body></html>`,
		{ url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole },
	);
	const { window } = dom;
	const doc = window.document;
	const W = window as any;

	W.fetch = makeFetch();
	W.__CPN_CONFIG__ = { accessGating: true, accessWhoamiPath: '/restricted/whoami', authLoginUrl: 'https://auth.example/login' };
	W.__CPN_CONFIG_READY__ = Promise.resolve();
	W.FlexSearch = { Document: class { add() {} async search() { return []; } } };
	if (!W.matchMedia) W.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
	W.HTMLElement.prototype.scrollIntoView = function () {};
	if (!W.CSS || typeof W.CSS.escape !== 'function') W.CSS = { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
	W.requestAnimationFrame = (cb: any) => window.setTimeout(() => cb(0), 0);
	let patchedRaws: string[] = [];
	W.Diff = { createTwoFilesPatch: (_a: string, _b: string, left: string, right: string) => { patchedRaws = [left, right]; return 'patch'; } };
	W.Diff2Html = { html: () => '<div class="d2h-stub">diff</div>' };

	window.eval(`
		${SITE_APP_JS}
		window.__addPanel = addPanel;
		window.__loadedPanels = loadedPanels;
		window.__hydrateAttachments = hydrateAttachments;
		window.__rawWithAttachmentNames = rawWithAttachmentNames;
		window.__changedAttachmentNames = changedAttachmentNames;
	`);
	await settle();
	W.__loadedPanels.clear();
	(doc.getElementById('panels') as HTMLElement).innerHTML = '';

	// ===================================================================
	// U — URL building and encoding
	// ===================================================================
	{
		const root = doc.createElement('div');
		const odd = 'my "song" #1 ?x %y ü.mp3';
		root.innerHTML = [
			img(A, 'pic.png'),
			`<audio data-cpn-attachment='${A}/${odd.replace(/"/g, '&quot;')}'></audio>`,
			`<video data-cpn-attachment="${B}/clip.mp4"></video>`,
			`<a class="cpn-attachment cpn-attachment-file" data-cpn-attachment="${C}/slides.pdf" data-cpn-fragment="page=3" target="_blank" rel="noopener">slides.pdf</a>`,
			`<img data-cpn-attachment="nothex/x.png">`,
			`<img data-cpn-attachment="${A}">`,
		].join('');
		W.__hydrateAttachments(root, '');
		const els = root.querySelectorAll('[data-cpn-attachment]');
		check((els[0] as any).getAttribute('src') === `/attachments/${A}/pic.png`, 'U1: img src in the public area');
		check((els[1] as any).getAttribute('src') === `/attachments/${A}/${encodeURIComponent(odd)}`, `U2: odd name encoded (got ${(els[1] as any).getAttribute('src')})`);
		check((els[2] as any).getAttribute('src') === `/attachments/${B}/clip.mp4`, 'U3: video src');
		check((els[3] as any).getAttribute('href') === `/attachments/${C}/slides.pdf#page=3`, 'U4: link href with fragment');
		check((els[3] as any).getAttribute('target') === '_blank' && (els[3] as any).getAttribute('rel') === 'noopener', 'U5: link keeps target/rel');
		check(!(els[4] as any).hasAttribute('src') && !(els[5] as any).hasAttribute('src'), 'U6: malformed keys get no URL');
		check(Array.from(els).every((e: any) => e.getAttribute('data-cpn-att') === '1'), 'U7: every element marked handled');
		W.__hydrateAttachments(root, 'restricted/fam/');
		check((els[0] as any).getAttribute('src') === `/attachments/${A}/pic.png`, 'U8: a second pass leaves handled elements alone');

		const r2 = doc.createElement('div');
		r2.innerHTML = img(A, 'pic.png');
		W.__hydrateAttachments(r2, 'restricted/fam/');
		check((r2.firstChild as any).getAttribute('src') === `/restricted/fam/attachments/${A}/pic.png`, 'U9: restricted area prefix');
		const r3 = doc.createElement('div');
		r3.innerHTML = img(A, 'pic.png');
		W.__hydrateAttachments(r3, '../evil/');
		check(!(r3.firstChild as any).hasAttribute('src'), 'U10: an unexpected prefix is refused');
		const lone = doc.createElement('div');
		lone.innerHTML = img(A, 'p.png');
		const imgEl = lone.firstChild as any;
		W.__hydrateAttachments(imgEl, '');
		check(imgEl.getAttribute('src') === `/attachments/${A}/p.png`, 'U11: root itself is hydrated');
	}

	// ===================================================================
	// S — embedded-note scoping
	// ===================================================================
	{
		await W.__addPanel('p', 'h-G');
		await settle();
		const panel = doc.querySelector('.panel[data-param-type="p"]') as HTMLElement;
		check(!!panel, 'S0: gated host panel rendered');
		const hostImg = panel?.querySelector(`img[data-cpn-attachment="${A}/host.png"]`) as any;
		check(hostImg?.getAttribute('src') === `/restricted/fam/attachments/${A}/host.png`, `S1: host file from its restricted area (got ${hostImg?.getAttribute('src')})`);
		const embedded = panel?.querySelector('.cpn-transclusion audio') as any;
		check(!!embedded, 'S2: embedded note injected');
		check(embedded?.getAttribute('src') === `/attachments/${B}/${encodeURIComponent('pub song.mp3')}`, `S3: embedded public note's file from attachments/ (got ${embedded?.getAttribute('src')})`);
		W.__loadedPanels.clear();
		(doc.getElementById('panels') as HTMLElement).innerHTML = '';
	}

	// ===================================================================
	// E — media error handler
	// ===================================================================
	async function failMedia(tag: 'img' | 'audio' | 'video', prefix: string, reply: HeadReply, who = { groups: ['fam'], signedIn: true }) {
		headReply = reply;
		whoami = who;
		const root = doc.createElement('div');
		doc.body.appendChild(root);
		root.innerHTML = tag === 'img' ? img(A, 'x.png') : `<${tag} data-cpn-attachment="${A}/x.mp3"></${tag}>`;
		W.__hydrateAttachments(root, prefix);
		const el = root.firstChild as any;
		fetched.length = 0;
		el.dispatchEvent(new window.Event('error'));
		el.dispatchEvent(new window.Event('error'));
		await settle();
		const label = root.querySelector('.cpn-attachment-unavailable') as HTMLElement | null;
		const heads = fetched.filter(f => f.init?.method === 'HEAD');
		return { el, label, text: label?.textContent ?? '', heads, root };
	}

	{
		// Cognito gate: the link goes to the Hosted UI with the note route in state.
		const r = await failMedia('audio', '', 401);
		const a = r.label?.querySelector('a') as HTMLAnchorElement;
		check(r.text === 'Your session has ended. Sign in again to play this.', `E1a: 401 → session-ended label (got ${JSON.stringify(r.text)})`);
		check(!!a && a.getAttribute('href')!.startsWith('https://auth.example/login?state='), `E1a: Cognito gate links to the Hosted UI (got ${a?.getAttribute('href')})`);
	}
	{
		// Password gate (no Hosted UI): the link reloads.
		const login = W.__CPN_CONFIG__.authLoginUrl;
		delete W.__CPN_CONFIG__.authLoginUrl;
		const before = reloads;
		const r = await failMedia('audio', '', 401);
		check(r.heads.length === 1 && r.heads[0].init.cache === 'no-store', 'E0: exactly one HEAD, no-store, even after two error events');
		check(r.text === 'Your session has ended. Sign in again to play this.', `E1: 401 → session-ended label (got ${JSON.stringify(r.text)})`);
		check(reloads === before, 'E1: no automatic reload');
		check(!fetched.some(f => f.url.endsWith('/restricted/whoami')), 'E1: 401 skips whoami');
		const link = r.label?.querySelector('a') as HTMLElement;
		link?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
		check(reloads === before + 1, 'E1: the link reloads the page');
		W.__CPN_CONFIG__.authLoginUrl = login;
	}
	{
		const r = await failMedia('video', '', 401);
		check(r.text.startsWith('Your session has ended.'), 'E2: 401 on a password gate (video) → same label');
	}
	{
		const r = await failMedia('audio', 'restricted/fam/', 403, { groups: [], signedIn: false });
		const a = r.label?.querySelector('a') as HTMLAnchorElement;
		check(r.text === 'Sign in again to play this', `E3: 403 restricted, signed out → sign-in (got ${JSON.stringify(r.text)})`);
		check(!!a && a.getAttribute('href')!.startsWith('https://auth.example/login?state='), 'E3: link is the Hosted UI login');
		check(fetched.some(f => f.url.endsWith('/restricted/whoami') && f.init?.cache === 'no-store'), 'E3: whoami fetched no-store');
	}
	{
		const r = await failMedia('audio', 'restricted/fam/', 403, { groups: ['fam'], signedIn: true });
		check(r.text === 'Attachment unavailable', 'E4: 403 restricted, signed in → unavailable');
	}
	{
		const r = await failMedia('audio', '', 403);
		check(r.text === 'Attachment unavailable' && !fetched.some(f => f.url.endsWith('/restricted/whoami')), 'E5: 403 public → unavailable, no whoami');
	}
	{
		const r = await failMedia('audio', '', 404);
		check(r.text === 'Attachment unavailable', 'E6: 404 → unavailable');
	}
	for (const tag of ['audio', 'video'] as const) {
		const r = await failMedia(tag, '', 200);
		const dl = r.label?.querySelector('a') as HTMLAnchorElement;
		check(r.text === "This browser can't play this file. Download", `E7: 2xx ${tag} → can't play (got ${JSON.stringify(r.text)})`);
		check(dl?.getAttribute('href') === `/attachments/${A}/x.mp3` && dl.hasAttribute('download'), `E7: ${tag} Download link to the same URL`);
	}
	{
		const r = await failMedia('img', '', 200);
		check(r.text === 'Attachment unavailable' && r.el.hidden === true, 'E8: 2xx img (corrupt) → unavailable, image hidden');
	}
	{
		const r = await failMedia('audio', '', 'network');
		check(r.text === 'Attachment unavailable', 'E9: network failure → unavailable');
	}

	// ===================================================================
	// D — diff
	// ===================================================================
	{
		const rw = W.__rawWithAttachmentNames;
		check(rw(`![[${A}.mp3]] ![](${A}.mp3) [[${C}]] ![[null.png]]`, [{ key: `${A}/song.mp3`, name: 'song.mp3' }, { key: `${C}/LICENSE`, name: 'LICENSE' }])
			=== '![[song.mp3]] ![](song.mp3) [[LICENSE]] ![[null.png]]', 'D1: dotted and bare hashes become names; null.<ext> left');
		check(rw(`![[${A}.png]]`, [{ key: `${A}/z.png`, name: 'z.png' }, { key: `${A}/b.png`, name: 'b.png' }]) === '![[b.png]]', 'D2: one hash under two names → first by key');
		check(rw(`![[${A}.mp3]]`, undefined) === `![[${A}.mp3]]`, 'D3: missing list left alone');
		check(rw(`![[${A}.mp3]]`, [{ key: `${A}/$&.mp3`, name: '$&.mp3' }]) === '![[$&.mp3]]', 'D4: replacement patterns in names are literal');
		const ch = W.__changedAttachmentNames;
		check(JSON.stringify(ch([{ key: `${A}/song.mp3`, name: 'song.mp3' }], [{ key: `${B}/song.mp3`, name: 'song.mp3' }, { key: `${C}/cover.png`, name: 'cover.png' }])) === '["song.mp3","cover.png"]', 'D5: changed names de-duplicated');
		check(ch(undefined, undefined).length === 0, 'D6: no lists → nothing changed');

		await W.__addPanel('u', 'V', null, null, { diff: 'ph-v1' });
		await settle();
		const notice = doc.querySelector('.panel .diff-notice')?.textContent ?? '';
		check(notice === 'The text is identical. Attachments changed: song.mp3.', `D7: bytes-only change notice (got ${JSON.stringify(notice)})`);
		check(!doc.querySelector('.panel.diff-panel'), 'D7: no diff panel for identical text');
		W.__loadedPanels.clear();
		(doc.getElementById('panels') as HTMLElement).innerHTML = '';

		UID_TO_HASH.V = 'h-v3';
		W.__loadedPanels.clear();
		await W.__addPanel('u', 'V', null, null, { diff: 'ph-v1' });
		await settle();
		const diffPanel = doc.querySelector('.panel.diff-panel') as HTMLElement;
		const dn = diffPanel?.querySelector('.diff-notice') as HTMLElement;
		check(!!diffPanel, 'D8: real diff renders a diff panel');
		check(dn?.textContent === 'Attachments changed: song.mp3, LICENSE, a<b>&.mp3.', `D8: notice above the diff (got ${JSON.stringify(dn?.textContent)})`);
		check(!dn?.querySelector('b'), 'D9: file names in notices are escaped');
		check(patchedRaws[0] === 'Listen ![[song.mp3]] and [[LICENSE]]' && patchedRaws[1] === 'New text ![[a<b>&.mp3]]', `D10: diff compares name-rewritten raw (got ${JSON.stringify(patchedRaws)})`);
	}

	if (failures.length === 0) {
		console.log(`All ${checks} attachment runtime checks passed.`);
		process.exit(0);
	}
	console.log(`${failures.length}/${checks} attachment runtime check(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
