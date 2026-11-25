#!/usr/bin/env npx tsx
/**
 * Phase-1 groundwork — LIVE AWS end-to-end test (opt-in, creates real resources)
 *
 * The sandbox checks from specs/attachment-publishing/phase-1-groundwork.md §5:
 *
 *   1. A Cognito pool deployed BEFORE SessionHours existed (the pool template at
 *      PRE_SESSION_COMMIT) is upgraded with CloudFormationManager.upgradeCognitoGate
 *      without touching the session length: the stack gets SessionHours=1, the
 *      app client keeps 1-hour tokens, the profile records sessionHours: 1, and a
 *      real sign-in through the deployed callback sets cpn_id with Max-Age ≈ 3600.
 *   2. Apply 12 h through the real Settings → Infrastructure → Sign-in session
 *      length row: SessionHours=12, 12-hour tokens, Max-Age ≈ 43200, and the
 *      Google IdP keeps its client secret (Google sign-in itself needs a browser
 *      and a real Google client, so the checks are: the IdP secret is unchanged
 *      and the Hosted UI still redirects to Google with the client id).
 *   3. A new pool with the wizard's defaults: the wizard's field shows 12, and a
 *      deploy as the wizard runs it (create, then the phase-2 update that runs
 *      before the profile records the pool) gets 12-hour sessions.
 *   4. Publish to a throwaway S3 bucket: a note with `a \* [[Note]] b` and a
 *      table row `| [[Note\|alias]] | x |` publishes a `raw` that parses to the
 *      same text and table as the source; `**\/private/` keeps a note in
 *      Sess-Projects/private/ unpublished while Sess-Projects/public/ publishes;
 *      `![[Sess-Media/song.mp3]]` publishes as `![[null.mp3]]`.
 *
 * Real sign-ins: the stack's app client gets native (COGNITO) users enabled,
 * preserving its token validity, then the Hosted UI login form is driven over
 * HTTP to get an authorization code, which the deployed callback Lambda
 * exchanges and turns into the cpn_id cookie.
 *
 * Usage (sandbox account only):
 *   CPN_LIVE_AWS_PROFILE=random npx tsx e2e/scripts/session-length-live-e2e.ts
 *   CPN_LIVE_AWS_PROFILE=random npx tsx e2e/scripts/session-length-live-e2e.ts --teardown
 *
 * Resource names go to e2e/results/session-length-live-state.json so a failed
 * run can still be torn down. No Lambda@Edge is created, so teardown completes
 * in one go. The test vault's plugin data.json is snapshotted and restored.
 */

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { runTest, type TestContext } from '../lib/test-harness';
import { PROJECT_ROOT, VAULT_PATH, RESULTS_DIR, PLUGIN_ID } from '../lib/test-helpers';

const AWS_PROFILE = process.env.CPN_LIVE_AWS_PROFILE;
const REGION = 'us-east-1';
const STATE_PATH = path.join(RESULTS_DIR, 'session-length-live-state.json');
const DATA_JSON = path.join(VAULT_PATH, '.obsidian', 'plugins', PLUGIN_ID, 'data.json');
/** Last commit whose Cognito pool template has no SessionHours parameter. */
const PRE_SESSION_COMMIT = '5d4bff1';
const PASSWORD = 'Sess-E2e-Passw0rd!';
const GOOGLE_ID = 'sess-e2e-fake-client';
const GOOGLE_SECRET = 'sess-e2e-fake-secret';
const LIVE_PROFILE = 'sess-live';
const NEW_PROFILE = 'sess-new';
const PUB_PROFILE = 'sess-pub';

const NOTES: Record<string, string> = {
	'Sess Target.md': '# Sess Target\n\nTarget body.\n',
	'Sess Raw.md': [
		'Escaped: a \\* [[Sess Target]] b',
		'',
		'| h | x |',
		'|---|---|',
		'| [[Sess Target\\|alias]] | x |',
		'',
		'Media: ![[Sess-Media/song.mp3]]',
		'',
	].join('\n'),
	'Sess-Projects/private/Hidden.md': 'Hidden note body.\n',
	'Sess-Projects/public/Shown.md': 'Shown note body.\n',
};
const FIXTURE_ROOTS = ['Sess Target.md', 'Sess Raw.md', 'Sess-Projects', 'Sess-Media'];

