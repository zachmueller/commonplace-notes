#!/usr/bin/env npx tsx
/**
 * Per-note Access Groups — LIVE AWS end-to-end test (opt-in, creates real resources)
 *
 * Drives the real plugin code inside a live Obsidian (via the plugin instance,
 * not the settings UI) against a real AWS account, and verifies the whole path:
 *
 *   1. Start from a LEGACY Cognito deployment: the pool stack from the last
 *      commit before the edge-stack split (inline edge fn), plus a full site
 *      stack whose CloudFront distribution runs that legacy edge fn.
 *   2. Run CloudFormationManager.upgradeCognitoGate(): the legacy edge fn is
 *      retained and dropped from the pool stack, the pre-token trigger is added,
 *      the separate edge stack is deployed, and the site is re-pointed.
 *   3. Publish a small vault: a public note, notes gated to `team` and `family`,
 *      and a note naming an undefined group. Check the S3 layout: gated copies
 *      only under restricted/<group>/, public aggregates without gated uids, no
 *      title/uid leaks in public HTML or backlinks, membership file uploaded.
 *   4. Through CloudFront with REAL Cognito id tokens (native test users on the
 *      stack's own app client): whoami, member allowed, non-member 403, anon
 *      data 401.
 *   5. Access transitions: gated -> public -> gated again, checking old copies
 *      are deleted from partitions the note left.
 *
 * Google federation itself is NOT exercised (needs a browser sign-in); the
 * trigger/edge path is identical for any verified-email token.
 *
 * Usage (sandbox account strongly recommended):
 *   CPN_LIVE_AWS_PROFILE=random npx tsx e2e/scripts/access-groups-live-e2e.ts
 *   CPN_LIVE_AWS_PROFILE=random npx tsx e2e/scripts/access-groups-live-e2e.ts --teardown
 *
 * Resource names are written to e2e/results/access-groups-live-state.json so a
 * failed run can still be torn down. Lambda@Edge replicas take CloudFront up to
 * a few hours to release: teardown reports any edge function it could not delete
 * yet; re-run --teardown later to finish.
 *
 * The test vault's plugin data.json is snapshotted and restored.
 */

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runTest, type TestContext } from '../lib/test-harness';

const AWS_PROFILE = process.env.CPN_LIVE_AWS_PROFILE;
const REGION = 'us-east-1';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STATE_PATH = path.join(PROJECT_ROOT, 'e2e/results/access-groups-live-state.json');
const DATA_JSON = path.join(PROJECT_ROOT, 'e2e/test-vault/.obsidian/plugins/commonplace-notes/data.json');
/** Last commit whose Cognito pool stack still carried the inline edge fn. */
const LEGACY_COMMIT = '0ca8be6';
const PASSWORD = 'Live-E2e-Passw0rd!';
const NOTE_FILES = ['Access Home.md', 'Public Note.md', 'Team Secret.md', 'Family Secret.md', 'Bad Group.md'];

interface LiveState {
	variant: string;
	accountId?: string;
	poolStack?: string;
	edgeStack?: string;
	fullStack?: string;
	siteBucket?: string;
	distributionId?: string;
	legacyEdgeFunction?: string;
	domainPrefix?: string;
	/** True when cpn-bootstrap already existed before this run (then teardown keeps it). */
	bootstrapPreexisting?: boolean;
}

// ---------------------------------------------------------------------------
// AWS CLI helpers (Node side)
// ---------------------------------------------------------------------------

function aws(args: string[], opts: { json?: boolean; allowFail?: boolean } = {}): any {
	try {
		const out = execFileSync('aws', [...args, ...(opts.json === false ? [] : ['--output', 'json'])], {
			env: { ...process.env, AWS_PROFILE, AWS_REGION: REGION, AWS_PAGER: '' },
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
		});
		if (opts.json === false) return out;
		return out.trim() ? JSON.parse(out) : {};
	} catch (err: any) {
		if (opts.allowFail) return null;
		throw new Error(`aws ${args.slice(0, 3).join(' ')} failed: ${err.stderr || err.message}`);
	}
}

function stackOutputs(stackName: string): Record<string, string> {
	const d = aws(['cloudformation', 'describe-stacks', '--stack-name', stackName]);
	const out: Record<string, string> = {};
	for (const o of d.Stacks[0].Outputs || []) out[o.OutputKey] = o.OutputValue;
	return out;
}

function s3Keys(bucket: string, prefix: string): string[] {
	const d = aws(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix], { allowFail: true });
	return (d?.Contents || []).map((o: any) => o.Key);
}

