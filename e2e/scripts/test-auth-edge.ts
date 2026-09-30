#!/usr/bin/env npx tsx
/**
 * Cognito Edge Function Test (per-note access groups)
 *
 * Loads the shipped AUTH_EDGE_BODY (lib-jwt-verify.js + auth-edge.js, exactly
 * what the plugin bakes a CFG line onto, zips, and deploys as Lambda@Edge) into
 * a Node vm and drives its viewer-request handler. Token verification is
 * stubbed (verifyIdToken is replaced in the sandbox) so the test is offline;
 * real-token verification was exercised against a live pool when the feature
 * was built.
 *
 * Covers:
 *   - /auth/* passes through unauthenticated
 *   - no/invalid token: navigation -> 302 to the Hosted UI; data fetch -> 401
 *     with x-cpn-auth: required
 *   - /restricted/whoami returns the token's groups (+ email)
 *   - /restricted/<g>/... allowed only when <g> is in cognito:groups; else 403
 *     with x-cpn-auth: forbidden; malformed group segments are 403
 *   - public paths pass for any valid token
 *
 * Run: npx tsx e2e/scripts/test-auth-edge.ts
 */

import * as vm from 'vm';
import * as crypto from 'crypto';
import * as https from 'https';
import * as templatesModule from '../../src/infrastructure/templates';

const templates: any =
	(templatesModule as any).AUTH_EDGE_BODY !== undefined
		? templatesModule
		: (templatesModule as any).default;
const AUTH_EDGE_BODY: string = templates.AUTH_EDGE_BODY;

const failures: string[] = [];
function check(cond: boolean, msg: string) {
	if (!cond) failures.push(msg);
}

const CFG = {
	domain: 'https://example.auth.us-east-1.amazoncognito.com',
	clientId: 'client123',
	region: 'us-east-1',
	userPoolId: 'us-east-1_pool',
};

// token string -> claims the stubbed verifier returns
const TOKENS: Record<string, any> = {
	alice: { sub: 'a', email: 'alice@example.com', 'cognito:groups': ['family', 'team'] },
	bob: { sub: 'b', email: 'bob@example.com' },
	solo: { sub: 's', email: 's@example.com', 'cognito:groups': 'team' },
};

function loadHandler() {
	const source = `const CFG = ${JSON.stringify(CFG)};\n` + AUTH_EDGE_BODY;
	const sandbox: any = {
		module: { exports: {} },
		exports: {},
		require: (m: string) => {
			if (m === 'crypto') return crypto;
			if (m === 'https') return https;
			throw new Error(`unexpected require(${m})`);
		},
		Buffer,
	};
	sandbox.module.exports = sandbox.exports;
	vm.runInNewContext(source, sandbox, { filename: 'auth-edge.baked.js' });
	// Function declarations in the script land on the sandbox global, and the
	// handler resolves verifyIdToken at call time, so this swaps in the stub.
	sandbox.verifyIdToken = async (token: string) => TOKENS[token] || null;
	return sandbox.exports.handler as (e: any) => Promise<any>;
}

function event(uri: string, token?: string, nav = false) {
	const headers: any = { host: [{ key: 'Host', value: 'notes.example.com' }] };
	if (token) headers.cookie = [{ key: 'Cookie', value: `other=1; cpn_id=${token}` }];
	headers['sec-fetch-mode'] = [{ key: 'Sec-Fetch-Mode', value: nav ? 'navigate' : 'cors' }];
	return { Records: [{ cf: { request: { uri, querystring: '', headers } } }] };
}

const hdr = (r: any, name: string) => r?.headers?.[name]?.[0]?.value;
const passed = (r: any) => r && r.uri !== undefined && r.status === undefined;

