#!/usr/bin/env npx tsx
/**
 * Per-note Access: SPA Client Test
 *
 * Loads the generated SITE_APP_JS into jsdom with a stubbed fetch that mimics
 * the edge + S3 behavior for a site with access groups, and checks:
 *   - with accessGating: the client asks whoami once, merges the public and
 *     member-group mapping mirrors, and loads a gated note from its partition
 *     (going straight to the right prefix, never probing public first)
 *   - notes in groups the viewer isn't in are not resolvable (no leak)
 *   - gated notes render a lock badge; public notes don't
 *   - without accessGating: no whoami call and no restricted fetches at all
 *   - public site (edge in public-reads mode), anonymous viewer: whoami says
 *     { groups: [], signedIn: false }, public notes load, gated notes don't, the
 *     page never reload-loops, and a header "Sign in" link (plus one on the
 *     not-found panel, whose wording is unchanged) points at the Hosted UI
 *   - signed-in member on a public site: no "Sign in" link
 *
 * Run: npx tsx e2e/scripts/test-access-client.ts
 */

import { JSDOM, VirtualConsole } from 'jsdom';
import * as assetsModule from '../../src/publish/siteAssets';

const assets: any =
	(assetsModule as any).SITE_APP_JS !== undefined ? assetsModule : (assetsModule as any).default;
const SITE_APP_JS: string = assets.SITE_APP_JS;

const failures: string[] = [];
function check(cond: boolean, msg: string) {
	if (!cond) failures.push(msg);
}

const headers = (h: Record<string, string> = {}) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
const ok = (obj: any) => ({ ok: true, status: 200, headers: headers(), json: async () => obj });
// S3 behind OAC answers a missing key with a bare 403 (no x-cpn-auth header).
const missing = () => ({ ok: false, status: 403, headers: headers(), json: async () => ({}) });
const forbidden = () => ({ ok: false, status: 403, headers: headers({ 'x-cpn-auth': 'forbidden' }), json: async () => ({ error: 'cpn_forbidden' }) });

const note = (uid: string, hash: string, extra: any = {}) => ({
	uid, slug: '', title: 'Note ' + uid, hash, lastUpdated: null, content: '<p>' + uid + '</p>', backlinks: [], ...extra,
});

type Viewer = 'team' | 'anon' | 'team-public';

// What the edge + bucket serve: to a viewer in group "team" only (whole-site
// gate, or 'team-public' on a public site), or to an anonymous viewer of a
// public site (the edge answers every restricted path with 403 forbidden).
function siteFetch(log: string[], viewer: Viewer = 'team') {
	return async (url: string) => {
		const u = String(url);
		log.push(u);
		if (viewer === 'anon') {
			if (u === '/restricted/whoami') return ok({ groups: [], email: '', signedIn: false });
			if (u.startsWith('/restricted/')) return forbidden();
		}
		if (u === '/restricted/whoami') {
			return ok(viewer === 'team-public'
				? { groups: ['team'], email: 'a@x.com', signedIn: true }
				: { groups: ['team'], email: 'a@x.com' }); // older edge fn: no signedIn
		}
		if (u === '/static/mapping/uid-to-hash.json') return ok({ PUB: 'hpub' });
		if (u === '/static/mapping/slug-to-uid.json') return ok({ 'pub.md': 'PUB' });
		if (u === '/restricted/team/static/mapping/uid-to-hash.json') return ok({ SEC: 'hsec' });
		if (u === '/restricted/team/static/mapping/slug-to-uid.json') return ok({ 'secret.md': 'SEC' });
		if (u.startsWith('/restricted/ops/')) return forbidden();
		if (u === '/notes/hpub.json') return ok(note('PUB', 'hpub'));
		if (u === '/restricted/team/notes/hsec.json') return ok(note('SEC', 'hsec', { gated: true }));
		if (u === '/static/content/contentIndex.json') return ok({});
		return missing();
	};
}

const LOGIN = 'https://pool.auth.us-east-1.amazoncognito.com/oauth2/authorize?client_id=c&response_type=code';
const PUBLIC_SITE = { version: 1, accessGating: true, accessWhoamiPath: '/restricted/whoami', authLoginUrl: LOGIN };