function s3Json(bucket: string, key: string): any {
	const tmp = path.join(os.tmpdir(), `cpn-live-${crypto.randomBytes(4).toString('hex')}.json`);
	aws(['s3api', 'get-object', '--bucket', bucket, '--key', key, tmp]);
	const v = JSON.parse(fs.readFileSync(tmp, 'utf8'));
	fs.unlinkSync(tmp);
	return v;
}

function saveState(s: LiveState) {
	fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
	fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function legacyCognitoTemplate(): string {
	const src = execFileSync('git', ['show', `${LEGACY_COMMIT}:src/infrastructure/templates.ts`], { cwd: PROJECT_ROOT, encoding: 'utf8' });
	const m = src.match(/export const COGNITO_AUTH_TEMPLATE = (".*");/);
	if (!m) throw new Error('Could not extract the legacy COGNITO_AUTH_TEMPLATE');
	return JSON.parse(m[1]);
}

/** Real id token for a native user via the stack's own (secret-bearing) app client. */
function idToken(poolId: string, clientId: string, clientSecret: string, email: string): string {
	const secretHash = crypto.createHmac('sha256', clientSecret).update(email + clientId).digest('base64');
	const d = aws(['cognito-idp', 'admin-initiate-auth', '--user-pool-id', poolId, '--client-id', clientId,
		'--auth-flow', 'ADMIN_USER_PASSWORD_AUTH', '--auth-parameters',
		`USERNAME=${email},PASSWORD=${PASSWORD},SECRET_HASH=${secretHash}`]);
	return d.AuthenticationResult.IdToken;
}

async function get(url: string, token?: string): Promise<{ status: number; auth: string | null; body: string }> {
	const r = await fetch(url, {
		headers: {
			...(token ? { cookie: `cpn_id=${token}` } : {}),
			'sec-fetch-mode': 'cors',
			'cache-control': 'no-cache',
		},
		redirect: 'manual',
	});
	return { status: r.status, auth: r.headers.get('x-cpn-auth'), body: await r.text() };
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

function teardown(): void {
	if (!fs.existsSync(STATE_PATH)) {
		console.log('No live state recorded; nothing to tear down.');
		return;
	}
	const s: LiveState = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
	const del = (stack?: string) => {
		if (!stack) return;
		const exists = aws(['cloudformation', 'describe-stacks', '--stack-name', stack], { allowFail: true });
		if (!exists) return;
		console.log(`Deleting ${stack}...`);
		aws(['cloudformation', 'delete-stack', '--stack-name', stack], { json: false });
		aws(['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', stack], { json: false, allowFail: true });
		const after = aws(['cloudformation', 'describe-stacks', '--stack-name', stack], { allowFail: true });
		const status = after?.Stacks?.[0]?.StackStatus;
		if (status === 'DELETE_FAILED') {
			// Usually a replicated Lambda@Edge fn: retain it and finish the stack.
			const res = aws(['cloudformation', 'list-stack-resources', '--stack-name', stack]);
			const stuck = (res.StackResourceSummaries || [])
				.filter((r: any) => r.ResourceStatus === 'DELETE_FAILED').map((r: any) => r.LogicalResourceId);
			console.log(`  ${stack} DELETE_FAILED; retaining ${stuck.join(', ')}`);
			aws(['cloudformation', 'delete-stack', '--stack-name', stack, '--retain-resources', ...stuck], { json: false });
			aws(['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', stack], { json: false, allowFail: true });
		}
	};
	if (s.siteBucket) {
		console.log(`Emptying ${s.siteBucket}...`);
		aws(['s3', 'rm', `s3://${s.siteBucket}`, '--recursive', '--quiet'], { json: false, allowFail: true });
	}
	del(s.fullStack);
	del(s.poolStack);
	del(s.edgeStack);
	if (s.siteBucket) {
		// Versioned + retained: remove all versions, then the bucket.
		const versions = aws(['s3api', 'list-object-versions', '--bucket', s.siteBucket], { allowFail: true });
		const objs = [...(versions?.Versions || []), ...(versions?.DeleteMarkers || [])].map((v: any) => ({ Key: v.Key, VersionId: v.VersionId }));
		for (let i = 0; i < objs.length; i += 500) {
			aws(['s3api', 'delete-objects', '--bucket', s.siteBucket, '--delete', JSON.stringify({ Objects: objs.slice(i, i + 500), Quiet: true })], { allowFail: true });
		}
		aws(['s3api', 'delete-bucket', '--bucket', s.siteBucket], { json: false, allowFail: true });
	}
	// Leftover edge functions (legacy inline fn + the new edge fn if retained).
	const leftovers: string[] = [];
	const fns = aws(['lambda', 'list-functions'], { allowFail: true })?.Functions || [];
	for (const f of fns) {
		if (!String(f.FunctionName).includes(s.variant)) continue;
		const ok = aws(['lambda', 'delete-function', '--function-name', f.FunctionName], { json: false, allowFail: true });
		if (ok === null) leftovers.push(f.FunctionName);
		else console.log(`Deleted function ${f.FunctionName}`);
	}
	const roles = aws(['iam', 'list-roles'], { allowFail: true })?.Roles || [];
	for (const r of roles) {
		if (!String(r.RoleName).includes(s.variant)) continue;
		for (const p of aws(['iam', 'list-attached-role-policies', '--role-name', r.RoleName], { allowFail: true })?.AttachedPolicies || []) {
			aws(['iam', 'detach-role-policy', '--role-name', r.RoleName, '--policy-arn', p.PolicyArn], { json: false, allowFail: true });
		}
		for (const n of aws(['iam', 'list-role-policies', '--role-name', r.RoleName], { allowFail: true })?.PolicyNames || []) {
			aws(['iam', 'delete-role-policy', '--role-name', r.RoleName, '--policy-name', n], { json: false, allowFail: true });
		}
		if (aws(['iam', 'delete-role', '--role-name', r.RoleName], { json: false, allowFail: true }) !== null) {
			console.log(`Deleted role ${r.RoleName}`);
		}
	}
	// Membership file + trigger/edge artifacts in the bootstrap bucket.
	if (s.accountId && s.poolStack) {
		aws(['s3', 'rm', `s3://cpn-assets-${s.accountId}-us-east-1/access/${s.poolStack}/`, '--recursive', '--quiet'], { json: false, allowFail: true });
	}
	if (!leftovers.length && s.bootstrapPreexisting === false && s.accountId) {
		const assets = `cpn-assets-${s.accountId}-us-east-1`;
		console.log(`Removing the bootstrap stack this run created (${assets})...`);
		aws(['s3', 'rm', `s3://${assets}`, '--recursive', '--quiet'], { json: false, allowFail: true });
		const versions = aws(['s3api', 'list-object-versions', '--bucket', assets], { allowFail: true });
		const objs = [...(versions?.Versions || []), ...(versions?.DeleteMarkers || [])].map((v: any) => ({ Key: v.Key, VersionId: v.VersionId }));
		for (let i = 0; i < objs.length; i += 500) {
			aws(['s3api', 'delete-objects', '--bucket', assets, '--delete', JSON.stringify({ Objects: objs.slice(i, i + 500), Quiet: true })], { allowFail: true });
		}
		del('cpn-bootstrap');
		aws(['s3api', 'delete-bucket', '--bucket', assets], { json: false, allowFail: true });
	}
	if (leftovers.length) {
		console.log(`\nStill replicating (retry --teardown in a few hours): ${leftovers.join(', ')}`);
	} else {
		fs.unlinkSync(STATE_PATH);
		console.log('\nTeardown complete.');
	}
}

// ---------------------------------------------------------------------------
// Live test
// ---------------------------------------------------------------------------

async function live(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	const step = (name: string, cond: boolean, detail: string) => (cond ? ctx.pass(name, detail) : ctx.fail(name, detail));
	if (process.argv.includes('--resume')) return resume(ctx, step);

	const accountId = aws(['sts', 'get-caller-identity']).Account as string;
	const variant = `acce2e${crypto.randomBytes(3).toString('hex')}`;
	const state: LiveState = { variant, accountId, domainPrefix: `cpnlive${crypto.randomBytes(4).toString('hex')}` };
	state.bootstrapPreexisting = !!aws(['cloudformation', 'describe-stacks', '--stack-name', 'cpn-bootstrap'], { allowFail: true });
	saveState(state);
	console.log(`  variant: ${variant} (account ${accountId})`);

	// --- 1a. Legacy pool stack (inline edge fn) ----------------------------------
	state.poolStack = `cpn-cognito-${variant}`;
	saveState(state);
	const tplPath = path.join(os.tmpdir(), `cpn-legacy-cognito-${variant}.json`);
	fs.writeFileSync(tplPath, legacyCognitoTemplate());
	aws(['cloudformation', 'create-stack', '--stack-name', state.poolStack, '--template-body', `file://${tplPath}`,
		'--capabilities', 'CAPABILITY_IAM', '--tags', 'Key=cpn:managed,Value=true', 'Key=cpn:profile,Value=default',
		'--parameters', `ParameterKey=VariantName,ParameterValue=${variant}`,
		'ParameterKey=GoogleClientId,ParameterValue=live-e2e-fake-client',
		'ParameterKey=GoogleClientSecret,ParameterValue=live-e2e-fake-secret',
		`ParameterKey=AuthDomainPrefix,ParameterValue=${state.domainPrefix}`]);
	aws(['cloudformation', 'wait', 'stack-create-complete', '--stack-name', state.poolStack], { json: false });
	const legacy = stackOutputs(state.poolStack);
	step('Legacy pool stack deployed', !!legacy.EdgeFunctionVersionArn, legacy.EdgeFunctionVersionArn || 'no edge ARN');

	// --- 1b. Full site stack on the legacy edge fn (via the plugin) -------------
	const site = await page.evaluate(async ({ variant, awsProfile, legacy, poolStack }) => {
		const plugin = (window as any).app.plugins.plugins['commonplace-notes'];
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === 'default');
		profile.awsSettings = {
			...profile.awsSettings, awsProfile, region: 'us-east-1', bucketName: '', s3Prefix: '',
			cloudFrontDistributionId: '', awsAccountId: '', credentialMode: 'sdk', cloudFrontInvalidationScheme: 'all',
		};
		profile.publishMechanism = 'AWS';
		profile.publishContentIndex = true;
		profile.chat = undefined;
		profile.commenting = undefined;
		profile.accessGroups = undefined;
		profile.homeNotePath = 'Access Home.md';
		profile.excludedDirectories = ['private/'];
		plugin.awsSdkManager.invalidateClients?.(profile.id, awsProfile);
		const cfm = plugin.cloudFormationManager;
		const config = {
			profileId: 'default', variantName: variant, s3Prefix: '', customDomain: '', useRoute53: false,
			hostedZoneId: '', hostedZoneName: '', region: 'us-east-1', awsProfile, originAccessMethod: 'oac',
			authLambdaEdgeArn: legacy.EdgeFunctionVersionArn, callbackApiDomainName: legacy.CallbackApiDomain,
		};
		const stackName = await cfm.deployFullStack(config);
		const status = await cfm.pollStackUntilComplete(stackName, profile, () => {}, 'us-east-1');
		if (status !== 'CREATE_COMPLETE' && status !== 'UPDATE_COMPLETE') return { error: `full stack ${status}` };
		const out = await cfm.getStackOutputs(stackName, profile, 'us-east-1');
		profile.awsSettings.bucketName = out.bucketName;
		profile.awsSettings.cloudFrontDistributionId = out.distributionId;
		profile.baseUrl = `https://${out.distributionDomainName}`;
		profile.readGate = { mode: 'cognito' };
		profile.infrastructureState = {
			status: 'deployed', fullStackName: stackName, useRoute53: false, region: 'us-east-1', variantName: variant,
			originAccessMethod: 'oac', authLambdaEdgeArn: legacy.EdgeFunctionVersionArn, readGateMode: 'cognito',
			cognitoAuth: {
				stackName: poolStack, enabled: true, commentIdentity: false,
				userPoolId: legacy.UserPoolId, userPoolClientId: legacy.UserPoolClientId, hostedUiDomain: legacy.HostedUiDomain,
				jwksUri: legacy.JwksUri, issuer: legacy.Issuer, edgeFunctionVersionArn: legacy.EdgeFunctionVersionArn,
				callbackApiDomain: legacy.CallbackApiDomain,
			},
		};
		await plugin.saveSettings();
		return { stackName, ...out };
	}, { variant, awsProfile: AWS_PROFILE, legacy, poolStack: state.poolStack }) as any;
	if (site.error) { ctx.fail('Full site stack deployed', site.error); return; }
	state.fullStack = site.stackName;
	state.siteBucket = site.bucketName;
	state.distributionId = site.distributionId;
	saveState(state);
	const base = `https://${site.distributionDomainName}`;
	step('Full site stack deployed on legacy edge fn', !!site.bucketName, `${base} bucket=${site.bucketName}`);
	const legacyPoolRes = aws(['cloudformation', 'describe-stack-resource', '--stack-name', state.poolStack, '--logical-resource-id', 'AuthEdgeFn']);
	state.legacyEdgeFunction = legacyPoolRes.StackResourceDetail.PhysicalResourceId;
	saveState(state);

	// --- 2. Upgrade the Cognito gate --------------------------------------------
	const up = await page.evaluate(async () => {
		const plugin = (window as any).app.plugins.plugins['commonplace-notes'];
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === 'default');
		try {
			const r = await plugin.cloudFormationManager.upgradeCognitoGate(profile, () => {});
			await plugin.syncAccessGroups(profile, { force: true });
			return { ...r, state: profile.infrastructureState, pending: profile.pendingEdgeCleanup };
		} catch (e) {
			return { error: String(e) };
		}
	}) as any;
	if (up.error) { ctx.fail('Upgrade Cognito gate', up.error); return; }
	state.edgeStack = up.state.cognitoAuth.edgeStackName;
	saveState(state);
	const poolTpl = aws(['cloudformation', 'get-template', '--stack-name', state.poolStack]).TemplateBody;
	const poolResources = Object.keys((typeof poolTpl === 'string' ? JSON.parse(poolTpl) : poolTpl).Resources);
	step('Upgrade: legacy edge fn removed from pool stack', !poolResources.includes('AuthEdgeFn') && poolResources.includes('PreTokenGroupsFn'), poolResources.join(','));
	const legacyStillExists = aws(['lambda', 'get-function', '--function-name', state.legacyEdgeFunction!], { allowFail: true });
	step('Upgrade: legacy edge fn retained (not deleted while replicated)', !!legacyStillExists, state.legacyEdgeFunction!);
	step('Upgrade: legacy fn queued for cleanup', (up.pending || []).some((p: any) => p.functionName === state.legacyEdgeFunction), JSON.stringify(up.pending));
	const dist = aws(['cloudfront', 'get-distribution-config', '--id', site.distributionId]);
	const assoc = dist.DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations?.Items?.[0]?.LambdaFunctionARN;
	step('Upgrade: CloudFront re-pointed at the new edge version', assoc === up.edgeFunctionVersionArn && assoc !== legacy.EdgeFunctionVersionArn, `${assoc}`);
	step('Upgrade: state records edge stack + membership location', !!(up.state.cognitoAuth.edgeStackName && up.state.cognitoAuth.accessGroupsKey), JSON.stringify(up.state.cognitoAuth));

	await publishAndVerify(ctx, step, state, site, legacy, accountId);
}

