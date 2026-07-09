#!/usr/bin/env npx tsx
/**
 * Password Edge Function Test
 *
 * Loads the shipped PASSWORD_AUTH_TEMPLATE's inline edge-fn body (the exact code
 * that deploys to Lambda@Edge) into a Node vm with a stub CFG, and exercises the
 * viewer-request handler against CloudFront-style events:
 *   - valid `cpn_pw` cookie (= sha256 of the password) -> request passes through
 *   - missing / wrong / malformed cookie -> 200 with the branded unlock page
 *   - the baked CFG.hash is the sha256 of the password, never the plaintext
 *
 * Pure unit test of the shipped runtime — no AWS. Mirrors the harness style of
 * test-comment-sanitizer.ts.
 *
 * Run: npx tsx e2e/scripts/test-password-edge.ts
 */

import * as vm from 'vm';
import * as crypto from 'crypto';
import * as templatesModule from '../../src/infrastructure/templates';

const templates: any =
	(templatesModule as any).PASSWORD_AUTH_TEMPLATE !== undefined
		? templatesModule
		: (templatesModule as any).default;
const PASSWORD_AUTH_TEMPLATE: string = templates.PASSWORD_AUTH_TEMPLATE;

const failures: string[] = [];
function check(cond: boolean, msg: string) {
	if (!cond) failures.push(msg);
}

const PASSWORD = 'correct horse battery staple';
const HASH = crypto.createHash('sha256').update(PASSWORD, 'utf8').digest('hex');

// Build a CloudFront viewer-request event. `cookie` sets the Cookie header;
// `uri` overrides the request path (default '/'); `extraHeaders` seeds arbitrary
// lowercase-keyed request headers (e.g. sec-fetch-mode, accept) so tests can
// exercise the navigation-vs-data branch.
function event(cookie?: string, uri = '/', extraHeaders: Record<string, string> = {}) {
	const headers: any = {};
	if (cookie !== undefined) headers.cookie = [{ key: 'Cookie', value: cookie }];
	for (const [k, v] of Object.entries(extraHeaders)) {
		headers[k] = [{ key: k, value: v }];
	}
	return { Records: [{ cf: { request: { uri, querystring: '', headers } } }] };
}

function loadHandler() {
	const tmpl = JSON.parse(PASSWORD_AUTH_TEMPLATE);
	const join = tmpl.Resources.PasswordEdgeFn.Properties.Code.ZipFile['Fn::Join'][1];
	const body: string = join[1]; // verbatim function body (CFG line is join[0])

	// Provide the CFG the stack would inject via Fn::Sub, plus a CommonJS-style
	// module/exports + require('crypto') so the inline body runs unmodified.
	const sandbox: any = {
		CFG: { hash: HASH, realm: 'My Notes' },
		module: { exports: {} },
		exports: {},
		require: (m: string) => {
			if (m === 'crypto') return crypto;
			throw new Error(`unexpected require(${m})`);
		},
		Buffer,
	};
	sandbox.module.exports = sandbox.exports;
	vm.runInNewContext(body, sandbox, { filename: 'password-edge.inlined.js' });
	return sandbox.exports.handler as (e: any) => Promise<any>;
}