interface LiveState {
	variant: string;
	accountId?: string;
	oldPoolStack?: string;
	newPoolStack?: string;
	pubBucket?: string;
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

function stackParam(stackName: string, key: string): string | undefined {
	const d = aws(['cloudformation', 'describe-stacks', '--stack-name', stackName]);
	return (d.Stacks[0].Parameters || []).find((p: any) => p.ParameterKey === key)?.ParameterValue;
}

function describeClient(poolId: string, clientId: string): any {
	return aws(['cognito-idp', 'describe-user-pool-client', '--user-pool-id', poolId, '--client-id', clientId]).UserPoolClient;
}

/** "12 hours", "60 minutes", … from the client's IdTokenValidity + units. */
function idTokenLifetime(client: any): { value: number | null; unit: string } {
	return { value: client.IdTokenValidity ?? null, unit: client.TokenValidityUnits?.IdToken ?? '(default)' };
}

function saveState(s: LiveState): void {
	fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
	fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function preSessionCognitoTemplate(): string {
	const src = execFileSync('git', ['show', `${PRE_SESSION_COMMIT}:src/infrastructure/templates.ts`], { cwd: PROJECT_ROOT, encoding: 'utf8' });
	const m = src.match(/export const COGNITO_AUTH_TEMPLATE = (".*");/);
	if (!m) throw new Error('Could not extract the pre-SessionHours COGNITO_AUTH_TEMPLATE');
	const tpl: string = JSON.parse(m[1]);
	if (tpl.includes('SessionHours')) throw new Error(`${PRE_SESSION_COMMIT} template already has SessionHours`);
	return tpl;
}

// ---------------------------------------------------------------------------
// Real sign-in through the Hosted UI and the deployed callback
// ---------------------------------------------------------------------------

/**
 * Let native test users sign in on the stack's own app client. Every field
 * update-user-pool-client isn't given is reset to its default, so the token
 * validity (the thing under test) is passed back as described.
 */
function enableNativeSignIn(poolId: string, clientId: string): void {
	const c = describeClient(poolId, clientId);
	const providers = Array.from(new Set([...(c.SupportedIdentityProviders || []), 'COGNITO']));
	const args = ['cognito-idp', 'update-user-pool-client', '--user-pool-id', poolId, '--client-id', clientId,
		'--explicit-auth-flows', 'ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH',
		'--supported-identity-providers', ...providers,
		'--allowed-o-auth-flows', ...c.AllowedOAuthFlows, '--allowed-o-auth-scopes', ...c.AllowedOAuthScopes,
		'--allowed-o-auth-flows-user-pool-client', '--callback-urls', ...c.CallbackURLs, '--logout-urls', ...(c.LogoutURLs || c.CallbackURLs)];
	if (c.IdTokenValidity != null) args.push('--id-token-validity', String(c.IdTokenValidity));
	if (c.AccessTokenValidity != null) args.push('--access-token-validity', String(c.AccessTokenValidity));
	if (c.RefreshTokenValidity != null) args.push('--refresh-token-validity', String(c.RefreshTokenValidity));
	if (c.TokenValidityUnits) {
		args.push('--token-validity-units', Object.entries(c.TokenValidityUnits).map(([k, v]) => `${k}=${v}`).join(','));
	}
	aws(args);
	const after = describeClient(poolId, clientId);
	if (after.IdTokenValidity !== c.IdTokenValidity || JSON.stringify(after.TokenValidityUnits) !== JSON.stringify(c.TokenValidityUnits)) {
		throw new Error(`enabling native sign-in changed token validity: ${JSON.stringify(idTokenLifetime(c))} → ${JSON.stringify(idTokenLifetime(after))}`);
	}
}

function ensureUser(poolId: string, email: string): void {
	aws(['cognito-idp', 'admin-create-user', '--user-pool-id', poolId, '--username', email, '--message-action', 'SUPPRESS',
		'--user-attributes', `Name=email,Value=${email}`, 'Name=email_verified,Value=true'], { allowFail: true });
	aws(['cognito-idp', 'admin-set-user-password', '--user-pool-id', poolId, '--username', email, '--password', PASSWORD, '--permanent'], { json: false });
}

/** A tiny cookie jar for one origin. */
class Jar {
	private cookies = new Map<string, string>();
	take(res: Response): void {
		for (const c of res.headers.getSetCookie()) {
			const [pair] = c.split(';');
			const eq = pair.indexOf('=');
			this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
		}
	}
	header(): string {
		return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
	}
}

interface SignInResult {
	maxAge: number | null;
	cookie: string;
	tokenLifetime: number | null;
	error?: string;
}

/**
 * Sign in a native user through the Hosted UI and follow the code to the
 * deployed callback (`redirectUri`, the API Gateway route). Returns the cpn_id
 * cookie's Max-Age and the token's exp − iat.
 */
async function signInThroughCallback(hostedUi: string, clientId: string, redirectUri: string, email: string): Promise<SignInResult> {
	const q = new URLSearchParams({
		response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
		scope: 'openid email profile', state: '/sess-e2e', identity_provider: 'COGNITO',
	});
	const jar = new Jar();
	// The Hosted UI domain can take a little while to resolve after creation.
	let auth: Response | undefined;
	for (let i = 0; i < 30; i++) {
		try {
			auth = await fetch(`${hostedUi}/oauth2/authorize?${q}`, { redirect: 'manual' });
			break;
		} catch {
			await new Promise(r => setTimeout(r, 10_000));
		}
	}
	if (!auth) return { maxAge: null, cookie: '', tokenLifetime: null, error: 'Hosted UI unreachable' };
	jar.take(auth);
	const loginLoc = auth.headers.get('location');
	if (auth.status !== 302 || !loginLoc) return { maxAge: null, cookie: '', tokenLifetime: null, error: `authorize → ${auth.status}` };
	const loginUrl = new URL(loginLoc, hostedUi).toString();

	const page = await fetch(loginUrl, { headers: { cookie: jar.header() }, redirect: 'manual' });
	jar.take(page);
	const html = await page.text();
	const csrf = /name="_csrf"\s+value="([^"]+)"/.exec(html)?.[1] ?? /value="([^"]+)"\s+name="_csrf"/.exec(html)?.[1];
	if (!csrf) return { maxAge: null, cookie: '', tokenLifetime: null, error: `no _csrf on login page (${page.status})` };

	const post = await fetch(loginUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
		body: new URLSearchParams({ _csrf: csrf, username: email, password: PASSWORD, signInSubmitButton: 'Sign in' }).toString(),
		redirect: 'manual',
	});
	const codeLoc = post.headers.get('location') || '';
	if (post.status !== 302 || !codeLoc.startsWith(redirectUri)) {
		return { maxAge: null, cookie: '', tokenLifetime: null, error: `login POST → ${post.status} ${codeLoc.slice(0, 120)}` };
	}

	const cb = await fetch(codeLoc, { redirect: 'manual' });
	const cookie = cb.headers.getSetCookie().find(c => c.startsWith('cpn_id=')) ?? '';
	if (cb.status !== 302 || !cookie) return { maxAge: null, cookie, tokenLifetime: null, error: `callback → ${cb.status} ${await cb.text()}` };
	const maxAge = Number(/;\s*Max-Age=(\d+)/i.exec(cookie)?.[1] ?? NaN);
	const token = cookie.slice('cpn_id='.length).split(';')[0];
	const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
	return { maxAge: Number.isFinite(maxAge) ? maxAge : null, cookie: cookie.replace(token, '<token>'), tokenLifetime: claims.exp - claims.iat };
}

/** Within a minute of `want` seconds (network and clock skew). */
const about = (got: number | null, want: number) => got !== null && Math.abs(got - want) <= 60;

// ---------------------------------------------------------------------------
// Parse helpers for the publish check
// ---------------------------------------------------------------------------

/** Text outside wikilinks plus the node outline (see test-obscure-wikilinks.ts). */
function outsideLinks(markdown: string): string {
	const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
	const parts: string[] = [];
	const walk = (node: any): void => {
		parts.push(`<${node.type}>`);
		if (node.type === 'text') parts.push(node.value.replace(/\[\[(.*?)\]\]/g, '[[…]]'));
		else if (typeof node.value === 'string') parts.push(node.value);
		for (const child of node.children ?? []) walk(child);
		parts.push(`</${node.type}>`);
	};
	walk(tree);
	return parts.join('');
}

function tableShape(markdown: string): string {
	const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
	const rows: number[] = [];
	const walk = (node: any): void => {
		if (node.type === 'tableRow') rows.push(node.children.length);
		for (const child of node.children ?? []) walk(child);
	};
	walk(tree);
	return rows.join(',');
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

function emptyVersionedBucket(bucket: string): void {
	aws(['s3', 'rm', `s3://${bucket}`, '--recursive', '--quiet'], { json: false, allowFail: true });
	for (;;) {
		const versions = aws(['s3api', 'list-object-versions', '--bucket', bucket], { allowFail: true });
		const objs = [...(versions?.Versions || []), ...(versions?.DeleteMarkers || [])].map((v: any) => ({ Key: v.Key, VersionId: v.VersionId }));
		if (objs.length === 0) break;
		for (let i = 0; i < objs.length; i += 500) {
			aws(['s3api', 'delete-objects', '--bucket', bucket, '--delete', JSON.stringify({ Objects: objs.slice(i, i + 500), Quiet: true })], { allowFail: true });
		}
	}
}

function teardown(): void {
	if (!fs.existsSync(STATE_PATH)) {
		console.log('No live state recorded; nothing to tear down.');
		return;
	}
	const s: LiveState = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
	const del = (stack?: string) => {
		if (!stack || !aws(['cloudformation', 'describe-stacks', '--stack-name', stack], { allowFail: true })) return;
		console.log(`Deleting ${stack}...`);
		aws(['cloudformation', 'delete-stack', '--stack-name', stack], { json: false });
		aws(['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', stack], { json: false, allowFail: true });
	};
	del(s.oldPoolStack);
	del(s.newPoolStack);
	if (s.pubBucket) {
		console.log(`Removing ${s.pubBucket}...`);
		emptyVersionedBucket(s.pubBucket);
		aws(['s3api', 'delete-bucket', '--bucket', s.pubBucket], { json: false, allowFail: true });
	}
	if (s.accountId) {
		const assets = `cpn-assets-${s.accountId}-us-east-1`;
		for (const stack of [s.oldPoolStack, s.newPoolStack]) {
			if (stack) aws(['s3', 'rm', `s3://${assets}/access/${stack}/`, '--recursive', '--quiet'], { json: false, allowFail: true });
		}
		if (s.bootstrapPreexisting === false) {
			console.log(`Removing the bootstrap stack this run created (${assets})...`);
			emptyVersionedBucket(assets);
			del('cpn-bootstrap');
			aws(['s3api', 'delete-bucket', '--bucket', assets], { json: false, allowFail: true });
		}
	}
	fs.unlinkSync(STATE_PATH);
	console.log('Teardown complete.');
}

// ---------------------------------------------------------------------------
// Live test
// ---------------------------------------------------------------------------

type Step = (name: string, cond: boolean, detail: string) => void;

/** Add (or replace) a profile in the running plugin's settings. */
async function putProfile(ctx: TestContext, profile: Record<string, unknown>): Promise<void> {
	await ctx.page.evaluate(async ({ pluginId, profile }) => {
		const plugin = (window as any).app.plugins.plugins[pluginId];
		const list = plugin.settings.publishingProfiles as any[];
		const base = list[0];
		const merged = {
			...base, chat: undefined, commenting: undefined, readGate: undefined, cognitoAuth: undefined,
			publicSiteAccessGroups: undefined, accessGroups: undefined, pendingEdgeCleanup: undefined,
			infrastructureState: undefined, homeNotePath: '', excludedDirsRulesVersion: 2, ...profile,
		};
		plugin.settings.publishingProfiles = [...list.filter((p) => p.id !== profile.id), merged];
		await plugin.saveSettings();
	}, { pluginId: PLUGIN_ID, profile });
}

const awsSettings = (bucketName = '') => ({
	awsProfile: AWS_PROFILE, region: REGION, bucketName, s3Prefix: '', awsAccountId: '',
	cloudFrontDistributionId: '', cloudFrontInvalidationScheme: 'manual', credentialMode: 'sdk',
	credentialRefreshCommands: '', awsCliPath: '',
});

async function live(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	const step: Step = (name, cond, detail) => (cond ? ctx.pass(name, detail) : ctx.fail(name, detail));

	const accountId = aws(['sts', 'get-caller-identity']).Account as string;
	const variant = `sesse2e${crypto.randomBytes(3).toString('hex')}`;
	const state: LiveState = { variant, accountId };
	state.bootstrapPreexisting = !!aws(['cloudformation', 'describe-stacks', '--stack-name', 'cpn-bootstrap'], { allowFail: true });
	saveState(state);
	console.log(`  variant: ${variant} (account ${accountId})`);

	// --- 1. Pre-SessionHours pool → Upgrade Cognito gate --------------------------
	console.log('\n[1] Pool deployed before SessionHours, then Upgrade Cognito gate');
	state.oldPoolStack = `cpn-cognito-${variant}`;
	saveState(state);
	const tplPath = path.join(os.tmpdir(), `cpn-pre-session-cognito-${variant}.json`);
	fs.writeFileSync(tplPath, preSessionCognitoTemplate());
	aws(['cloudformation', 'create-stack', '--stack-name', state.oldPoolStack, '--template-body', `file://${tplPath}`,
		'--capabilities', 'CAPABILITY_IAM', '--tags', 'Key=cpn:managed,Value=true', `Key=cpn:profile,Value=${LIVE_PROFILE}`,
		'--parameters', `ParameterKey=VariantName,ParameterValue=${variant}`,
		`ParameterKey=GoogleClientId,ParameterValue=${GOOGLE_ID}`,
		`ParameterKey=GoogleClientSecret,ParameterValue=${GOOGLE_SECRET}`,
		`ParameterKey=AuthDomainPrefix,ParameterValue=sessold${crypto.randomBytes(4).toString('hex')}`]);
	aws(['cloudformation', 'wait', 'stack-create-complete', '--stack-name', state.oldPoolStack], { json: false });
	fs.unlinkSync(tplPath);
	const old = stackOutputs(state.oldPoolStack);
	const oldClient0 = describeClient(old.UserPoolId, old.UserPoolClientId);
	step('Old pool deployed without SessionHours', stackParam(state.oldPoolStack, 'SessionHours') === undefined,
		`id token ${JSON.stringify(idTokenLifetime(oldClient0))}`);

	await putProfile(ctx, {
		id: LIVE_PROFILE, name: 'Sess Live', publishMechanism: 'AWS', awsSettings: awsSettings(),
		infrastructureState: {
			status: 'deployed', useRoute53: false, region: REGION, variantName: variant, originAccessMethod: 'oac',
			readGateMode: 'none',
			cognitoAuth: {
				stackName: state.oldPoolStack, enabled: true, commentIdentity: true,
				userPoolId: old.UserPoolId, userPoolClientId: old.UserPoolClientId, hostedUiDomain: old.HostedUiDomain,
				jwksUri: old.JwksUri, issuer: old.Issuer, edgeFunctionVersionArn: '', callbackApiDomain: old.CallbackApiDomain,
			},
		},
	});
	const up = await page.evaluate(async ({ pluginId, id }) => {
		const plugin = (window as any).app.plugins.plugins[pluginId];
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === id);
		try {
			await plugin.cloudFormationManager.upgradeCognitoGate(profile, () => {});
			return { cognito: profile.infrastructureState.cognitoAuth };
		} catch (e) {
			return { error: String(e) };
		}
	}, { pluginId: PLUGIN_ID, id: LIVE_PROFILE }) as any;
	if (up.error) { ctx.fail('Upgrade Cognito gate', up.error); return; }
	const oldClient1 = describeClient(old.UserPoolId, old.UserPoolClientId);
	step('Upgrade: SessionHours passed explicitly as 1', stackParam(state.oldPoolStack, 'SessionHours') === '1',
		String(stackParam(state.oldPoolStack, 'SessionHours')));
	step('Upgrade: app client keeps 1-hour ID tokens', oldClient1.IdTokenValidity === 1 && oldClient1.TokenValidityUnits?.IdToken === 'hours',
		JSON.stringify(idTokenLifetime(oldClient1)));
	step('Upgrade: profile records sessionHours: 1', up.cognito.sessionHours === 1, JSON.stringify(up.cognito.sessionHours));
	const saved1 = JSON.parse(fs.readFileSync(DATA_JSON, 'utf8')).publishingProfiles.find((p: any) => p.id === LIVE_PROFILE);
	step('Upgrade: sessionHours: 1 saved to data.json', saved1?.infrastructureState?.cognitoAuth?.sessionHours === 1,
		JSON.stringify(saved1?.infrastructureState?.cognitoAuth?.sessionHours));

	// Point the callback at the deployed API Gateway route (the plugin's own
	// callback-URL sync), so the Hosted UI can hand its code to the callback.
	const redirectOld = `https://${old.CallbackApiDomain}/auth/callback`;
	const sync = await page.evaluate(async ({ pluginId, id, stack, url }) => {
		const plugin = (window as any).app.plugins.plugins[pluginId];
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === id);
		const cfm = plugin.cloudFormationManager;
		await cfm.updateCognitoCallbackUrl(stack, url, profile);
		return cfm.pollStackUntilComplete(stack, profile, () => {}, 'us-east-1');
	}, { pluginId: PLUGIN_ID, id: LIVE_PROFILE, stack: state.oldPoolStack, url: redirectOld });
	step('Callback URL sync keeps SessionHours=1', sync === 'UPDATE_COMPLETE' && stackParam(state.oldPoolStack, 'SessionHours') === '1',
		`${sync}, SessionHours=${stackParam(state.oldPoolStack, 'SessionHours')}`);