type Step = (name: string, cond: boolean, detail: string) => void;

/**
 * Continue a run whose stacks are already deployed and upgraded (e.g. after a
 * test-script fix): re-seed the plugin profile from the live stacks, then run
 * the publish/edge/transition checks.
 */
async function resume(ctx: TestContext, step: Step): Promise<void> {
	const state: LiveState = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
	if (!state.fullStack || !state.poolStack || !state.edgeStack) throw new Error('No upgraded deployment recorded to resume.');
	const pool = stackOutputs(state.poolStack);
	const full = stackOutputs(state.fullStack);
	const edgeArn = stackOutputs(state.edgeStack).EdgeFunctionVersionArn;
	const site = {
		stackName: state.fullStack,
		bucketName: full.BucketName,
		distributionId: full.DistributionID,
		distributionDomainName: full.DistributionDomainName,
	};
	await ctx.page.evaluate(async ({ awsProfile, state, pool, site, edgeArn }) => {
		const plugin = (window as any).app.plugins.plugins['commonplace-notes'];
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === 'default');
		profile.awsSettings = {
			...profile.awsSettings, awsProfile, region: 'us-east-1', bucketName: site.bucketName, s3Prefix: '',
			cloudFrontDistributionId: site.distributionId, awsAccountId: '', credentialMode: 'sdk', cloudFrontInvalidationScheme: 'all',
		};
		profile.publishMechanism = 'AWS';
		profile.publishContentIndex = true;
		profile.chat = undefined;
		profile.commenting = undefined;
		profile.homeNotePath = 'Access Home.md';
		profile.baseUrl = `https://${site.distributionDomainName}`;
		profile.readGate = { mode: 'cognito' };
		profile.infrastructureState = {
			status: 'deployed', fullStackName: site.stackName, useRoute53: false, region: 'us-east-1', variantName: state.variant,
			originAccessMethod: 'oac', authLambdaEdgeArn: edgeArn, readGateMode: 'cognito',
			cognitoAuth: {
				stackName: state.poolStack, enabled: true, commentIdentity: false,
				userPoolId: pool.UserPoolId, userPoolClientId: pool.UserPoolClientId, hostedUiDomain: pool.HostedUiDomain,
				jwksUri: pool.JwksUri, issuer: pool.Issuer, edgeFunctionVersionArn: edgeArn, callbackApiDomain: pool.CallbackApiDomain,
				edgeStackName: state.edgeStack, accessGroupsBucket: pool.AccessGroupsBucket, accessGroupsKey: pool.AccessGroupsKey,
			},
		};
		await plugin.saveSettings();
	}, { awsProfile: AWS_PROFILE, state, pool, site, edgeArn });
	step('Resume: profile re-seeded from live stacks', !!pool.AccessGroupsKey && !!edgeArn, `${state.variant}`);
	await publishAndVerify(ctx, step, state, site, pool, state.accountId!);
}

