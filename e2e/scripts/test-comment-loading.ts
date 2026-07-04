#!/usr/bin/env npx tsx
/**
 * Comment Loading Regression Test
 *
 * Guards the fix for "the comment widget never renders on the published site".
 * The widget is only revealed when `loadComments()` returns non-null; it stays
 * hidden when loadComments returns null. Under CloudFront + S3 OAC (GetObject
 * only, no ListBucket) a MISSING comment file returns HTTP 403 — not 404 — so a
 * fresh note (no comments yet, i.e. every new site) must still be treated as an
 * empty thread, otherwise the composer never appears.
 *
 * This loads the shipped SITE_APP_JS into a jsdom window, stubs `fetch`, and
 * asserts loadComments' contract:
 *   - 404 -> empty thread   (no comments yet)
 *   - 403 -> empty thread   (OAC "missing object" — the bug this fixes)
 *   - 200 + valid JSON -> parsed thread
 *   - 200 + malformed JSON body -> null (genuine anomaly, widget stays hidden)
 *   - 500 / other non-OK -> null (genuine failure, widget stays hidden)
 *   - network error (fetch rejects) -> null
 *
 * It also asserts the deploy-side invariant that makes posted comments reachable:
 * the re-export lambda's S3 write key and the client's read path share the
 * `comments/` prefix (a mismatch silently 403s every read).
 *
 * Pure unit test of the shipped runtime — no real browser, Obsidian, or AWS.
 * Mirrors the harness in test-comment-sanitizer.ts.
 *
 * Run: npx tsx e2e/scripts/test-comment-loading.ts
 */

import { JSDOM } from 'jsdom';
import * as assetsModule from '../../src/publish/siteAssets';
import * as templatesModule from '../../src/infrastructure/templates';

// Under this repo's tsx/Node ESM setup, named exports from a src .ts module are
// sometimes surfaced under `default` (same workaround as test-comment-sanitizer.ts).
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

// A fake Response good enough for loadComments (status + ok + json()).
function fakeResponse(status: number, body: unknown, opts: { malformed?: boolean } = {}) {
	return {
		status,
		ok: status >= 200 && status < 300,
		async json() {
			if (opts.malformed) throw new Error('Unexpected token in JSON');
			return body;
		},
	};
}

async function main() {
	const dom = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' });
	const win: any = dom.window;

	// Config the client reads via window.__CPN_CONFIG__ (cpnConfig()).
	win.__CPN_CONFIG__ = { commentsEnabled: true, commentReadPath: '/comments/' };

	// Route each fetch by URL so a single eval can service every scenario. Tests
	// set `win.__nextFetch__` to the handler for the URL they exercise.
	const fetchLog: string[] = [];
	win.fetch = async (url: string) => {
		fetchLog.push(url);
		if (typeof win.__nextFetch__ === 'function') return win.__nextFetch__(url);
		return fakeResponse(404, null);
	};

	// Execute the app JS in the jsdom window. Top-level `function` declarations
	// (loadComments, commentsEnabled, cpnConfig, ...) hoist onto the window before
	// the script wires DOM listeners at the bottom (which may throw against a bare
	// DOM — harmless, the hoisted fns are already attached). Mirrors the sanitizer test.
	try {
		win.eval(SITE_APP_JS);
	} catch {
		/* listener wiring against a bare DOM may throw; declarations are hoisted */
	}

	const loadComments: (uid: string) => Promise<any> = win.loadComments;
	if (typeof loadComments !== 'function') {
		failures.push('loadComments was not exposed on the window — cannot run loading tests');
		return report();
	}

	const isEmptyThread = (r: any) => r && Array.isArray(r.comments) && r.comments.length === 0;

	// --- 404: no comments yet -> empty thread ---
	win.__nextFetch__ = () => fakeResponse(404, null);
	check(isEmptyThread(await loadComments('u404')), '404 must yield an empty thread (no comments yet)');

	// --- 403: OAC "missing object" -> empty thread (the bug this fixes) ---
	win.__nextFetch__ = () => fakeResponse(403, null);
	check(isEmptyThread(await loadComments('u403')),
		'403 (OAC missing object) must yield an empty thread so the composer still renders');

	// --- 200 + valid JSON -> parsed thread ---
	const sample = { version: 1, comments: [{ commentUid: 'c1', body: 'hi', createdAt: 1 }] };
	win.__nextFetch__ = () => fakeResponse(200, sample);
	{
		const r = await loadComments('u200');
		check(!!r && Array.isArray(r.comments) && r.comments.length === 1 && r.comments[0].commentUid === 'c1',
			`200 + valid JSON must parse the thread — got: ${JSON.stringify(r)}`);
	}

	// --- 200 + malformed body -> null (a 200 that isn't valid JSON is a genuine
	//     anomaly, distinct from the "missing object" 403/404 case; leaving the
	//     widget hidden is the safe response rather than faking an empty thread) ---
	win.__nextFetch__ = () => fakeResponse(200, null, { malformed: true });
	check((await loadComments('uBad')) === null, '200 + malformed JSON returns null (not treated as empty)');

	// --- 500 / other non-OK -> null (genuine failure keeps the widget hidden) ---
	win.__nextFetch__ = () => fakeResponse(500, null);
	check((await loadComments('u500')) === null, '500 must return null (genuine failure)');

	// --- network error (fetch rejects) -> null ---
	win.__nextFetch__ = () => { throw new Error('network down'); };
	check((await loadComments('uNet')) === null, 'a rejected fetch must return null');

	// --- read path uses the configured commentReadPath (/comments/) prefix ---
	check(fetchLog.some((u) => u.startsWith('/comments/')),
		`loadComments must fetch under /comments/ — saw: ${JSON.stringify(fetchLog.slice(0, 3))}`);

	// --- deploy invariant: re-export write key and client read path share the
	//     `comments/` prefix, or every read silently 403s ---
	check(/Key:\s*'comments\/'\s*\+\s*noteUid\s*\+\s*'\.json'/.test(COMMENT_STACK_TEMPLATE)
		|| COMMENT_STACK_TEMPLATE.includes("comments/' + noteUid + '.json"),
		'COMMENT_STACK_TEMPLATE re-export lambda must write to comments/{uid}.json (matching the /comments/* read path)');

	report();
}

function report() {
	if (failures.length === 0) {
		console.log('All comment loading cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} comment loading assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main();
