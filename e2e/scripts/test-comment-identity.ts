#!/usr/bin/env npx tsx
/**
 * Comment Identity / Gating Regression Test
 *
 * Guards the two fixes for the commenting feature's identity gaps:
 *   1. The composer must NOT be typeable until the page confirms the reader has
 *      comment access. Because the cpn_id session cookie is HttpOnly (JS can't
 *      read it), the widget calls /api/me (fetchMe) as its only auth signal.
 *   2. Posted comments must show the author's chosen username. renderComment
 *      renders `@<authorName>` from the server-provided view (escaped).
 *
 * Asserts the shipped runtime's contracts by loading SITE_APP_JS into jsdom:
 *   fetchMe:      401/403 -> { authenticated:false }; 200 -> { authenticated,username }
 *   postUsername: 200 -> { ok:true }; 409 -> { ok:false, error }
 *   renderComment: emits an escaped `@username` author, or `anonymous` when absent
 *   buildComposer: signed-out reader gets a DISABLED textarea (never typeable);
 *     signed-in reader gets an editable contenteditable composer.
 *
 * Also asserts the deploy-side invariant that the comment stack template exposes
 * the /api/me route (or the composer can never learn auth state).
 *
 * Pure unit test of the shipped runtime — no real browser, Obsidian, or AWS.
 * Mirrors the harness in test-comment-loading.ts.
 *
 * Run: npx tsx e2e/scripts/test-comment-identity.ts
 */

import { JSDOM } from 'jsdom';
import * as assetsModule from '../../src/publish/siteAssets';
import * as templatesModule from '../../src/infrastructure/templates';

const assets: any =
	(assetsModule as any).SITE_APP_JS !== undefined
		? assetsModule
		: (assetsModule as any).default;
const SITE_APP_JS: string = assets.SITE_APP_JS;

const templates: any =
	(templatesModule as any).COMMENT_STACK_TEMPLATE !== undefined
		? templatesModule
		: (templatesModule as any).default;
const COMMENT_STACK_TEMPLATE: string = templates.COMMENT_STACK_TEMPLATE;

const failures: string[] = [];
function check(cond: boolean, msg: string) {
	if (!cond) failures.push(msg);
}

function fakeResponse(status: number, body: unknown) {
	return {
		status,
		ok: status >= 200 && status < 300,
		async json() { return body; },
	};
}