async function publishAndVerify(ctx: TestContext, step: Step, state: LiveState, site: any, legacy: Record<string, string>, accountId: string): Promise<void> {
	const { page } = ctx;
	const base = `https://${site.distributionDomainName}`;

	// --- 3. Publish a small vault ------------------------------------------------
	const pub = await page.evaluate(async () => {
		const app = (window as any).app;
		const plugin = app.plugins.plugins['commonplace-notes'];
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === 'default');
		profile.accessGroups = {
			team: { members: ['Alice@Example.com'] },
			family: { members: ['carol@example.com'] },
		};
		await plugin.saveSettings();
		const notes: Record<string, string> = {
			'Access Home.md': '---\ncpn-publish-contexts:\n  - default\n---\nWelcome home.\n',
			'Public Note.md': '---\ncpn-publish-contexts:\n  - default\n---\nSee [[Team Secret]] and [[Family Secret]].\n',
			'Team Secret.md': '---\ncpn-publish-contexts:\n  - default\ncpn-access-groups:\n  - team\n---\nTOP-SECRET-TEAM-BODY links [[Public Note]].\n',
			'Family Secret.md': '---\ncpn-publish-contexts:\n  - default\ncpn-access-groups:\n  - family\n---\nFAMILY-BODY\n',
			'Bad Group.md': '---\ncpn-publish-contexts:\n  - default\ncpn-access-groups:\n  - nope\n---\nBAD-GROUP-BODY\n',
		};
		for (const [p, body] of Object.entries(notes)) {
			const existing = app.vault.getAbstractFileByPath(p);
			if (existing) await app.vault.modify(existing, body);
			else await app.vault.create(p, body);
		}
		await new Promise(r => setTimeout(r, 2500)); // metadata cache
		const files = Object.keys(notes).map(p => app.vault.getAbstractFileByPath(p));
		await plugin.publisher.publishNotes(files, profile, true, true);
		await new Promise(r => setTimeout(r, 1500)); // frontmatter UID writes
		// No named helpers in page.evaluate bodies: tsx injects __name() for them,
		// which doesn't exist in the page.
		const hist = JSON.parse(await app.vault.adapter.read(plugin.profileManager.getPublishHistoryPath('default')));
		const uids: Record<string, string> = {};
		for (const p of Object.keys(notes)) uids[p] = plugin.frontmatterManager.getNoteUID(app.vault.getAbstractFileByPath(p));
		return { uids, hist };
	}) as any;
	const { uids, hist } = pub;
	const U = (p: string) => uids[p];
	const lastHash = (p: string) => (hist[U(p)] || []).slice(-1)[0];
	const B = state.siteBucket!;

	const publicNoteKeys = s3Keys(B, 'notes/');
	const teamKeys = s3Keys(B, 'restricted/team/notes/');
	step('S3: team note only in restricted/team/', teamKeys.includes(`restricted/team/notes/${lastHash('Team Secret.md')}.json`) && !publicNoteKeys.includes(`notes/${lastHash('Team Secret.md')}.json`), teamKeys.join(','));
	step('S3: family note only in restricted/family/', s3Keys(B, 'restricted/family/notes/').includes(`restricted/family/notes/${lastHash('Family Secret.md')}.json`) && !publicNoteKeys.includes(`notes/${lastHash('Family Secret.md')}.json`) && !teamKeys.some(k => k.includes(lastHash('Family Secret.md'))), s3Keys(B, 'restricted/family/notes/').join(','));
	step('S3: undefined-group note not published anywhere', !lastHash('Bad Group.md') || (!publicNoteKeys.some(k => k.includes(lastHash('Bad Group.md'))) && !s3Keys(B, 'restricted/').some(k => k.includes(lastHash('Bad Group.md')))), String(lastHash('Bad Group.md')));
	const pubU2H = s3Json(B, 'static/mapping/uid-to-hash.json');
	const pubS2U = s3Json(B, 'static/mapping/slug-to-uid.json');
	const teamU2H = s3Json(B, 'restricted/team/static/mapping/uid-to-hash.json');
	step('S3: public mapping excludes gated uids', !pubU2H[U('Team Secret.md')] && !pubU2H[U('Family Secret.md')] && !!pubU2H[U('Public Note.md')], JSON.stringify(pubU2H));
	step('S3: public slug map hides gated note paths', !JSON.stringify(pubS2U).includes('secret'), JSON.stringify(pubS2U));
	// (Compare this run's uids only: earlier runs against the same stacks may have left their own notes.)
	step('S3: team mirror lists the team note, not public/family ones', !!teamU2H[U('Team Secret.md')] && !teamU2H[U('Public Note.md')] && !teamU2H[U('Family Secret.md')], JSON.stringify(teamU2H));
	const idx = s3Json(B, 'static/content/contentIndex.json');
	step('S3: search index excludes gated notes', !JSON.stringify(idx).includes('TOP-SECRET') && !JSON.stringify(idx).includes('FAMILY-BODY'), Object.keys(idx).join(','));
	const pubNoteJson = s3Json(B, `notes/${lastHash('Public Note.md')}.json`);
	step('S3: public HTML does not link/leak gated notes', !pubNoteJson.content.includes(U('Team Secret.md')) && !pubNoteJson.content.includes(U('Family Secret.md')), pubNoteJson.content);
	step('S3: public note has no backlink from the gated note', !(pubNoteJson.backlinks || []).some((b: any) => b.uid === U('Team Secret.md')), JSON.stringify(pubNoteJson.backlinks));
	const teamJson = s3Json(B, `restricted/team/notes/${lastHash('Team Secret.md')}.json`);
	step('S3: gated note JSON flagged, keeps its public backlink', teamJson.gated === true && (teamJson.backlinks || []).some((b: any) => b.uid === U('Public Note.md')), JSON.stringify({ gated: teamJson.gated, backlinks: teamJson.backlinks }));
	const head = aws(['s3api', 'head-object', '--bucket', B, '--key', `restricted/team/notes/${lastHash('Team Secret.md')}.json`]);
	step('S3: restricted objects are private, no-store', head.CacheControl === 'private, no-store', String(head.CacheControl));
	const cfg = s3Json(B, 'config.json');
	step('S3: config.json advertises gating without group names', cfg.accessGating === true && !JSON.stringify(cfg).includes('team'), JSON.stringify(cfg));
	const membership = s3Json(`cpn-assets-${accountId}-us-east-1`, `access/${state.poolStack}/groups.json`);
	step('S3: membership file uploaded (normalized)', JSON.stringify(membership.groups.team) === '["alice@example.com"]', JSON.stringify(membership));

	// --- 4. Through CloudFront with real tokens ---------------------------------
	const poolId = legacy.UserPoolId;
	const clientId = legacy.UserPoolClientId;
	const client = aws(['cognito-idp', 'describe-user-pool-client', '--user-pool-id', poolId, '--client-id', clientId]).UserPoolClient;
	// Throwaway stack: add admin password auth to the stack's app client so native
	// test users get tokens with the audience the edge fn expects.
	aws(['cognito-idp', 'update-user-pool-client', '--user-pool-id', poolId, '--client-id', clientId,
		'--explicit-auth-flows', 'ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH',
		'--supported-identity-providers', ...client.SupportedIdentityProviders,
		'--allowed-o-auth-flows', ...client.AllowedOAuthFlows, '--allowed-o-auth-scopes', ...client.AllowedOAuthScopes,
		'--allowed-o-auth-flows-user-pool-client', '--callback-urls', ...client.CallbackURLs, '--logout-urls', ...(client.LogoutURLs || client.CallbackURLs)]);
	for (const email of ['alice@example.com', 'bob@example.com']) {
		aws(['cognito-idp', 'admin-create-user', '--user-pool-id', poolId, '--username', email, '--message-action', 'SUPPRESS',
			'--user-attributes', `Name=email,Value=${email}`, 'Name=email_verified,Value=true'], { allowFail: true });
		aws(['cognito-idp', 'admin-set-user-password', '--user-pool-id', poolId, '--username', email, '--password', PASSWORD, '--permanent'], { json: false });
	}
	const alice = idToken(poolId, clientId, client.ClientSecret, 'alice@example.com');
	const bob = idToken(poolId, clientId, client.ClientSecret, 'bob@example.com');
	const claims = JSON.parse(Buffer.from(alice.split('.')[1], 'base64url').toString());
	step('Token: trigger injected cognito:groups', JSON.stringify(claims['cognito:groups']) === '["team"]', JSON.stringify(claims['cognito:groups']));

	const teamUrl = `${base}/restricted/team/notes/${lastHash('Team Secret.md')}.json`;
	const who = await get(`${base}/restricted/whoami`, alice);
	step('Edge: whoami returns alice\'s groups', who.status === 200 && JSON.parse(who.body).groups.join() === 'team', `${who.status} ${who.body}`);
	const aTeam = await get(teamUrl, alice);
	step('Edge: member reads gated note', aTeam.status === 200 && aTeam.body.includes('TOP-SECRET-TEAM-BODY'), `${aTeam.status}`);
	const bTeam = await get(teamUrl, bob);
	step('Edge: non-member gets 403 forbidden', bTeam.status === 403 && bTeam.auth === 'forbidden', `${bTeam.status} ${bTeam.auth}`);
	const aFam = await get(`${base}/restricted/family/static/mapping/uid-to-hash.json`, alice);
	step('Edge: member of another group gets 403', aFam.status === 403 && aFam.auth === 'forbidden', `${aFam.status} ${aFam.auth}`);
	const anon = await get(`${base}/notes/${lastHash('Public Note.md')}.json`);
	step('Edge: anonymous data fetch gets 401 required', anon.status === 401 && anon.auth === 'required', `${anon.status} ${anon.auth}`);
	const bPub = await get(`${base}/notes/${lastHash('Public Note.md')}.json`, bob);
	step('Edge: any signed-in reader reads public notes', bPub.status === 200, `${bPub.status}`);

	// --- 5. Transitions ---------------------------------------------------------
	const firstTeamHash = lastHash('Team Secret.md');
	const t1 = await page.evaluate(async () => {
		const app = (window as any).app;
		const plugin = app.plugins.plugins['commonplace-notes'];
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === 'default');
		const f = app.vault.getAbstractFileByPath('Team Secret.md');
		await app.fileManager.processFrontMatter(f, (fm: any) => { delete fm['cpn-access-groups']; });
		await new Promise(r => setTimeout(r, 2000));
		await plugin.publisher.publishNotes([f], profile, false, false);
		return JSON.parse(await app.vault.adapter.read(plugin.profileManager.getPublishHistoryPath('default')));
	}) as any;
	const publicHash = (t1[U('Team Secret.md')] || []).slice(-1)[0];
	step('Transition gated->public: team copies deleted', !s3Keys(B, 'restricted/team/notes/').some(k => k.includes(firstTeamHash)), s3Keys(B, 'restricted/team/notes/').join(','));
	step('Transition gated->public: public copy + mapping present', s3Keys(B, 'notes/').includes(`notes/${publicHash}.json`) && !!s3Json(B, 'static/mapping/uid-to-hash.json')[U('Team Secret.md')], publicHash);

	const t2 = await page.evaluate(async () => {
		const app = (window as any).app;
		const plugin = app.plugins.plugins['commonplace-notes'];
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === 'default');
		const f = app.vault.getAbstractFileByPath('Team Secret.md');
		await app.fileManager.processFrontMatter(f, (fm: any) => { fm['cpn-access-groups'] = ['team']; });
		await new Promise(r => setTimeout(r, 2000));
		await plugin.publisher.publishNotes([f], profile, false, false);
		return JSON.parse(await app.vault.adapter.read(plugin.profileManager.getPublishHistoryPath('default')));
	}) as any;
	const allTeamHashes: string[] = t2[U('Team Secret.md')] || [];
	const pubKeys = s3Keys(B, 'notes/');
	step('Transition public->gated: every historical public copy deleted', !allTeamHashes.some(h => pubKeys.includes(`notes/${h}.json`)), allTeamHashes.join(','));
	step('Transition public->gated: dropped from public mapping', !s3Json(B, 'static/mapping/uid-to-hash.json')[U('Team Secret.md')], 'ok');
	const inv = aws(['cloudfront', 'list-invalidations', '--distribution-id', site.distributionId]).InvalidationList?.Items || [];
	step('Transition forced a CloudFront invalidation (scheme is "all")', inv.length >= 3, `${inv.length} invalidations`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

if (!AWS_PROFILE) {
	console.error('Set CPN_LIVE_AWS_PROFILE to a sandbox AWS CLI profile to run this live test.');
	process.exit(2);
}

if (process.argv.includes('--teardown')) {
	teardown();
} else {
	const snapshot = fs.readFileSync(DATA_JSON, 'utf8');
	runTest({ name: 'access-groups-live', cleanupFiles: NOTE_FILES, launchTimeout: 60_000 }, async (ctx) => {
		try {
			await live(ctx);
		} catch (err) {
			ctx.fail('Live run', `aborted: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			// Restore the test vault's settings before Obsidian closes (the plugin
			// may save again on unload, so write through the plugin too).
			await ctx.page.evaluate(async (snap: string) => {
				const plugin = (window as any).app.plugins.plugins['commonplace-notes'];
				Object.assign(plugin.settings, JSON.parse(snap));
				await plugin.saveSettings();
			}, snapshot).catch(() => {});
			fs.writeFileSync(DATA_JSON, snapshot);
			console.log(`\n  Live resources recorded in ${STATE_PATH}; run with --teardown to remove them.`);
		}
	});
}
