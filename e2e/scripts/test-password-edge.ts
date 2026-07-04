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

// Build a CloudFront viewer-request event with an optional Cookie header.
function event(cookie?: string) {
	const headers: any = {};
	if (cookie !== undefined) headers.cookie = [{ key: 'Cookie', value: cookie }];
	return { Records: [{ cf: { request: { uri: '/', querystring: '', headers } } }] };
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

	const isPage = (r: any) =>
		r && r.status === '200' && /text\/html/.test(r.headers?.['content-type']?.[0]?.value || '') &&
		typeof r.body === 'string' && /<form/.test(r.body);
	const isPassthrough = (r: any) => r && r.uri === '/' && !r.status; // returned the request object

	// Valid cookie (hash of the password) -> pass through.
	check(isPassthrough(await handler(event('cpn_pw=' + HASH))), 'valid cpn_pw cookie passes through');
	check(
		isPassthrough(await handler(event('foo=1; cpn_pw=' + HASH + '; bar=2'))),
		'valid cpn_pw cookie among others passes through',
	);

	// Missing / wrong / malformed cookie -> the unlock page.
	check(isPage(await handler(event())), 'missing cookie -> unlock page');
	check(isPage(await handler(event('cpn_pw=' + 'f'.repeat(64)))), 'wrong hash -> unlock page');
	check(isPage(await handler(event('cpn_pw=notahash'))), 'malformed cookie value -> unlock page');
	check(isPage(await handler(event('other=1'))), 'unrelated cookie -> unlock page');

	// The unlock page must never leak the plaintext and must surface the realm heading.
	const page = await handler(event());
	check(!page.body.includes(PASSWORD), 'unlock page does not contain the plaintext password');
	check(page.body.includes('My Notes'), 'unlock page shows the site name (CFG.realm) as heading');
	check(/no-store/.test(page.headers['cache-control'][0].value), 'unlock page is not cached');
	check(!/www-authenticate/i.test(JSON.stringify(page.headers)), 'no Basic Auth challenge header');

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
