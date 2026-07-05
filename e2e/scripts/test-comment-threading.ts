#!/usr/bin/env npx tsx
/**
 * Comment Threading (Reply) Regression Test
 *
 * Guards the client surface for one-level threaded replies. The backend already
 * stores an optional parentCommentUid (comment-write.js) and the re-export view
 * propagates it (comment-reexport.js); this test asserts the SHIPPED client:
 *   postComment(noteUid, noteHash, body, parentCommentUid?): the parent is added
 *     to the POST body only when supplied — a top-level post omits it entirely.
 *   renderComment(c, ctx, { canReply }): a signed-in reader gets a
 *     .comment-reply-btn on an active comment ONLY when canReply is set; a
 *     ctx-less / null-username / deleted render never does. Reply lives OUTSIDE
 *     the owner-only .comment-actions row (so it is not owner-gated).
 *   renderThreadInto: nests a reply one level under its parent's .comment-replies
 *     and passes canReply for ROOTS ONLY — the nested reply carries no Reply
 *     button, which caps the thread at one level.
 *
 * Pure unit test of the shipped runtime — no real browser, Obsidian, or AWS.
 * Mirrors the harness in test-comment-edit-delete.ts.
 *
 * Run: npx tsx e2e/scripts/test-comment-threading.ts
 */

import { JSDOM } from 'jsdom';
import * as assetsModule from '../../src/publish/siteAssets';

const assets: any =
	(assetsModule as any).SITE_APP_JS !== undefined
		? assetsModule
		: (assetsModule as any).default;