async function main() {
	check(typeof AUTH_EDGE_BODY === 'string' && AUTH_EDGE_BODY.length > 0, 'AUTH_EDGE_BODY is exported');
	check(AUTH_EDGE_BODY.includes('function verifyIdToken'), 'bundle includes the shared JWT verifier');
	const handler = loadHandler();

	// /auth/* bypass
	check(passed(await handler(event('/auth/callback'))), '/auth/callback passes unauthenticated');

	// Unauthenticated
	const nav = await handler(event('/', undefined, true));
	check(nav.status === '302', `anon navigation -> 302 (got ${nav.status})`);
	check(String(hdr(nav, 'location')).startsWith(CFG.domain + '/oauth2/authorize'), 'anon navigation redirects to Hosted UI');
	check(String(hdr(nav, 'location')).includes('state=' + encodeURIComponent('/')), 'redirect carries original uri in state');
	const data = await handler(event('/notes/abc.json'));
	check(data.status === '401' && hdr(data, 'x-cpn-auth') === 'required', `anon data fetch -> 401 required (got ${data.status} ${hdr(data, 'x-cpn-auth')})`);
	const badTok = await handler(event('/static/mapping/uid-to-hash.json', 'forged'));
	check(badTok.status === '401', 'invalid token on data path -> 401');
	const anonWhoami = await handler(event('/restricted/whoami'));
	check(anonWhoami.status === '401', 'anon whoami -> 401');

	// Public paths with any valid token
	check(passed(await handler(event('/notes/abc.json', 'bob'))), 'bob reads public note');
	check(passed(await handler(event('/', 'bob', true))), 'bob navigates to /');

	// whoami
	const who = await handler(event('/restricted/whoami', 'alice'));
	check(who.status === '200', 'alice whoami -> 200');
	const whoBody = JSON.parse(who.body || '{}');
	check(JSON.stringify(whoBody.groups) === JSON.stringify(['family', 'team']), `alice whoami groups (got ${who.body})`);
	check(whoBody.email === 'alice@example.com', 'whoami carries email');
	check(hdr(who, 'cache-control') === 'no-store', 'whoami is no-store');
	const whoBob = JSON.parse((await handler(event('/restricted/whoami', 'bob'))).body || '{}');
	check(Array.isArray(whoBob.groups) && whoBob.groups.length === 0, 'bob whoami -> []');
	const whoSolo = JSON.parse((await handler(event('/restricted/whoami', 'solo'))).body || '{}');
	check(JSON.stringify(whoSolo.groups) === '["team"]', 'string cognito:groups normalized to a list');

	// Restricted partitions
	check(passed(await handler(event('/restricted/team/notes/h.json', 'alice'))), 'alice reads team note');
	check(passed(await handler(event('/restricted/family/static/mapping/uid-to-hash.json', 'alice'))), 'alice reads family mapping');
	const aliceOps = await handler(event('/restricted/ops/notes/h.json', 'alice'));
	check(aliceOps.status === '403' && hdr(aliceOps, 'x-cpn-auth') === 'forbidden', 'alice denied ops (403 forbidden)');
	const bobTeam = await handler(event('/restricted/team/notes/h.json', 'bob'));
	check(bobTeam.status === '403' && hdr(bobTeam, 'x-cpn-auth') === 'forbidden', 'bob denied team');
	check(passed(await handler(event('/restricted/team/notes/h.json', 'solo'))), 'solo (string group) reads team');
	for (const bad of ['/restricted/Team/notes/h.json', '/restricted//notes/h.json', '/restricted/../notes/h.json', '/restricted/' + 'a'.repeat(41) + '/x']) {
		const r = await handler(event(bad, 'alice'));
		check(r.status === '403', `malformed group segment denied: ${bad} (got ${r.status})`);
	}
	const anonRestrictedNav = await handler(event('/restricted/team/notes/h.json', undefined, true));
	check(anonRestrictedNav.status === '302', 'anon top-level navigation to a restricted URL -> login redirect');
	// Without Fetch Metadata headers (older clients), restricted paths count as data.
	const legacy = event('/restricted/team/x', undefined, false);
	delete (legacy.Records[0].cf.request.headers as any)['sec-fetch-mode'];
	(legacy.Records[0].cf.request.headers as any).accept = [{ key: 'Accept', value: 'text/html' }];
	const anonLegacy = await handler(legacy);
	check(anonLegacy.status === '401', `restricted path without fetch metadata -> 401 (got ${anonLegacy.status})`);

	if (failures.length === 0) {
		console.log('All auth edge-fn cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} auth edge-fn assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