	enableNativeSignIn(old.UserPoolId, old.UserPoolClientId);
	ensureUser(old.UserPoolId, 'reader@example.com');
	const s1 = await signInThroughCallback(old.HostedUiDomain, old.UserPoolClientId, redirectOld, 'reader@example.com');
	step('Sign-in after upgrade: cpn_id Max-Age ≈ 3600', about(s1.maxAge, 3600), s1.error ?? `Max-Age=${s1.maxAge}; ${s1.cookie}`);
	step('Sign-in after upgrade: token exp ≈ 1 h out', about(s1.tokenLifetime, 3600), `exp − iat = ${s1.tokenLifetime}`);

	// --- 2. Apply 12 h through the settings row ----------------------------------
	console.log('\n[2] Apply 12 h in Settings → Infrastructure → Sign-in session length');
	const idpBefore = aws(['cognito-idp', 'describe-identity-provider', '--user-pool-id', old.UserPoolId, '--provider-name', 'Google']).IdentityProvider;
	const ui = await page.evaluate(async ({ pluginId, id }) => {
		const plugin = (window as any).app.plugins.plugins[pluginId];
		plugin.openProfileSettings(id);
		// Settings opens on the CPN tab root; step into the profile's page.
		const profileName = plugin.settings.publishingProfiles.find((p: any) => p.id === id)?.name;
		for (let i = 0; i < 20; i++) {
			const nav = Array.from(document.querySelectorAll('.modal.mod-settings .setting-item.mod-navigable'))
				.find((r) => r.querySelector('.setting-item-name')?.textContent?.trim() === profileName) as HTMLElement | undefined;
			if (nav) { nav.click(); break; }
			await new Promise(r => setTimeout(r, 250));
		}
		// No named function expressions in page.evaluate: tsx wraps them in a
		// `__name` helper the page doesn't have.
		let row: Element | undefined;
		for (let i = 0; i < 40 && !row; i++) {
			// Sections are <details>; the Infrastructure one may start collapsed.
			for (const d of Array.from(document.querySelectorAll('.modal.mod-settings details.cpn-settings-section'))) (d as HTMLDetailsElement).open = true;
			row = Array.from(document.querySelectorAll('.modal.mod-settings .setting-item'))
				.find((s) => s.querySelector('.setting-item-name')?.textContent === 'Sign-in session length');
			if (!row) await new Promise(r => setTimeout(r, 250));
		}
		if (!row) return { error: 'session length row not found' };
		const desc = row.querySelector('.setting-item-description')?.textContent ?? '';
		const input = row.querySelector('input') as HTMLInputElement;
		const button = row.querySelector('button') as HTMLButtonElement;
		const before = { desc, value: input.value, disabled: button.disabled };
		input.value = '12';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		button.click();
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === id);
		for (let i = 0; i < 600; i++) {
			if (profile.infrastructureState.cognitoAuth.sessionHours === 12) break;
			if (Array.from(document.querySelectorAll('.notice')).some((n) => (n.textContent ?? '').includes('Session length change failed'))) break;
			await new Promise(r => setTimeout(r, 1000));
		}
		const notices = Array.from(document.querySelectorAll('.notice')).map((n) => n.textContent ?? '');
		(window as any).app.setting.close();
		return { before, sessionHours: profile.infrastructureState.cognitoAuth.sessionHours, notices };
	}, { pluginId: PLUGIN_ID, id: LIVE_PROFILE }) as any;
	if (ui.error) { ctx.fail('Apply row', ui.error); return; }
	// The upgrade in [1] already recorded sessionHours: 1, so the row reports it
	// as the current length (the "Cognito's default" wording is for pools with
	// nothing recorded).
	step('Apply row: enabled, shows the current 1 h', ui.before.value === '1' && !ui.before.disabled
		&& ui.before.desc.startsWith('Currently 1 hour.'), JSON.stringify(ui.before));
	step('Apply: profile records 12', ui.sessionHours === 12, `${ui.sessionHours}; notices: ${JSON.stringify(ui.notices)}`);
	const oldClient2 = describeClient(old.UserPoolId, old.UserPoolClientId);
	step('Apply: stack SessionHours=12', stackParam(state.oldPoolStack, 'SessionHours') === '12', String(stackParam(state.oldPoolStack, 'SessionHours')));
	step('Apply: app client issues 12-hour ID tokens', oldClient2.IdTokenValidity === 12 && oldClient2.TokenValidityUnits?.IdToken === 'hours',
		JSON.stringify(idTokenLifetime(oldClient2)));
	step('Apply: callback URL kept', stackParam(state.oldPoolStack, 'CallbackURL') === redirectOld, String(stackParam(state.oldPoolStack, 'CallbackURL')));
	const idpAfter = aws(['cognito-idp', 'describe-identity-provider', '--user-pool-id', old.UserPoolId, '--provider-name', 'Google']).IdentityProvider;
	step('Apply: Google IdP keeps its client id and secret', idpAfter.ProviderDetails.client_id === GOOGLE_ID
		&& idpAfter.ProviderDetails.client_secret === idpBefore.ProviderDetails.client_secret
		&& idpAfter.ProviderDetails.client_secret === GOOGLE_SECRET, `client_id=${idpAfter.ProviderDetails.client_id}`);
	const google = await fetch(`${old.HostedUiDomain}/oauth2/authorize?${new URLSearchParams({
		response_type: 'code', client_id: old.UserPoolClientId, redirect_uri: redirectOld, scope: 'openid email profile', identity_provider: 'Google',
	})}`, { redirect: 'manual' });
	const googleLoc = google.headers.get('location') ?? '';
	step('Apply: Hosted UI still hands Google sign-in to Google', google.status === 302
		&& googleLoc.startsWith('https://accounts.google.com/') && googleLoc.includes(`client_id=${GOOGLE_ID}`), `${google.status} ${googleLoc.slice(0, 90)}`);

	// The stack update rewrote the app client; re-enable native sign-in.
	enableNativeSignIn(old.UserPoolId, old.UserPoolClientId);
	const s2 = await signInThroughCallback(old.HostedUiDomain, old.UserPoolClientId, redirectOld, 'reader@example.com');
	step('Sign-in after Apply: cpn_id Max-Age ≈ 43200', about(s2.maxAge, 43200), s2.error ?? `Max-Age=${s2.maxAge}`);
	step('Sign-in after Apply: token exp ≈ 12 h out', about(s2.tokenLifetime, 43200), `exp − iat = ${s2.tokenLifetime}`);

	// --- 3. New pool with the wizard's defaults ------------------------------------
	console.log('\n[3] New pool with the wizard defaults');
	const variant2 = `${variant}n`;
	await putProfile(ctx, {
		id: NEW_PROFILE, name: 'Sess New', publishMechanism: 'AWS', awsSettings: awsSettings(),
		readGate: { mode: 'cognito' },
	});
	const wizard = await page.evaluate(async ({ pluginId, id }) => {
		const plugin = (window as any).app.plugins.plugins[pluginId];
		plugin.openProfileSettings(id);
		// Settings opens on the CPN tab root; step into the profile's page.
		const profileName = plugin.settings.publishingProfiles.find((p: any) => p.id === id)?.name;
		for (let i = 0; i < 20; i++) {
			const nav = Array.from(document.querySelectorAll('.modal.mod-settings .setting-item.mod-navigable'))
				.find((r) => r.querySelector('.setting-item-name')?.textContent?.trim() === profileName) as HTMLElement | undefined;
			if (nav) { nav.click(); break; }
			await new Promise(r => setTimeout(r, 250));
		}
		let btn: HTMLButtonElement | undefined;
		for (let i = 0; i < 40 && !btn; i++) {
			for (const d of Array.from(document.querySelectorAll('.modal.mod-settings details.cpn-settings-section'))) (d as HTMLDetailsElement).open = true;
			btn = Array.from(document.querySelectorAll('.modal.mod-settings button'))
				.find((b) => b.textContent?.trim() === 'Deploy Infrastructure') as HTMLButtonElement | undefined;
			if (!btn) await new Promise(r => setTimeout(r, 250));
		}
		if (!btn) return { error: 'Deploy Infrastructure button not found' };
		btn.click();
		let value: string | null = null;
		for (let i = 0; i < 40 && value === null; i++) {
			await new Promise(r => setTimeout(r, 250));
			const row = Array.from(document.querySelectorAll('.cpn-wizard-modal .setting-item'))
				.find((s) => s.querySelector('.setting-item-name')?.textContent === 'Sign-in session length (hours)');
			value = (row?.querySelector('input') as HTMLInputElement | null)?.value ?? null;
		}
		(document.querySelector('.cpn-wizard-modal .modal-close-button') as HTMLElement | null)?.click();
		(window as any).app.setting.close();
		return { value };
	}, { pluginId: PLUGIN_ID, id: NEW_PROFILE }) as any;
	if (wizard.error) { ctx.fail('Wizard default', wizard.error); return; }
	step('Wizard: session length field defaults to 12 for a new pool', wizard.value === '12', String(wizard.value));

	state.newPoolStack = `cpn-cognito-${variant2}`;
	saveState(state);
	const created = await page.evaluate(async ({ pluginId, id, variant2, hours, googleId, googleSecret, prefix }) => {
		const plugin = (window as any).app.plugins.plugins[pluginId];
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === id);
		const cfm = plugin.cloudFormationManager;
		const config: any = {
			profileId: id, variantName: variant2, awsProfile: profile.awsSettings.awsProfile, region: 'us-east-1', s3Prefix: '',
			customDomain: '', useRoute53: false, hostedZoneId: '', hostedZoneName: '', originAccessMethod: 'oac',
			readGateMode: 'cognito', googleClientId: googleId, googleClientSecret: googleSecret, authDomainPrefix: prefix,
			sessionHours: hours,
		};
		try {
			// As renderStep4DeployCognito does: assets, create, poll, outputs.
			await cfm.prepareCognitoAssets(config, profile, () => {});
			const stack = await cfm.deployCognitoAuthStack(config);
			const s1 = await cfm.pollStackUntilComplete(stack, profile, () => {}, 'us-east-1');
			const out = await cfm.getCognitoAuthOutputs(stack, profile);
			// Phase 2 runs before the profile records the pool.
			const recorded = profile.infrastructureState?.cognitoAuth?.sessionHours;
			await cfm.updateCognitoAuthStack({ ...config, callbackUrl: `https://${out.callbackApiDomain}/auth/callback` });
			const s2 = await cfm.pollStackUntilComplete(stack, profile, () => {}, 'us-east-1');
			return { stack, s1, s2, recorded, out };
		} catch (e) {
			return { error: String(e) };
		}
	}, {
		pluginId: PLUGIN_ID, id: NEW_PROFILE, variant2, hours: Number(wizard.value),
		googleId: GOOGLE_ID, googleSecret: GOOGLE_SECRET, prefix: `sessnew${crypto.randomBytes(4).toString('hex')}`,
	}) as any;
	if (created.error) { ctx.fail('New pool deploy', created.error); return; }
	step('New pool: created and phase-2 updated', created.s1 === 'CREATE_COMPLETE' && created.s2 === 'UPDATE_COMPLETE',
		`${created.s1} → ${created.s2}; recorded before phase 2: ${created.recorded}`);
	step('New pool: SessionHours=12 after phase 2', stackParam(state.newPoolStack, 'SessionHours') === '12', String(stackParam(state.newPoolStack, 'SessionHours')));
	const fresh = stackOutputs(state.newPoolStack);
	const freshClient = describeClient(fresh.UserPoolId, fresh.UserPoolClientId);
	step('New pool: app client issues 12-hour ID tokens', freshClient.IdTokenValidity === 12 && freshClient.TokenValidityUnits?.IdToken === 'hours',
		JSON.stringify(idTokenLifetime(freshClient)));
	enableNativeSignIn(fresh.UserPoolId, fresh.UserPoolClientId);
	ensureUser(fresh.UserPoolId, 'reader@example.com');
	const s3 = await signInThroughCallback(fresh.HostedUiDomain, fresh.UserPoolClientId, `https://${fresh.CallbackApiDomain}/auth/callback`, 'reader@example.com');
	step('New pool sign-in: cpn_id Max-Age ≈ 43200', about(s3.maxAge, 43200), s3.error ?? `Max-Age=${s3.maxAge}`);

	// --- 4. Publish to a throwaway bucket -----------------------------------------
	console.log('\n[4] Publish raw-scrub and exclusion fixtures');
	state.pubBucket = `cpn-sess-e2e-${variant}-${accountId}`;
	saveState(state);
	aws(['s3api', 'create-bucket', '--bucket', state.pubBucket], { json: false });
	await putProfile(ctx, {
		id: PUB_PROFILE, name: 'Sess Pub', publishMechanism: 'AWS', awsSettings: awsSettings(state.pubBucket),
		baseUrl: 'https://sess-e2e.invalid', isPublic: true, publishContentIndex: false,
		excludedDirectories: ['**/private/'], obscureRawWikilinks: true, obscureRawAttachments: true,
	});
	const pub = await page.evaluate(async ({ pluginId, id, notes }) => {
		const app = (window as any).app;
		const plugin = app.plugins.plugins[pluginId];
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === id);
		const files = await plugin.publisher.getAllPublishableNotes(id);
		const ours = files.filter((f: any) => notes.includes(f.path));
		await plugin.publisher.publishNotes(ours, profile, false, false);
		const history = JSON.parse(await app.vault.adapter.read(plugin.profileManager.getPublishHistoryPath(id)));
		const uids: Record<string, string> = {};
		for (const p of notes) uids[p] = plugin.frontmatterManager.peekNoteUID(app.vault.getAbstractFileByPath(p));
		return { publishable: ours.map((f: any) => f.path), history, uids };
	}, { pluginId: PLUGIN_ID, id: PUB_PROFILE, notes: Object.keys(NOTES) }) as any;
	const hashOf = (p: string): string | undefined => (pub.history[pub.uids[p]] || []).slice(-1)[0];
	step('Exclusion: Sess-Projects/private/ not publishable, public/ is',
		!pub.publishable.includes('Sess-Projects/private/Hidden.md') && pub.publishable.includes('Sess-Projects/public/Shown.md'),
		JSON.stringify(pub.publishable));
	const keys: string[] = (aws(['s3api', 'list-objects-v2', '--bucket', state.pubBucket, '--prefix', 'notes/']).Contents || []).map((o: any) => o.Key);
	const shownHash = hashOf('Sess-Projects/public/Shown.md');
	const hiddenUid = pub.uids['Sess-Projects/private/Hidden.md'];
	step('Exclusion: public note reached S3, private note has no publish history',
		!!shownHash && keys.includes(`notes/${shownHash}.json`) && !(hiddenUid && pub.history[hiddenUid]),
		`shown=${shownHash}, hidden uid=${hiddenUid}, ${keys.length} note objects`);

	const rawHash = hashOf('Sess Raw.md');
	if (!rawHash) { ctx.fail('Raw note published', JSON.stringify(pub.history)); return; }
	const tmp = path.join(os.tmpdir(), `sess-raw-${variant}.json`);
	aws(['s3api', 'get-object', '--bucket', state.pubBucket, '--key', `notes/${rawHash}.json`, tmp]);
	const noteJson = JSON.parse(fs.readFileSync(tmp, 'utf8'));
	fs.unlinkSync(tmp);
	const raw: string = noteJson.raw;
	const source = NOTES['Sess Raw.md'];
	const target = pub.uids['Sess Target.md'];
	step('Raw: text and structure outside links match the source', outsideLinks(raw) === outsideLinks(source), JSON.stringify(raw));
	step('Raw: table keeps its columns', tableShape(raw) === tableShape(source) && tableShape(raw) === '2,2', `${tableShape(source)} → ${tableShape(raw)}`);
	step('Raw: escaped line rewritten in place', raw.includes(`Escaped: a \\* [[${target}|Sess Target]] b`), raw.split('\n')[0]);
	step('Raw: table link keeps an escaped separator', raw.includes(`| [[${target}\\|alias]] | x |`), raw.split('\n')[4] ?? '');
	step('Raw: attachment embed obscured', raw.includes('Media: ![[null.mp3]]') && !raw.includes('Sess-Media'), raw.split('\n')[6] ?? '');
	const rows = (noteJson.content.match(/<tr[\s>][\s\S]*?<\/tr>/g) || []).map((r: string) => (r.match(/<t[dh][\s>]/g) || []).length);
	step('HTML: rendered table has 2 columns per row', rows.length === 2 && rows.every((n: number) => n === 2), JSON.stringify(rows));
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
	runTest({
		name: 'session-length-live',
		launchTimeout: 60_000,
		cleanupFiles: FIXTURE_ROOTS,
		setupVault: (vaultPath) => {
			const fm = (ctxs: string[]) => `---\ncpn-publish-contexts:\n${ctxs.map(c => `  - ${c}`).join('\n')}\n---\n`;
			for (const [p, body] of Object.entries(NOTES)) {
				fs.mkdirSync(path.join(vaultPath, path.dirname(p)), { recursive: true });
				fs.writeFileSync(path.join(vaultPath, p), fm([PUB_PROFILE]) + body);
			}
			fs.mkdirSync(path.join(vaultPath, 'Sess-Media'), { recursive: true });
			fs.writeFileSync(path.join(vaultPath, 'Sess-Media/song.mp3'), Buffer.from([0x49, 0x44, 0x33, 0x04]));
		},
	}, async (ctx) => {
		await ctx.page.waitForTimeout(5_000);
		try {
			await live(ctx);
		} catch (err) {
			ctx.fail('Live run', `aborted: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			await ctx.page.evaluate(async ({ pluginId, snap }) => {
				(window as any).app.setting?.close?.();
				const plugin = (window as any).app.plugins.plugins[pluginId];
				plugin.settings = JSON.parse(snap);
				await plugin.saveSettings();
			}, { pluginId: PLUGIN_ID, snap: snapshot }).catch(() => {});
			fs.writeFileSync(DATA_JSON, snapshot);
			console.log(`\n  Live resources recorded in ${STATE_PATH}; run with --teardown to remove them.`);
		}
	});
}