const SITE_APP_JS: string = assets.SITE_APP_JS;

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
	win.__CPN_CONFIG__ = { commentsEnabled: true, commentReadPath: '/comments/', commentWritePath: '/api/comments' };

	const fetchLog: Array<{ url: string; opts: any }> = [];
	win.fetch = async (url: string, opts: any) => {
		fetchLog.push({ url, opts });
		if (typeof win.__nextFetch__ === 'function') return win.__nextFetch__(url, opts);
		return fakeResponse(200, {});
	};

	// renderComment/renderThreadInto use document.createElement; alias document.
	win.document = dom.window.document;

	try {
		win.eval(SITE_APP_JS);
	} catch {
		/* listener wiring against a bare DOM may throw; declarations are hoisted */
	}

	const renderComment: (c: any, ctx?: any, opts?: any) => any = win.renderComment;
	const renderThreadInto: (container: any, comments: any[], ctx?: any) => void = win.renderThreadInto;
	const postComment: (...a: any[]) => Promise<any> = win.postComment;

	if (typeof renderComment !== 'function' || typeof renderThreadInto !== 'function'
		|| typeof postComment !== 'function') {
		failures.push('expected renderComment/renderThreadInto/postComment on the window');
		return report();
	}

	const signedInCtx = { currentUsername: 'alice', noteUid: 'u1', noteHash: 'h1', refresh() {} };

	// --- postComment payload: parentCommentUid only when supplied ---
	{
		fetchLog.length = 0;
		win.__nextFetch__ = () => fakeResponse(201, { commentUid: 'r1', createdAt: 10 });
		await postComment('u1', 'h1', 'a reply', 'root1');
		const call = fetchLog[fetchLog.length - 1];
		check(call.url === '/api/comments', `reply POST must hit /api/comments — got: ${call.url}`);
		check(call.opts.method === 'POST', `reply POST must use POST — got: ${call.opts.method}`);
		const body = JSON.parse(call.opts.body);
		check(body.noteUid === 'u1' && body.noteHash === 'h1' && body.body === 'a reply',
			`reply body must carry note ids + body — got: ${call.opts.body}`);
		check(body.parentCommentUid === 'root1',
			`reply body must carry parentCommentUid — got: ${call.opts.body}`);
	}
	{
		fetchLog.length = 0;
		win.__nextFetch__ = () => fakeResponse(201, { commentUid: 'c1', createdAt: 10 });
		await postComment('u1', 'h1', 'top level');
		const call = fetchLog[fetchLog.length - 1];
		const body = JSON.parse(call.opts.body);
		check(!('parentCommentUid' in body),
			`a top-level post must OMIT parentCommentUid — got: ${call.opts.body}`);
	}

	// --- Reply affordance gating via renderComment ---
	{
		// Signed-in reader + canReply on an active comment -> Reply button present,
		// and it lives OUTSIDE the owner .comment-actions row (not owner-gated).
		const el = renderComment(
			{ commentUid: 'c1', body: 'hi', createdAt: 10, updatedAt: 10, authorName: 'bob', status: 'active' },
			signedInCtx,
			{ canReply: true },
		);
		check(!!el.querySelector('.comment-reply-btn'),
			'canReply + signed-in must show a Reply button');
		check(!el.querySelector('.comment-actions'),
			"another user's comment must still NOT show the owner actions row (Reply is separate)");
	}
	{
		// No canReply -> no Reply button (this is how replies themselves render).
		const el = renderComment(
			{ commentUid: 'c2', body: 'hi', createdAt: 10, updatedAt: 10, authorName: 'bob', status: 'active' },
			signedInCtx,
		);
		check(!el.querySelector('.comment-reply-btn'),
			'a render without canReply must NOT show a Reply button');
	}
	{
		// canReply but signed out / no username -> no Reply button.
		const el = renderComment(
			{ commentUid: 'c3', body: 'hi', createdAt: 10, updatedAt: 10, authorName: 'bob', status: 'active' },
			{ currentUsername: null, noteUid: 'u1', noteHash: 'h1', refresh() {} },
			{ canReply: true },
		);
		check(!el.querySelector('.comment-reply-btn'),
			'a signed-out reader must NOT get a Reply button even with canReply');
		// ctx-less render (e.g. tests) must also be reply-less.
		const el2 = renderComment(
			{ commentUid: 'c3b', body: 'hi', createdAt: 10, updatedAt: 10, authorName: 'bob', status: 'active' },
			undefined,
			{ canReply: true },
		);
		check(!el2.querySelector('.comment-reply-btn'), 'a ctx-less render must not show a Reply button');
	}
	{
		// A deleted comment never grows a Reply button.
		const el = renderComment(
			{ commentUid: 'c4', body: null, createdAt: 10, updatedAt: 20, authorName: 'bob', status: 'deleted' },
			signedInCtx,
			{ canReply: true },
		);
		check(!el.querySelector('.comment-reply-btn'), 'a deleted comment must not show a Reply button');
	}

	// --- Reply form posts with the parent pointer ---
	{
		const el = renderComment(
			{ commentUid: 'root9', body: 'parent', createdAt: 10, updatedAt: 10, authorName: 'bob', status: 'active' },
			signedInCtx,
			{ canReply: true },
		);
		(el.querySelector('.comment-reply-btn') as any).click();
		const textarea = el.querySelector('.comment-reply-form textarea') as any;
		const submit = Array.from(el.querySelectorAll('.comment-reply-form .comment-submit'))[0] as any;
		check(!!textarea && !!submit, 'clicking Reply must reveal a reply form with a textarea + submit');
		textarea.value = 'my reply';
		fetchLog.length = 0;
		win.__nextFetch__ = () => fakeResponse(201, { commentUid: 'r9', createdAt: 20 });
		submit.click();
		await new Promise((r) => setTimeout(r, 0)); // let the async click handler resolve
		const call = fetchLog[fetchLog.length - 1];
		check(!!call, 'submitting the reply form must issue a POST');
		if (call) {
			const body = JSON.parse(call.opts.body);
			check(body.parentCommentUid === 'root9' && body.body === 'my reply',
				`reply form must POST parentCommentUid=root9 with the body — got: ${call.opts.body}`);
		}
	}

	// --- One-level render: reply nests under its parent, carries no Reply btn ---
	{
		const container = dom.window.document.createElement('div');
		container.innerHTML = '<div class="comment-list"></div>';
		renderThreadInto(
			container,
			[
				{ commentUid: 'root1', body: 'root', createdAt: 10, updatedAt: 10, authorName: 'bob', status: 'active' },
				{ commentUid: 'rep1', parentCommentUid: 'root1', body: 'reply', createdAt: 20, updatedAt: 20, authorName: 'carol', status: 'active' },
			],
			signedInCtx,
		);
		const list = container.querySelector('.comment-list') as any;
		const roots = list.querySelectorAll(':scope > .comment-item');
		check(roots.length === 1, `exactly one root comment must render — got: ${roots.length}`);
		const repliesEl = list.querySelector('.comment-replies') as any;
		check(!!repliesEl, 'the reply must nest inside a .comment-replies block');
		const nested = repliesEl ? repliesEl.querySelectorAll('.comment-item') : [];
		check(nested.length === 1, `exactly one nested reply must render — got: ${nested.length}`);
		// The root gets a Reply button; the nested reply does NOT (one-level cap).
		check(!!roots[0].querySelector('.comment-reply-btn'), 'the root must offer a Reply button');
		check(nested.length > 0 && !nested[0].querySelector('.comment-reply-btn'),
			'a nested reply must NOT offer its own Reply button (one-level cap)');
	}

	report();
}

function report() {
	if (failures.length === 0) {
		console.log('All comment threading cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} comment threading assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main();
