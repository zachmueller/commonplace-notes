#!/usr/bin/env npx tsx
/**
 * OAuth Callback Lambda Test (cookie lifetime)
 *
 * Runs the shipped auth-callback code (the AuthCallbackFn ZipFile inside
 * COGNITO_AUTH_TEMPLATE) in a Node vm with a stubbed `https` token endpoint,
 * and checks the `cpn_id` cookie's Max-Age:
 *   - the ID token's `exp` minus now;
 *   - floored at 0 for an already-expired token;
 *   - 3600 when `exp` is missing, not a number, or the token can't be decoded.
 * Also checks the redirect and the cookie's other attributes are unchanged.
 *
 * Run: npx tsx e2e/scripts/test-auth-callback.ts
 */

import * as vm from 'vm';
import { EventEmitter } from 'events';
import * as templatesModule from '../../src/infrastructure/templates';

const templates: any =
	(templatesModule as any).COGNITO_AUTH_TEMPLATE !== undefined ? templatesModule : (templatesModule as any).default;
const TEMPLATE = JSON.parse(templates.COGNITO_AUTH_TEMPLATE);
const BODY: string = TEMPLATE.Resources.AuthCallbackFn.Properties.Code.ZipFile;

const failures: string[] = [];
let checks = 0;
function check(cond: boolean, msg: string): void {
	checks++;
	if (!cond) failures.push(msg);
}

const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const jwt = (payload: unknown) => `${b64url({ alg: 'RS256', kid: 'k' })}.${b64url(payload)}.sig`;

/** Load the handler with a token endpoint that returns `idToken`. */
function load(idToken: string) {
	const https = {
		request: (_url: unknown, _opts: unknown, cb: (res: any) => void) => {
			const req = new EventEmitter() as any;
			req.write = () => {};
			req.end = () => {
				const res = new EventEmitter() as any;
				res.statusCode = 200;
				cb(res);
				res.emit('data', JSON.stringify({ id_token: idToken, access_token: 'a', expires_in: 3600 }));
				res.emit('end');
			};
			return req;
		},
	};
	const sandbox: any = {
		module: { exports: {} },
		exports: {},
		require: (m: string) => {
			if (m === 'https') return https;
			throw new Error(`unexpected require(${m})`);
		},
		process: { env: { COGNITO_DOMAIN: 'https://auth.example', CLIENT_ID: 'c', CLIENT_SECRET: 's', REDIRECT_URI: 'https://site/auth/callback' } },
		Buffer,
		URL,
		URLSearchParams,
		Date,
		JSON,
		Math,
		console: { log: () => {}, warn: () => {} },
	};
	sandbox.module.exports = sandbox.exports;
	vm.runInNewContext(BODY, sandbox, { filename: 'auth-callback.js' });
	return sandbox.exports.handler as (e: any) => Promise<any>;
}

async function cookieFor(idToken: string): Promise<{ maxAge: number | null; cookie: string; res: any }> {
	const res = await load(idToken)({ queryStringParameters: { code: 'abc', state: encodeURIComponent('/notes/x') }, headers: { host: 'site' } });
	const cookie: string = res.cookies?.[0] ?? '';
	const m = /;\s*Max-Age=(-?\d+)/.exec(cookie);
	return { maxAge: m ? Number(m[1]) : null, cookie, res };
}

async function main(): Promise<void> {
	const now = Math.floor(Date.now() / 1000);

	// Max-Age from exp (12 h and 1 h tokens), within a couple of seconds.
	for (const hours of [12, 1]) {
		const { maxAge, cookie, res } = await cookieFor(jwt({ sub: 'u', exp: now + hours * 3600 }));
		check(maxAge !== null && Math.abs(maxAge - hours * 3600) <= 2, `${hours} h token → Max-Age ≈ ${hours * 3600}, got ${maxAge}`);
		check(res.statusCode === 302 && res.headers?.Location === '/notes/x', `${hours} h token: 302 to the state path`);
		check(cookie.startsWith('cpn_id=') && /HttpOnly; Secure; SameSite=Lax; Path=\//.test(cookie), `${hours} h token: cookie attributes kept (${cookie})`);
	}

	// Floor at 0.
	{
		const { maxAge } = await cookieFor(jwt({ sub: 'u', exp: now - 600 }));
		check(maxAge === 0, `expired token → Max-Age=0, got ${maxAge}`);
	}

	// Fallback to 3600.
	const fallbacks: [string, string][] = [
		['no exp', jwt({ sub: 'u' })],
		['string exp', jwt({ sub: 'u', exp: String(now + 100) })],
		['non-JSON payload', `${b64url({})}.${Buffer.from('not json').toString('base64url')}.sig`],
		['no payload part', 'onlyonepart'],
	];
	for (const [what, token] of fallbacks) {
		const { maxAge } = await cookieFor(token);
		check(maxAge === 3600, `${what} → Max-Age=3600, got ${maxAge}`);
	}

	if (failures.length === 0) {
		console.log(`All ${checks} auth-callback checks passed.`);
		process.exit(0);
	}
	console.log(`${failures.length}/${checks} auth-callback check(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