async function main() {
	const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
	const win: any = dom.window;
	win.__CPN_CONFIG__ = { commentsEnabled: true, commentReadPath: '/comments/', commentMePath: '/api/me' };

	const fetchLog: Array<{ url: string; opts: any }> = [];
	win.fetch = async (url: string, opts: any) => {
		fetchLog.push({ url, opts });
		if (typeof win.__nextFetch__ === 'function') return win.__nextFetch__(url, opts);
		return fakeResponse(404, null);
	};

	// jsdom doesn't give the window a document global inside eval scope the same
	// way; renderComment uses document.createElement, so alias it.
	win.document = dom.window.document;

	try {
		win.eval(SITE_APP_JS);
	} catch {
		/* listener wiring against a bare DOM may throw; declarations are hoisted */
	}

	const fetchMe: () => Promise<any> = win.fetchMe;
	const postUsername: (u: string) => Promise<any> = win.postUsername;
	const renderComment: (c: any) => any = win.renderComment;
	const buildComposer: (...a: any[]) => void = win.buildComposer;

	if (typeof fetchMe !== 'function' || typeof postUsername !== 'function'
		|| typeof renderComment !== 'function' || typeof buildComposer !== 'function') {
		failures.push('expected fetchMe/postUsername/renderComment/buildComposer on the window');
		return report();
	}

	// --- fetchMe: signed out (401/403) ---
	win.__nextFetch__ = () => fakeResponse(401, null);
	check((await fetchMe()).authenticated === false, '401 from /api/me must be treated as signed out');
	win.__nextFetch__ = () => fakeResponse(403, null);
	check((await fetchMe()).authenticated === false, '403 from /api/me must be treated as signed out');

	// --- fetchMe: signed in, no username ---
	win.__nextFetch__ = () => fakeResponse(200, { authenticated: true, username: null });
	{
		const me = await fetchMe();
		check(me.authenticated === true && me.username === null,
			'200 with null username must yield { authenticated:true, username:null }');
	}

	// --- fetchMe: signed in with a username ---
	win.__nextFetch__ = () => fakeResponse(200, { authenticated: true, username: 'alice' });
	check((await fetchMe()).username === 'alice', '200 with a username must surface it');

	// --- postUsername: success and 409-taken ---
	win.__nextFetch__ = () => fakeResponse(200, { username: 'bob' });
	{
		const r = await postUsername('bob');
		check(r.ok === true && r.username === 'bob', 'a 200 username claim must resolve ok');
	}
	win.__nextFetch__ = () => fakeResponse(409, { error: 'username taken' });
	{
		const r = await postUsername('taken');
		check(r.ok === false && /taken/.test(r.error), 'a 409 claim must resolve { ok:false, error }');
	}
	// It must POST JSON to the configured /api/me path.
	check(fetchLog.some((f) => f.url === '/api/me' && f.opts && f.opts.method === 'POST'),
		'postUsername must POST to /api/me');

	// --- renderComment: shows the escaped author username ---
	{
		const el = renderComment({ commentUid: 'c1', body: 'hi', createdAt: 1, authorName: 'alice', status: 'active' });
		const html = el.innerHTML;
		check(/comment-author/.test(html) && html.includes('@alice'),
			`renderComment must show @username — got: ${html}`);
	}
	// XSS: an author name with markup must be escaped, never injected raw.
	{
		const el = renderComment({ commentUid: 'c2', body: 'hi', createdAt: 1, authorName: '<img src=x>', status: 'active' });
		check(!el.innerHTML.includes('<img src=x>'), 'renderComment must escape the author name');
	}
	// Missing author falls back to a non-empty label.
	{
		const el = renderComment({ commentUid: 'c3', body: 'hi', createdAt: 1, status: 'active' });
		check(/anonymous/.test(el.innerHTML), 'renderComment must label authorless comments');
	}

	// --- buildComposer: signed-out reader gets a DISABLED textarea ---
	{
		const region = win.document.createElement('div');
		region.innerHTML = '<div class="comment-composer"></div>';
		buildComposer({ dataset: { uid: 'u1' } }, { hash: '' }, region, () => {}, { authenticated: false });
		const ta = region.querySelector('textarea');
		check(!!ta && ta.disabled === true, 'a signed-out reader must get a disabled textarea (never typeable)');
		check(!!region.querySelector('.comment-signin') || /not configured/.test(region.textContent || ''),
			'a signed-out composer must offer sign-in');
	}
	// --- buildComposer: signed-in-with-username reader gets an ENABLED box ---
	// The active composer is a contenteditable editor (so note-links can render as
	// chips), not a <textarea>. It must be editable (contenteditable="true").
	{
		const region = win.document.createElement('div');
		region.innerHTML = '<div class="comment-composer"></div>';
		buildComposer({ dataset: { uid: 'u1' } }, { hash: '' }, region, () => {}, { authenticated: true, username: 'alice' });
		const editor = region.querySelector('.comment-composer .comment-input[contenteditable="true"]');
		check(!!editor, 'a signed-in reader with a username must get an editable composer');
	}

	// --- deploy invariant: the comment stack exposes GET/POST /api/me ---
	check(COMMENT_STACK_TEMPLATE.includes('/api/me'),
		'COMMENT_STACK_TEMPLATE must define the /api/me route (the composer relies on it for auth state)');

	report();
}

function report() {
	if (failures.length === 0) {
		console.log('All comment identity cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} comment identity assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main();