async function boot(config: any, log: string[], viewer: Viewer = 'team') {
	const dom = new JSDOM(`<!DOCTYPE html><html><body>
		<header class="header"><div class="header-left"></div><div class="header-right"><button id="theme-toggle"></button></div></header>
		<div class="panels-container" id="panels"></div></body></html>`,
		{ url: 'https://example.test/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
	const w = dom.window as any;
	w.fetch = siteFetch(log, viewer);
	w.__CPN_CONFIG__ = config;
	w.__CPN_CONFIG_READY__ = Promise.resolve();
	w.FlexSearch = { Document: class { add() {} async search() { return []; } } };
	w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
	w.HTMLElement.prototype.scrollIntoView = function () {};
	w.CSS = w.CSS && typeof w.CSS.escape === 'function' ? w.CSS : { escape: (s: string) => s };
	w.requestAnimationFrame = (cb: any) => w.setTimeout(() => cb(0), 0);
	// loadNoteByParameter throws on a failed load (the error panel shows why);
	// map that to null so "does not load" reads as a plain check below.
	w.eval(`${SITE_APP_JS}
		window.__loadNoteByParameter = (type, value) => loadNoteByParameter(type, value).catch(() => null);
		window.__createPanel = createPanel;`);
	for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
	return w;
}

async function main() {
	// --- Gating on, viewer in "team" -----------------------------------------
	{
		const log: string[] = [];
		const w = await boot({ version: 1, accessGating: true, accessWhoamiPath: '/restricted/whoami' }, log);
		log.length = 0;

		const pub = await w.__loadNoteByParameter('u', 'PUB');
		check(pub && pub.uid === 'PUB', 'public note loads');
		const sec = await w.__loadNoteByParameter('u', 'SEC');
		check(sec && sec.uid === 'SEC' && sec.gated === true, 'gated team note loads for a team member');
		const secFetches = log.filter((u) => u.includes('hsec'));
		check(secFetches[0] === '/restricted/team/notes/hsec.json', `gated note fetched from its partition first (got ${secFetches.join(', ')})`);
		check(!log.includes('/notes/hsec.json'), 'no public probe for a known gated hash');
		const bySlug = await w.__loadNoteByParameter('~', 'secret.md');
		check(bySlug && bySlug.uid === 'SEC', 'gated note resolves by slug via the group slug mirror');
		const other = await w.__loadNoteByParameter('u', 'OPSNOTE');
		check(other === null, 'a note outside the viewer\'s groups does not resolve');
		check(!log.some((u) => u.startsWith('/restricted/ops/')), 'never touches partitions of groups the viewer lacks');
		check(log.filter((u) => u === '/restricted/whoami').length <= 1, 'whoami requested at most once (memoized)');

		const gatedPanel = w.__createPanel(sec, 0);
		check(!!gatedPanel.querySelector('.gated-badge'), 'gated note renders a lock badge');
		const pubPanel = w.__createPanel(pub, 0);
		check(!pubPanel.querySelector('.gated-badge'), 'public note has no lock badge');
	}

	// --- Gating off: public-only behavior --------------------------------------
	{
		const log: string[] = [];
		const w = await boot({ version: 1 }, log);
		const pub = await w.__loadNoteByParameter('u', 'PUB');
		check(pub && pub.uid === 'PUB', 'public note loads without gating');
		const sec = await w.__loadNoteByParameter('u', 'SEC');
		check(sec === null, 'gated note is unreachable without gating');
		check(!log.some((u) => u.startsWith('/restricted/')), `no restricted fetches when gating is off (got ${log.filter((u) => u.startsWith('/restricted/')).join(', ')})`);
	}

	// --- Public site, anonymous viewer ------------------------------------------
	{
		const log: string[] = [];
		const w = await boot(PUBLIC_SITE, log, 'anon');
		const pub = await w.__loadNoteByParameter('u', 'PUB');
		check(pub && pub.uid === 'PUB', 'anon: public note loads on a public site');
		const sec = await w.__loadNoteByParameter('u', 'SEC');
		check(sec === null, 'anon: gated note does not load');
		const restricted = log.filter((u) => u.startsWith('/restricted/'));
		check(restricted.every((u) => u === '/restricted/whoami'), `anon: only whoami under /restricted/ (got ${restricted.join(', ')})`);
		check(restricted.length === 1, `anon: whoami requested once (got ${restricted.length})`);
		check(w.sessionStorage.getItem('cpn_pw_reload') !== '1', 'anon: no auth-gate reload on a public site');
		const signin = w.document.querySelector('.header-right .site-signin');
		check(!!signin, 'anon: header shows a Sign in link');
		check(!!signin && String(signin.getAttribute('href')).startsWith(LOGIN + '&state='), `anon: Sign in points at the Hosted UI with a return state (got ${signin?.getAttribute('href')})`);
		const errPanel = w.__createPanel({ uid: 'SEC' }, 0, true);
		const errText = errPanel.textContent || '';
		check(errText.includes('The note might not exist or you may not have permission to view it.'), 'anon: not-found wording unchanged');
		check(!!errPanel.querySelector('a.error-signin'), 'anon: not-found panel offers sign-in');
	}

	// --- Public site, signed-in member -------------------------------------------
	{
		const log: string[] = [];
		const w = await boot(PUBLIC_SITE, log, 'team-public');
		const sec = await w.__loadNoteByParameter('u', 'SEC');
		check(sec && sec.uid === 'SEC', 'member: gated note loads on a public site');
		check(!w.document.querySelector('.site-signin'), 'member: no Sign in link when signed in');
		const errPanel = w.__createPanel({ uid: 'NOPE' }, 0, true);
		check(!errPanel.querySelector('a.error-signin'), 'member: not-found panel has no sign-in link');
	}

	// --- Whole-site gate (older edge fn without signedIn): no sign-in link --------
	{
		const log: string[] = [];
		const w = await boot({ ...PUBLIC_SITE }, log, 'team');
		await w.__loadNoteByParameter('u', 'PUB');
		check(!w.document.querySelector('.site-signin'), 'legacy whoami with groups counts as signed in');
	}

	if (failures.length === 0) {
		console.log('All access-client cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} access-client assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
