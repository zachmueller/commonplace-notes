#!/usr/bin/env npx tsx
/**
 * Pre-token-generation Trigger Test (per-note access groups)
 *
 * Runs the shipped PRE_TOKEN_GROUPS_BODY in a Node vm with a mocked
 * `@aws-sdk/client-s3`, and checks the V1 trigger response:
 *   - verified email matching a group (case-insensitive) -> groupsToOverride
 *   - unverified email / no email / no membership file / S3 error -> []
 *   - the membership file is cached (one GetObject for back-to-back sign-ins)
 *   - missing GROUPS_BUCKET/GROUPS_KEY disables the lookup
 *
 * Run: npx tsx e2e/scripts/test-pre-token-groups.ts
 */

import * as vm from 'vm';
import * as templatesModule from '../../src/infrastructure/templates';

const templates: any =
	(templatesModule as any).PRE_TOKEN_GROUPS_BODY !== undefined
		? templatesModule
		: (templatesModule as any).default;
const BODY: string = templates.PRE_TOKEN_GROUPS_BODY;

const failures: string[] = [];
function check(cond: boolean, msg: string) {
	if (!cond) failures.push(msg);
}

type S3Behavior = { body?: string; error?: string };

function load(behavior: S3Behavior, env: Record<string, string> = { GROUPS_BUCKET: 'b', GROUPS_KEY: 'access/s/groups.json' }) {
	const calls: any[] = [];
	class GetObjectCommand { input: any; constructor(input: any) { this.input = input; } }
	class S3Client {
		async send(cmd: any) {
			calls.push(cmd.input);
			if (behavior.error) { const e: any = new Error(behavior.error); e.name = behavior.error; throw e; }
			return { Body: { transformToString: async () => behavior.body ?? '' } };
		}
	}
	const sandbox: any = {
		module: { exports: {} },
		exports: {},
		require: (m: string) => {
			if (m === '@aws-sdk/client-s3') return { S3Client, GetObjectCommand };
			throw new Error(`unexpected require(${m})`);
		},
		process: { env },
		console: { warn: () => {}, log: () => {} },
		Date,
	};
	sandbox.module.exports = sandbox.exports;
	vm.runInNewContext(BODY, sandbox, { filename: 'pre-token-groups.js' });
	return { handler: sandbox.exports.handler as (e: any) => Promise<any>, calls };
}

function ev(email?: string, verified: string | boolean = 'true') {
	const userAttributes: any = {};
	if (email !== undefined) userAttributes.email = email;
	if (verified !== undefined) userAttributes.email_verified = verified;
	return { version: '1', triggerSource: 'TokenGeneration_HostedAuth', request: { userAttributes }, response: {} };
}

const groupsOf = (r: any) => r?.response?.claimsOverrideDetails?.groupOverrideDetails?.groupsToOverride;
const MEMBERSHIP = JSON.stringify({ version: 1, groups: { team: ['Alice@Example.com'], family: ['alice@example.com', 'carol@example.com'] } });

async function main() {
	{
		const { handler, calls } = load({ body: MEMBERSHIP });
		const a = await handler(ev('alice@example.com'));
		check(JSON.stringify(groupsOf(a)) === '["family","team"]', `alice -> family,team (got ${JSON.stringify(groupsOf(a))})`);
		const upper = await handler(ev('ALICE@EXAMPLE.COM '));
		check(JSON.stringify(groupsOf(upper)) === '["family","team"]', 'email match is case-insensitive and trimmed');
		const carol = await handler(ev('carol@example.com', true));
		check(JSON.stringify(groupsOf(carol)) === '["family"]', 'boolean email_verified accepted');
		const bob = await handler(ev('bob@example.com'));
		check(Array.isArray(groupsOf(bob)) && groupsOf(bob).length === 0, 'non-member -> []');
		const unverified = await handler(ev('alice@example.com', 'false'));
		check(groupsOf(unverified).length === 0, 'unverified email -> []');
		const noEmail = await handler(ev(undefined));
		check(groupsOf(noEmail).length === 0, 'no email -> []');
		check(calls.length === 1, `membership cached across invocations (GetObject calls: ${calls.length})`);
		check(calls[0].Bucket === 'b' && calls[0].Key === 'access/s/groups.json', 'reads GROUPS_BUCKET/GROUPS_KEY');
	}
	{
		const { handler } = load({ error: 'NoSuchKey' });
		const r = await handler(ev('alice@example.com'));
		check(groupsOf(r).length === 0, 'missing membership file -> [] (sign-in still succeeds)');
	}
	{
		const { handler } = load({ body: 'not json' });
		const r = await handler(ev('alice@example.com'));
		check(groupsOf(r).length === 0, 'corrupt membership file -> []');
	}
	{
		const { handler, calls } = load({ body: MEMBERSHIP }, {});
		const r = await handler(ev('alice@example.com'));
		check(groupsOf(r).length === 0 && calls.length === 0, 'no bucket/key configured -> no lookup, []');
	}

	if (failures.length === 0) {
		console.log('All pre-token-groups trigger cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} pre-token-groups assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
