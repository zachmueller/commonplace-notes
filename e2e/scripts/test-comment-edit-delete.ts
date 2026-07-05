#!/usr/bin/env npx tsx
/**
 * Comment Edit / Delete Regression Test
 *
 * Guards the client surface for editing and deleting a reader's OWN comments.
 * The server (comment-write.js) is the real authorization boundary — it checks
 * the stored authorId against the caller's Cognito sub — so the client only
 * decides whether to SHOW the Edit/Delete affordances, using a display gate of
 * `comment.authorName === currentUsername` (usernames are unique + immutable,
 * so this is a sound proxy for ownership).
 *
 * Asserts the shipped runtime's contracts by loading SITE_APP_JS into jsdom:
 *   renderComment(c, ctx): owned comments grow a .comment-actions row; comments
 *     by others (or with no ctx / no username) do NOT.
 *   "(edited)" indicator: present when updatedAt > createdAt, absent when equal.
 *   deleted comments never render owner actions.
 *   patchComment / deleteComment: correct method, URL and JSON body, and the
 *     createdAt integer round-trips verbatim (it reconstructs the DynamoDB SK).
 *   the inline edit textarea is prefilled with the RAW Markdown body.
 *
 * Pure unit test of the shipped runtime — no real browser, Obsidian, or AWS.
 * Mirrors the harness in test-comment-identity.ts.
 *
 * Run: npx tsx e2e/scripts/test-comment-edit-delete.ts
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

	// renderComment uses document.createElement; alias document into the eval scope.
	win.document = dom.window.document;

	try {
		win.eval(SITE_APP_JS);
	} catch {
		/* listener wiring against a bare DOM may throw; declarations are hoisted */
	}

	const renderComment: (c: any, ctx?: any) => any = win.renderComment;
	const patchComment: (...a: any[]) => Promise<any> = win.patchComment;
	const deleteComment: (...a: any[]) => Promise<any> = win.deleteComment;

	if (typeof renderComment !== 'function' || typeof patchComment !== 'function'
		|| typeof deleteComment !== 'function') {
		failures.push('expected renderComment/patchComment/deleteComment on the window');
		return report();
	}

	const ownCtx = { currentUsername: 'alice', noteUid: 'u1', refresh() {} };

	// --- Ownership display gate ---
	{
		const el = renderComment(
			{ commentUid: 'c1', body: 'mine', createdAt: 10, updatedAt: 10, authorName: 'alice', status: 'active' },
			ownCtx,
		);
		check(!!el.querySelector('.comment-actions'), 'own comment must show the actions row');
		const labels = Array.from(el.querySelectorAll('.comment-action')).map((b: any) => b.textContent);
		check(labels.includes('Edit') && labels.includes('Delete'),
			`own comment must offer Edit and Delete — got: ${labels.join(',')}`);
	}
	// A comment by someone else must NOT get owner actions.
	{
		const el = renderComment(
			{ commentUid: 'c2', body: 'theirs', createdAt: 10, updatedAt: 10, authorName: 'bob', status: 'active' },
			ownCtx,
		);
		check(!el.querySelector('.comment-actions'), "another user's comment must not show actions");
	}
	// No ctx / no username -> no actions (backward-compatible, read-only render).
	{
		const el = renderComment({ commentUid: 'c3', body: 'x', createdAt: 10, updatedAt: 10, authorName: 'alice', status: 'active' });
		check(!el.querySelector('.comment-actions'), 'ctx-less render must not show actions');
		const el2 = renderComment(
			{ commentUid: 'c3b', body: 'x', createdAt: 10, updatedAt: 10, authorName: 'alice', status: 'active' },
			{ currentUsername: null, noteUid: 'u1', refresh() {} },
		);
		check(!el2.querySelector('.comment-actions'), 'null username must not show actions');
	}

	// --- "(edited)" indicator ---
	{
		const edited = renderComment(
			{ commentUid: 'c4', body: 'x', createdAt: 10, updatedAt: 20, authorName: 'alice', status: 'active' },
			ownCtx,
		);
		check(!!edited.querySelector('.comment-edited'), 'updatedAt > createdAt must show (edited)');
		const fresh = renderComment(
			{ commentUid: 'c5', body: 'x', createdAt: 10, updatedAt: 10, authorName: 'alice', status: 'active' },
			ownCtx,
		);
		check(!fresh.querySelector('.comment-edited'), 'updatedAt == createdAt must NOT show (edited)');
	}

	// --- Deleted comments never render owner actions ---
	{
		const el = renderComment(
			{ commentUid: 'c6', body: null, createdAt: 10, updatedAt: 20, authorName: 'alice', status: 'deleted' },
			ownCtx,
		);
		check(!el.querySelector('.comment-actions'), 'a deleted comment must not show owner actions');
	}

	// --- Inline edit form is prefilled with the RAW markdown body ---
	{
		const raw = '_italic_ and **bold**';
		const el = renderComment(
			{ commentUid: 'c7', body: raw, createdAt: 10, updatedAt: 10, authorName: 'alice', status: 'active' },
			ownCtx,
		);
		const editBtn = Array.from(el.querySelectorAll('.comment-action'))
			.find((b: any) => b.textContent === 'Edit') as any;
		editBtn.click();
		const ta = el.querySelector('.comment-edit-form textarea') as any;
		check(!!ta && ta.value === raw, `edit textarea must prefill the raw markdown — got: ${ta && ta.value}`);
	}

	// --- patchComment request shape + createdAt round-trip ---
	{
		fetchLog.length = 0;
		win.__nextFetch__ = () => fakeResponse(200, { commentUid: 'c1', status: 'active' });
		await patchComment('c1', 'u1', 1720000000, 'new body');
		const call = fetchLog[fetchLog.length - 1];
		check(call.url === '/api/comments', `patchComment must hit /api/comments — got: ${call.url}`);
		check(call.opts.method === 'PATCH', `patchComment must use PATCH — got: ${call.opts.method}`);
		const body = JSON.parse(call.opts.body);
		check(body.commentUid === 'c1' && body.noteUid === 'u1' && body.body === 'new body',
			`patchComment body must carry the ids + body — got: ${call.opts.body}`);
		check(body.createdAt === 1720000000, 'patchComment createdAt must round-trip as an integer');
		check(/"createdAt":1720000000\b/.test(call.opts.body),
			`createdAt must serialize as the bare integer (SK reconstruction) — got: ${call.opts.body}`);
	}

	// --- deleteComment request shape ---
	{
		fetchLog.length = 0;
		win.__nextFetch__ = () => fakeResponse(200, { commentUid: 'c1', status: 'deleted' });
		await deleteComment('c1', 'u1', 1720000000);
		const call = fetchLog[fetchLog.length - 1];
		check(call.url === '/api/comments', `deleteComment must hit /api/comments — got: ${call.url}`);
		check(call.opts.method === 'DELETE', `deleteComment must use DELETE — got: ${call.opts.method}`);
		const body = JSON.parse(call.opts.body);
		check(body.commentUid === 'c1' && body.noteUid === 'u1' && body.createdAt === 1720000000,
			`deleteComment body must carry the ids + integer createdAt — got: ${call.opts.body}`);
	}

	// --- auth failures surface as Error('auth') ---
	{
		win.__nextFetch__ = () => fakeResponse(403, null);
		let threw = '';
		try { await patchComment('c1', 'u1', 1720000000, 'x'); } catch (e: any) { threw = e.message; }
		check(threw === 'auth', `a 403 patch must throw Error('auth') — got: ${threw}`);
		threw = '';
		try { await deleteComment('c1', 'u1', 1720000000); } catch (e: any) { threw = e.message; }
		check(threw === 'auth', `a 403 delete must throw Error('auth') — got: ${threw}`);
	}

	report();
}

function report() {
	if (failures.length === 0) {
		console.log('All comment edit/delete cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} comment edit/delete assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main();