async function main() {
	check(HASH !== PASSWORD, 'sanity: hash differs from plaintext');
	check(/^[0-9a-f]{64}$/.test(HASH), 'sanity: hash is 64 hex chars');
	check(!PASSWORD_AUTH_TEMPLATE.includes(PASSWORD), 'template must not contain the plaintext password');

	let handler: (e: any) => Promise<any>;
	try {
		handler = loadHandler();
	} catch (err: any) {
		failures.push('failed to load edge fn handler: ' + err.message);
		return report();
	}

	const authHdr = (r: any) => r?.headers?.['x-cpn-auth']?.[0]?.value;
	const isPage = (r: any) =>
		r && r.status === '200' && /text\/html/.test(r.headers?.['content-type']?.[0]?.value || '') &&
		typeof r.body === 'string' && /<form/.test(r.body) && authHdr(r) === 'password';
	const isAuthJson = (r: any) =>
		r && r.status === '401' && /application\/json/.test(r.headers?.['content-type']?.[0]?.value || '') &&
		typeof r.body === 'string' && !/<form/.test(r.body) && r.body.includes('cpn_auth_required') &&
		authHdr(r) === 'required';
	const isPassthrough = (r: any) => r && r.uri && !r.status; // returned the request object

	// A top-level navigation is signalled by sec-fetch-mode (modern browsers) or,
	// as a fallback for older iOS, an Accept: text/html on a non-.json path.
	const NAV = { 'sec-fetch-mode': 'navigate' };
	// A subresource/data fetch: fetch() with sec-fetch-dest empty (or simply a
	// .json path when Sec-Fetch is absent).
	const DATA = { 'sec-fetch-dest': 'empty' };

	// Valid cookie (hash of the password) -> pass through, regardless of kind.
	check(isPassthrough(await handler(event('cpn_pw=' + HASH, '/', NAV))), 'valid cpn_pw cookie passes through');
	check(
		isPassthrough(await handler(event('foo=1; cpn_pw=' + HASH + '; bar=2', '/', NAV))),
		'valid cpn_pw cookie among others passes through',
	);
	check(
		isPassthrough(await handler(event('cpn_pw=' + HASH, '/notes/abc.json', DATA))),
		'valid cpn_pw cookie on a .json data request passes through',
	);

	// Missing / wrong / malformed cookie on a NAVIGATION -> the unlock page.
	check(isPage(await handler(event(undefined, '/', NAV))), 'missing cookie (navigate) -> unlock page');
	check(
		isPage(await handler(event(undefined, '/some/note', { accept: 'text/html,application/xhtml+xml' }))),
		'missing cookie (Accept: text/html fallback) -> unlock page',
	);
	check(isPage(await handler(event('cpn_pw=' + 'f'.repeat(64), '/', NAV))), 'wrong hash (navigate) -> unlock page');
	check(isPage(await handler(event('cpn_pw=notahash', '/', NAV))), 'malformed cookie (navigate) -> unlock page');
	check(isPage(await handler(event('other=1', '/', NAV))), 'unrelated cookie (navigate) -> unlock page');

	// Missing / invalid cookie on a DATA request -> a 401 JSON, NOT the unlock HTML.
	check(isAuthJson(await handler(event(undefined, '/notes/abc.json', DATA))), 'missing cookie (.json data) -> 401 JSON');
	check(isAuthJson(await handler(event(undefined, '/notes/abc.json'))), 'missing cookie (.json, no Sec-Fetch) -> 401 JSON');
	check(isAuthJson(await handler(event(undefined, '/config.json', DATA))), 'missing cookie (config.json) -> 401 JSON');
	check(
		isAuthJson(await handler(event('cpn_pw=' + 'f'.repeat(64), '/static/mapping/uid-to-hash.json', DATA))),
		'wrong hash on a /static .json data request -> 401 JSON',
	);

	// The unlock page must never leak the plaintext and must surface the realm heading.
	const page = await handler(event(undefined, '/', NAV));
	check(!page.body.includes(PASSWORD), 'unlock page does not contain the plaintext password');
	check(page.body.includes('My Notes'), 'unlock page shows the site name (CFG.realm) as heading');
	check(/no-store/.test(page.headers['cache-control'][0].value), 'unlock page is not cached');
	check(!/www-authenticate/i.test(JSON.stringify(page.headers)), 'no Basic Auth challenge header');

	// The data 401 must also carry no-store and no Basic Auth challenge.
	const denied = await handler(event(undefined, '/notes/abc.json', DATA));
	check(/no-store/.test(denied.headers['cache-control'][0].value), '401 data response is not cached');
	check(!/www-authenticate/i.test(JSON.stringify(denied.headers)), 'no Basic Auth challenge header on 401');

	report();
}

function report() {
	if (failures.length === 0) {
		console.log('All password edge-fn cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} password edge-fn assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
