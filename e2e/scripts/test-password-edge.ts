#!/usr/bin/env npx tsx
/**
 * Password (Basic Auth) Edge Function Test
 *
 * Loads the shipped PASSWORD_AUTH_TEMPLATE's inline edge-fn body (the exact code
 * that deploys to Lambda@Edge) into a Node vm with a stub CFG, and exercises the
 * viewer-request handler against CloudFront-style events:
 *   - correct password (any username) -> request passes through
 *   - wrong / missing / malformed Authorization -> 401 + WWW-Authenticate
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

// Build a CloudFront viewer-request event with an optional Authorization header.
function event(authHeader?: string) {
	const headers: any = {};
	if (authHeader !== undefined) headers.authorization = [{ key: 'Authorization', value: authHeader }];
	return { Records: [{ cf: { request: { uri: '/', querystring: '', headers } } }] };
}
function basic(user: string, pass: string) {
	return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function loadHandler() {
	const tmpl = JSON.parse(PASSWORD_AUTH_TEMPLATE);
	const join = tmpl.Resources.PasswordEdgeFn.Properties.Code.ZipFile['Fn::Join'][1];
	const body: string = join[1]; // verbatim function body (CFG line is join[0])

	// Provide the CFG the stack would inject via Fn::Sub, plus a CommonJS-style
	// module/exports + require('crypto') so the inline body runs unmodified.
	const sandbox: any = {
		CFG: { hash: HASH, realm: 'Test Realm' },
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

	const is401 = (r: any) => r && r.status === '401' && r.headers && r.headers['www-authenticate'];
	const isPassthrough = (r: any) => r && r.uri === '/' && !r.status; // returned the request object

	// Correct password, arbitrary username -> pass through.
	check(isPassthrough(await handler(event(basic('anyone', PASSWORD)))), 'correct password (any username) passes through');
	check(isPassthrough(await handler(event(basic('', PASSWORD)))), 'correct password with empty username passes through');

	// Wrong / missing / malformed -> 401 with WWW-Authenticate.
	check(is401(await handler(event(basic('u', 'wrong')))), 'wrong password -> 401');
	check(is401(await handler(event())), 'missing Authorization header -> 401');
	check(is401(await handler(event('Bearer xyz'))), 'non-Basic scheme -> 401');
	check(is401(await handler(event('Basic !!!notbase64'))), 'malformed base64 -> 401');
	check(is401(await handler(event(basic('u', '')))), 'empty password -> 401');

	// The realm from CFG is surfaced in the challenge.
	const r = await handler(event());
	const wwwAuth = r.headers['www-authenticate'][0].value;
	check(wwwAuth.includes('Test Realm'), `WWW-Authenticate carries the realm — got: ${wwwAuth}`);

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
