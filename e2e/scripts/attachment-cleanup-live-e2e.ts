#!/usr/bin/env npx tsx
/**
 * Attachment cleanup (phase 3) — LIVE AWS end-to-end test (opt-in, creates real resources)
 *
 * The sandbox checks from specs/attachment-publishing/phase-3-cleanup.md §6
 * ("End-to-end"), driven through a running Obsidian and the plugin's own
 * CloudFormationManager.
 *
 * Deploys one site the way the wizard does: a Cognito pool, the site stack, the
 * Cognito edge function in public-reads mode (per-note access group g1), the
 * comment backend and the chat backend (both attached with targeted
 * full-stack updates), so the bucket cleanup rule's Apply can be checked
 * against every route.
 *
 * Scenarios:
 *   0. A new site gets both lifecycle rules (noncurrent versions expire after
 *      30 days, abandoned multipart uploads after 7).
 *   1. Gate a note that embeds an mp3 to g1 and publish: the file is under
 *      restricted/g1/attachments/, the public copy is gone, an anonymous fetch
 *      of the old public URL (cached beforehand) returns 403, a g1 member gets
 *      the gated copy.
 *   2. A public and a gated note share a file: it exists in both areas.
 *      Deleting the public note (delete picker internals) removes only the
 *      public copy; ungating the gated note removes only the g1 copy.
 *   3. attachments.json deleted, then a note with attachments gated: the probe
 *      finds attachment objects, the publish rebuilds the state from the bucket
 *      and sweeps the public copy; files other notes use survive.
 *   4. Audit published notes: an attachment deleted out of band is reported
 *      missing and cleared from `uploaded`, a stray object is reported
 *      unreferenced and deleted through the offer, and the next publish of the
 *      note re-uploads the missing file.
 *   5. Mode off: a public note's mp3 published, the mode switched off, the note
 *      gated and published: the public copy is swept and returns 403.
 *   6. A profile with publish history but no attachment objects (its own S3
 *      prefix): the first publish with attachments on creates attachments.json
 *      complete and never rebuilds.
 *   7. Bucket cleanup rule through Settings → Infrastructure: Apply 0 leaves
 *      only the abort rule, Apply 14 shows both rules; /auth/*, the comment
 *      routes and /api/chat answer exactly as before, the distribution's
 *      origins and behaviors and every other stack parameter are unchanged; an
 *      imported stack shows the CDK text without a button.
 *   8. No sweep reported "Couldn't check", and no plugin errors were logged.
 *
 * Usage (sandbox account only):
 *   CPN_LIVE_AWS_PROFILE=random npx tsx e2e/scripts/attachment-cleanup-live-e2e.ts
 *   CPN_LIVE_AWS_PROFILE=random npx tsx e2e/scripts/attachment-cleanup-live-e2e.ts --reuse
 *   CPN_LIVE_AWS_PROFILE=random npx tsx e2e/scripts/attachment-cleanup-live-e2e.ts --teardown
 *
 * --reuse runs the scenarios against the stacks a previous run deployed (from
 * the state file), after emptying the site bucket's published content.
 *
 * Resource names go to e2e/results/attachment-cleanup-live-state.json.
 * Lambda@Edge replicas take CloudFront hours to release: teardown reports
 * functions it couldn't delete yet; re-run --teardown later. The shared
 * cpn-bootstrap stack is removed only if this run created it. The test vault's
 * plugin data.json is snapshotted and restored.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { runTest, type TestContext } from '../lib/test-harness';
import { VAULT_PATH, RESULTS_DIR, PLUGIN_ID } from '../lib/test-helpers';
import {
	LIVE_AWS_PROFILE as AWS_PROFILE,
	LIVE_REGION as REGION,
	aws,
	deleteStack,
	deleteVariantFunctionsAndRoles,
	emptyVersionedBucket,
	enableNativeSignIn,
	ensureUser,
	head,
	idToken,
	mp3,
	newUid,
	png,
	s3Keys,
	sha256File,
	sleep,
	stackOutputs,
	stackParams,
	waitInvalidations,
} from '../lib/live-aws';

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const STATE_PATH = path.join(RESULTS_DIR, 'attachment-cleanup-live-state.json');
const PLUGIN_DIR = path.join(VAULT_PATH, '.obsidian', 'plugins', PLUGIN_ID);
const DATA_JSON = path.join(PLUGIN_DIR, 'data.json');
const PP = 'cln-pub';
const PQ = 'cln-fresh';
const PQ_PREFIX = 'fresh/';
const G1 = 'g1';
const G1_READER = 'cln-g1reader@example.com';
const DEFAULT_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'mp4', 'm4v', 'webm', 'mov', 'pdf'];
const FIXTURE_ROOTS = ['Cln-Notes', 'Cln-Media'];

interface LiveState {
	variant: string;
	accountId?: string;
	bootstrapPreexisting?: boolean;
	poolStack?: string;
	full?: string;
	edge?: string;
	comment?: string;
	commentBucket?: string;
	chat?: string;
	bucket?: string;
	dist?: string;
	domain?: string;
}

interface NoteDef { contexts: string[]; groups: string[]; body: string; uid: string }

/** Notes present at launch (vault-relative path → definition). UIDs are pre-minted. */
const NOTES: Record<string, NoteDef> = {
	'Cln-Notes/Cln Gate.md': { contexts: [PP], groups: [], body: '![[Cln-Media/gate.mp3]]\n', uid: newUid() },
	'Cln-Notes/Cln Keep.md': { contexts: [PP], groups: [], body: '![[Cln-Media/keep.png]]\n', uid: newUid() },
	'Cln-Notes/Cln Share Pub.md': { contexts: [PP], groups: [], body: '![[Cln-Media/shared.mp3]]\n', uid: newUid() },
	'Cln-Notes/Cln Share Gated.md': { contexts: [PP], groups: [G1], body: 'Gated.\n\n![[Cln-Media/shared.mp3]]\n', uid: newUid() },
	'Cln-Notes/Cln Rebuild.md': { contexts: [PP], groups: [], body: '![[Cln-Media/rebuild.mp3]]\n', uid: newUid() },
	'Cln-Notes/Cln Audit.md': { contexts: [PP], groups: [], body: '![[Cln-Media/audit.mp3]]\n', uid: newUid() },
	'Cln-Notes/Cln Off.md': { contexts: [PP], groups: [], body: '![[Cln-Media/off.mp3]]\n', uid: newUid() },
	'Cln-Notes/Cln Fresh Plain.md': { contexts: [PQ], groups: [], body: 'No files here.\n', uid: newUid() },
	'Cln-Notes/Cln Fresh Media.md': { contexts: [PQ], groups: [], body: '![[Cln-Media/fresh.mp3]]\n', uid: newUid() },
};
const N = (name: string) => `Cln-Notes/${name}.md`;

function noteText(def: NoteDef, groups: string[]): string {
	return `---\ncpn-uid: ${def.uid}\ncpn-publish-contexts:\n${def.contexts.map(c => `  - ${c}`).join('\n')}\n`
		+ (groups.length ? `cpn-access-groups:\n${groups.map(g => `  - ${g}`).join('\n')}\n` : '') + '---\n' + def.body;
}

function setupVault(vaultPath: string): void {
	const at = (p: string) => {
		const full = path.join(vaultPath, p);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		return full;
	};
	for (const [p, def] of Object.entries(NOTES)) fs.writeFileSync(at(p), noteText(def, def.groups));
	const tones: Record<string, number> = { gate: 410, shared: 520, rebuild: 630, audit: 740, off: 850, fresh: 960 };
	for (const [name, freq] of Object.entries(tones)) mp3(at(`Cln-Media/${name}.mp3`), freq, 2, `Cln ${name}`);
	png(at('Cln-Media/keep.png'), 'teal');
}

const media = (file: string) => path.join(VAULT_PATH, 'Cln-Media', file);
const keyOf = (file: string) => `${sha256File(media(file))}/${file}`;

// ---------------------------------------------------------------------------
// Obsidian-side helpers (installed once as window.__cln)
// ---------------------------------------------------------------------------

/** String-evaluated (no tsx transform), so it can define functions freely. */
const INSTALL = `
window.__name = (f) => f;
window.__cln = {
	plugin() { return app.plugins.plugins['${PLUGIN_ID}']; },
	profile(id) { return this.plugin().settings.publishingProfiles.find((p) => p.id === id); },
	file(p) { return app.vault.getAbstractFileByPath(p); },
	notices: [],
	async publish(paths, id) {
		const files = paths.map((p) => this.file(p));
		if (files.some((f) => !f)) throw new Error('missing file in ' + JSON.stringify(paths));
		await this.plugin().publisher.publishNotes(files, this.profile(id), false, true);
	},
	async history(id) {
		const pl = this.plugin();
		const p = pl.profileManager.getPublishHistoryPath(id);
		return (await app.vault.adapter.exists(p)) ? JSON.parse(await app.vault.adapter.read(p)) : {};
	},
	uid(p) { return this.plugin().frontmatterManager.peekNoteUID(this.file(p)); },
	async latest(id, p) {
		const h = await this.history(id);
		const list = h[this.uid(p)] || [];
		return list[list.length - 1] || null;
	},
	groupsOf(p) {
		const f = this.file(p);
		const fm = f && app.metadataCache.getFileCache(f) && app.metadataCache.getFileCache(f).frontmatter;
		return (fm && fm['cpn-access-groups']) || [];
	},
	async waitIndexed(paths) {
		for (let i = 0; i < 100; i++) {
			const ok = paths.every((p) => { const f = this.file(p); return f && app.metadataCache.getFileCache(f); });
			if (ok) return true;
			await new Promise((r) => setTimeout(r, 200));
		}
		return false;
	},
};
(() => {
	const seen = new WeakMap();
	const rec = () => {
		for (const n of document.querySelectorAll('.notice')) {
			const t = (n.textContent || '').trim();
			let texts = seen.get(n);
			if (!texts) { texts = new Set(); seen.set(n, texts); }
			if (t && !texts.has(t)) { texts.add(t); window.__cln.notices.push(t); }
		}
	};
	new MutationObserver(rec).observe(document.body, { childList: true, subtree: true, characterData: true });
})();
`;

type Step = (name: string, cond: boolean, detail: string) => void;

async function noticeMark(ctx: TestContext): Promise<number> {
	return ctx.page.evaluate(() => (window as any).__cln.notices.length);
}
async function noticesSince(ctx: TestContext, mark: number): Promise<string[]> {
	return ctx.page.evaluate((m) => (window as any).__cln.notices.slice(m), mark);
}
async function publish(ctx: TestContext, paths: string[], id = PP): Promise<string[]> {
	const mark = await noticeMark(ctx);
	await ctx.page.evaluate(({ paths, id }) => (window as any).__cln.publish(paths, id), { paths, id });
	return noticesSince(ctx, mark);
}
const published = (notices: string[], n: number) => notices.some(t => t.includes(`Successfully published ${n} note(s)`));
async function latest(ctx: TestContext, p: string, id = PP): Promise<string | null> {
	return ctx.page.evaluate(({ id, p }) => (window as any).__cln.latest(id, p), { id, p });
}
async function uidOf(ctx: TestContext, p: string): Promise<string> {
	return ctx.page.evaluate((p) => (window as any).__cln.uid(p), p);
}
async function patchAttachments(ctx: TestContext, id: string, patch: Record<string, unknown>): Promise<void> {
	await ctx.page.evaluate(async ({ id, patch }) => {
		const c = (window as any).__cln;
		const p = c.profile(id);
		p.attachments = { ...p.attachments, ...patch };
		await c.plugin().saveSettings();
	}, { id, patch });
}
async function profileDirAbs(ctx: TestContext, id: string): Promise<string> {
	const rel = await ctx.page.evaluate((id) => (window as any).__cln.plugin().profileManager.getProfileDir(id), id);
	return path.join(VAULT_PATH, rel);
}
function readStateFile(dir: string): any | null {
	const p = path.join(dir, 'attachments.json');
	return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

/** Rewrite a note's access groups (keeping its UID) and wait for the metadata cache. */
async function setGroups(ctx: TestContext, p: string, groups: string[]): Promise<boolean> {
	fs.writeFileSync(path.join(VAULT_PATH, p), noteText(NOTES[p], groups));
	for (let i = 0; i < 100; i++) {
		const now = await ctx.page.evaluate((p) => (window as any).__cln.groupsOf(p), p);
		if (JSON.stringify(now) === JSON.stringify(groups)) return true;
		await sleep(200);
	}
	return false;
}

/** Anonymous (or cookie-authenticated) GET status through CloudFront. */
async function fetchStatus(url: string, token?: string): Promise<number> {
	const r = await fetch(url, { redirect: 'manual', headers: token ? { Cookie: `cpn_id=${token}` } : {} });
	await r.arrayBuffer().catch(() => undefined);
	return r.status;
}

// ---------------------------------------------------------------------------
// Profiles and deploy
// ---------------------------------------------------------------------------

interface Deployed { state: LiveState; pool: Record<string, string>; base: string }

const awsSettings = (bucketName: string, distributionId: string, accountId: string, s3Prefix = '') => ({
	awsProfile: AWS_PROFILE, region: REGION, bucketName, s3Prefix, awsAccountId: accountId,
	cloudFrontDistributionId: distributionId, cloudFrontInvalidationScheme: 'all', credentialMode: 'sdk',
	credentialRefreshCommands: '', awsCliPath: '',
});

/** Add (or replace) a profile in the running plugin's settings. */
async function putProfile(ctx: TestContext, profile: Record<string, unknown>): Promise<void> {
	await ctx.page.evaluate(async ({ pluginId, profile }) => {
		const plugin = (window as any).app.plugins.plugins[pluginId];
		const list = plugin.settings.publishingProfiles as any[];
		const base = list[0];
		const merged = {
			...base, chat: undefined, commenting: undefined, readGate: undefined, cognitoAuth: undefined,
			publicSiteAccessGroups: undefined, accessGroups: undefined, pendingEdgeCleanup: undefined,
			infrastructureState: undefined, homeNotePath: '', excludedDirsRulesVersion: 2,
			siteAssetsFingerprint: undefined, publishedHomeNoteUid: undefined, lastFullPublishTimestamp: 0, ...profile,
		};
		plugin.settings.publishingProfiles = [...list.filter((p) => p.id !== profile.id), merged];
		await plugin.saveSettings();
	}, { pluginId: PLUGIN_ID, profile });
}

const publicProfile = (state: LiveState) => ({
	id: PP, name: 'Cln Public', publishMechanism: 'AWS',
	awsSettings: awsSettings(state.bucket ?? '', state.dist ?? '', state.accountId ?? ''),
	baseUrl: state.domain ? `https://${state.domain}` : '', isPublic: true, publishContentIndex: false,
	excludedDirectories: [], obscureRawAttachments: true,
	attachments: { mode: 'embeds', allowedExtensions: [...DEFAULT_EXTS], maxFileSizeMB: 50 },
	accessGroups: { [G1]: { members: [G1_READER] } }, publicSiteAccessGroups: true,
});

/** The second profile: same bucket, its own prefix, no distribution, mode off. */
async function putFreshProfile(ctx: TestContext, state: LiveState): Promise<void> {
	await putProfile(ctx, {
		id: PQ, name: 'Cln Fresh', publishMechanism: 'AWS',
		awsSettings: awsSettings(state.bucket!, '', state.accountId!, PQ_PREFIX),
		baseUrl: 'https://cln-fresh.invalid', isPublic: true, publishContentIndex: false, excludedDirectories: [],
		attachments: { mode: 'off', allowedExtensions: [...DEFAULT_EXTS], maxFileSizeMB: 50 },
	});
}

function cognitoState(state: LiveState, po: Record<string, string>, edgeArn: string) {
	return {
		stackName: state.poolStack, enabled: true, commentIdentity: false, userPoolId: po.UserPoolId,
		userPoolClientId: po.UserPoolClientId, hostedUiDomain: po.HostedUiDomain, jwksUri: po.JwksUri, issuer: po.Issuer,
		callbackApiDomain: po.CallbackApiDomain, edgeStackName: state.edge, edgeFunctionVersionArn: edgeArn,
		accessGroupsBucket: po.AccessGroupsBucket, accessGroupsKey: po.AccessGroupsKey, edgePublicReads: true, sessionHours: 12,
	};
}

function saveState(s: LiveState): void {
	fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
	fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

/** Empty the site bucket's published content (everything but the chat handler zip). */
function resetBucket(bucket: string): void {
	const keys = s3Keys(bucket).filter(k => !k.startsWith('lambda/'));
	for (let i = 0; i < keys.length; i += 500) {
		aws(['s3api', 'delete-objects', '--bucket', bucket, '--delete',
			JSON.stringify({ Objects: keys.slice(i, i + 500).map(Key => ({ Key })), Quiet: true })], { allowFail: true });
	}
}

/** --reuse: rebuild the profiles from a previous run's stacks. */
async function reuse(ctx: TestContext, step: Step): Promise<Deployed | null> {
	if (!fs.existsSync(STATE_PATH)) { ctx.fail('Reuse', 'no state file'); return null; }
	const state: LiveState = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
	if (!state.poolStack || !state.full || !state.edge || !state.comment || !state.chat || !state.bucket) {
		ctx.fail('Reuse', 'state file is missing stacks'); return null;
	}
	resetBucket(state.bucket);
	const po = stackOutputs(state.poolStack);
	const edgeArn = stackOutputs(state.edge).EdgeFunctionVersionArn;
	await putProfile(ctx, {
		...publicProfile(state),
		infrastructureState: {
			status: 'deployed', fullStackName: state.full, useRoute53: false, region: REGION, variantName: state.variant,
			originAccessMethod: 'oac', readGateMode: 'none', authLambdaEdgeArn: edgeArn, cognitoAuth: cognitoState(state, po, edgeArn),
		},
	});
	await putFreshProfile(ctx, state);
	const ok = await ctx.page.evaluate(async (id) => {
		const c = (window as any).__cln;
		await c.plugin().syncAccessGroups(c.profile(id), { force: true });
		return !!c.profile(id).infrastructureState.authLambdaEdgeArn;
	}, PP);
	step('Reuse: profiles re-seeded from the deployed stacks, bucket emptied', ok, state.variant);
	enableNativeSignIn(po.UserPoolId, po.UserPoolClientId);
	ensureUser(po.UserPoolId, G1_READER);
	return { state, pool: po, base: `https://${state.domain}` };
}

async function deploy(ctx: TestContext, step: Step): Promise<Deployed | null> {
	const { page } = ctx;
	const accountId = aws<{ Account: string }>(['sts', 'get-caller-identity']).Account;
	const variant = `clne2e${crypto.randomBytes(3).toString('hex')}`;
	const state: LiveState = { variant, accountId };
	state.bootstrapPreexisting = !!aws(['cloudformation', 'describe-stacks', '--stack-name', 'cpn-bootstrap'], { allowFail: true });
	saveState(state);
	console.log(`  variant: ${variant} (account ${accountId}; cpn-bootstrap ${state.bootstrapPreexisting ? 'already exists' : 'will be created'})`);
	await putProfile(ctx, publicProfile(state));

	// --- Pool --------------------------------------------------------------
	console.log('\n[deploy] Cognito pool');
	state.poolStack = `cpn-cognito-${variant}`;
	saveState(state);
	const pool = await page.evaluate(async ({ id, variant, prefix }) => {
		const c = (window as any).__cln;
		const profile = c.profile(id);
		const cfm = c.plugin().cloudFormationManager;
		const config: any = {
			profileId: id, variantName: variant, awsProfile: profile.awsSettings.awsProfile, region: 'us-east-1', s3Prefix: '',
			customDomain: '', useRoute53: false, hostedZoneId: '', hostedZoneName: '', originAccessMethod: 'oac',
			readGateMode: 'none', googleClientId: 'cln-e2e-fake-client', googleClientSecret: 'cln-e2e-fake-secret',
			authDomainPrefix: prefix, sessionHours: 12,
		};
		try {
			await cfm.prepareCognitoAssets(config, profile, () => {});
			const stack = await cfm.deployCognitoAuthStack(config);
			return { stack, s: await cfm.pollStackUntilComplete(stack, profile, () => {}, 'us-east-1') };
		} catch (e) {
			return { error: String(e) };
		}
	}, { id: PP, variant, prefix: `clnpool${crypto.randomBytes(4).toString('hex')}` }) as any;
	if (pool.error || pool.s !== 'CREATE_COMPLETE') { ctx.fail('Deploy: Cognito pool', pool.error ?? pool.s); return null; }
	const po = stackOutputs(state.poolStack);
	step('Deploy: Cognito pool', !!po.UserPoolId, po.UserPoolId);

	// --- Site --------------------------------------------------------------
	console.log('\n[deploy] Site (public reads, access group g1)');
	const site = await page.evaluate(async ({ id, variant, callbackDomain }) => {
		const c = (window as any).__cln;
		const profile = c.profile(id);
		const cfm = c.plugin().cloudFormationManager;
		const config: any = {
			profileId: id, variantName: variant, s3Prefix: '', customDomain: '', useRoute53: false, hostedZoneId: '',
			hostedZoneName: '', region: 'us-east-1', awsProfile: profile.awsSettings.awsProfile, originAccessMethod: 'oac',
			authLambdaEdgeArn: '', callbackApiDomainName: callbackDomain,
		};
		try {
			const stack = await cfm.deployFullStack(config);
			const s = await cfm.pollStackUntilComplete(stack, profile, () => {}, 'us-east-1');
			if (s !== 'CREATE_COMPLETE') return { error: `full stack ${s}`, stack };
			return { stack, ...(await cfm.getStackOutputs(stack, profile, 'us-east-1')) };
		} catch (e) {
			return { error: String(e) };
		}
	}, { id: PP, variant, callbackDomain: po.CallbackApiDomain }) as any;
	if (site.stack) state.full = site.stack;
	state.bucket = site.bucketName;
	state.dist = site.distributionId;
	state.domain = site.distributionDomainName;
	saveState(state);
	if (site.error) { ctx.fail('Deploy: site', site.error); return null; }

	const up = await page.evaluate(async ({ id, poolStack, po, site, variant }) => {
		const c = (window as any).__cln;
		const profile = c.profile(id);
		profile.awsSettings.bucketName = site.bucketName;
		profile.awsSettings.cloudFrontDistributionId = site.distributionId;
		profile.baseUrl = `https://${site.distributionDomainName}`;
		profile.infrastructureState = {
			status: 'deployed', fullStackName: site.stack, useRoute53: false, region: 'us-east-1',
			variantName: variant, originAccessMethod: 'oac', readGateMode: 'none',
			cognitoAuth: {
				stackName: poolStack, enabled: true, commentIdentity: false, userPoolId: po.UserPoolId,
				userPoolClientId: po.UserPoolClientId, hostedUiDomain: po.HostedUiDomain, jwksUri: po.JwksUri,
				issuer: po.Issuer, edgeFunctionVersionArn: '', callbackApiDomain: po.CallbackApiDomain, sessionHours: 12,
			},
		};
		await c.plugin().saveSettings();
		try {
			await c.plugin().cloudFormationManager.upgradeCognitoGate(profile, () => {});
			await c.plugin().syncAccessGroups(profile, { force: true });
			return { edgeStack: profile.infrastructureState.cognitoAuth.edgeStackName, arn: profile.infrastructureState.authLambdaEdgeArn };
		} catch (e) {
			return { error: String(e), edgeStack: profile.infrastructureState?.cognitoAuth?.edgeStackName };
		}
	}, { id: PP, poolStack: state.poolStack, po, site, variant }) as any;
	if (up.edgeStack) state.edge = up.edgeStack;
	saveState(state);
	if (up.error) { ctx.fail('Deploy: edge function (upgradeCognitoGate)', up.error); return null; }
	step('Deploy: site with the public-reads edge function', !!up.arn, `${site.distributionDomainName} edge ${up.arn}`);

	// --- Comment backend ----------------------------------------------------
	console.log('\n[deploy] Comment backend');
	state.comment = `cpn-comment-${variant}`;
	saveState(state);
	const comment = await page.evaluate(async ({ id, variant, po, site }) => {
		const c = (window as any).__cln;
		const profile = c.profile(id);
		const cfm = c.plugin().cloudFormationManager;
		const config: any = {
			profileId: id, variantName: variant, s3Prefix: '', region: 'us-east-1', awsProfile: profile.awsSettings.awsProfile,
			originAccessMethod: 'oac', commentJwksUri: po.JwksUri, commentTokenIssuer: po.Issuer, commentUserPoolClientId: po.UserPoolClientId,
			siteDistributionId: site.distributionId, siteOriginAccessIdentityId: '',
		};
		try {
			const stack = await cfm.deployCommentStack(config);
			const s = await cfm.pollStackUntilComplete(stack, profile, () => {}, 'us-east-1');
			if (s !== 'CREATE_COMPLETE') return { error: `comment stack ${s}`, stack };
			const out = await cfm.getCommentStackOutputs(stack, profile, 'us-east-1');
			const full = await cfm.updateFullStackOrigins(config, { CommentBucketDomainName: out.bucketDomainName, CommentApiDomainName: out.apiDomain });
			const fs2 = await cfm.pollStackUntilComplete(full, profile, () => {}, 'us-east-1');
			return { stack, out, fs2 };
		} catch (e) {
			return { error: String(e) };
		}
	}, { id: PP, variant, po, site }) as any;
	if (comment.out?.bucketName) state.commentBucket = comment.out.bucketName;
	saveState(state);
	if (comment.error) { ctx.fail('Deploy: comment backend', comment.error); return null; }
	step('Deploy: comment backend attached', comment.fs2 === 'UPDATE_COMPLETE', `${comment.out.apiDomain}; full stack ${comment.fs2}`);

	// --- Chat backend -----------------------------------------------------------
	console.log('\n[deploy] Chat backend');
	state.chat = `cpn-chat-${variant}`;
	saveState(state);
	const chat = await page.evaluate(async ({ id, variant, site }) => {
		const c = (window as any).__cln;
		const profile = c.profile(id);
		const cfm = c.plugin().cloudFormationManager;
		const config: any = {
			profileId: id, variantName: variant, s3Prefix: '', region: 'us-east-1', awsProfile: profile.awsSettings.awsProfile,
			originAccessMethod: 'oac', chatEnabled: true,
		};
		try {
			const stack = await cfm.deployChatStack(config, profile, site.bucketName, site.distributionId);
			const s = await cfm.pollStackUntilComplete(stack, profile, () => {}, 'us-east-1');
			if (s !== 'CREATE_COMPLETE') return { error: `chat stack ${s}`, stack };
			const out = await cfm.getChatStackOutputs(stack, profile, 'us-east-1');
			await cfm.updateChatStackWithKbId(config, profile, site.bucketName, out.knowledgeBaseId);
			const s2 = await cfm.pollStackUntilComplete(stack, profile, () => {}, 'us-east-1');
			const full = await cfm.updateFullStackOrigins(config, { ChatFunctionUrlDomainName: out.functionUrlDomainName });
			const fs2 = await cfm.pollStackUntilComplete(full, profile, () => {}, 'us-east-1');
			return { stack, out, s2, fs2 };
		} catch (e) {
			return { error: String(e) };
		}
	}, { id: PP, variant, site }) as any;
	if (chat.error) { ctx.fail('Deploy: chat backend', chat.error); return null; }
	step('Deploy: chat backend attached', chat.fs2 === 'UPDATE_COMPLETE', `${chat.out.functionUrlDomainName}; chat ${chat.s2}; full stack ${chat.fs2}`);

	await putFreshProfile(ctx, state);
	enableNativeSignIn(po.UserPoolId, po.UserPoolClientId);
	ensureUser(po.UserPoolId, G1_READER);
	return { state, pool: po, base: `https://${state.domain}` };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

function lifecycleRules(bucket: string): any[] | null {
	return aws<{ Rules?: any[] } | null>(['s3api', 'get-bucket-lifecycle-configuration', '--bucket', bucket], { allowFail: true })?.Rules ?? null;
}

function describeRules(rules: any[] | null): string {
	return JSON.stringify((rules ?? []).map(r => ({ id: r.ID, status: r.Status, nc: r.NoncurrentVersionExpiration?.NoncurrentDays, abort: r.AbortIncompleteMultipartUpload?.DaysAfterInitiation })));
}

/** 0. A new site has both rules. */
async function scenarioNewSiteRules(ctx: TestContext, d: Deployed, step: Step): Promise<void> {
	console.log('\n[0] New site lifecycle rules');
	const rules = lifecycleRules(d.state.bucket!);
	const nc = rules?.find(r => r.ID === 'ExpireNoncurrentVersions');
	const ab = rules?.find(r => r.ID === 'AbortIncompleteMultipartUploads');
	step('New site: noncurrent versions expire after 30 days, abandoned uploads after 7', rules?.length === 2
		&& nc?.Status === 'Enabled' && nc.NoncurrentVersionExpiration?.NoncurrentDays === 30
		&& ab?.Status === 'Enabled' && ab.AbortIncompleteMultipartUpload?.DaysAfterInitiation === 7, describeRules(rules));
	step('New site: stack NoncurrentVersionDays=30', stackParams(d.state.full!).NoncurrentVersionDays === '30', String(stackParams(d.state.full!).NoncurrentVersionDays));
}

/** 1. Gate a note that embeds an mp3. */
async function scenarioGate(ctx: TestContext, d: Deployed, step: Step): Promise<void> {
	console.log('\n[1] Gate a note with an mp3');
	const bucket = d.state.bucket!;
	const k = keyOf('gate.mp3');
	const notices = await publish(ctx, [N('Cln Gate'), N('Cln Keep')]);
	step('Gate: public publish succeeded', published(notices, 2), JSON.stringify(notices.filter(t => /Success|fail|Error/i.test(t))));
	step('Gate: public copy uploaded', !!head(bucket, `attachments/${k}`), k);
	await waitInvalidations(d.state.dist!);
	const pubUrl = `${d.base}/attachments/${k}`;
	const before = await fetchStatus(pubUrl);
	step('Gate: anonymous fetch of the public URL works before gating (now cached)', before === 200, String(before));

	step('Gate: note frontmatter now lists g1', await setGroups(ctx, N('Cln Gate'), [G1]), N('Cln Gate'));
	const n2 = await publish(ctx, [N('Cln Gate')]);
	step('Gate: gated publish succeeded', published(n2, 1), JSON.stringify(n2.filter(t => /Success|fail|Error|Couldn't/i.test(t))));
	await waitInvalidations(d.state.dist!);
	step('Gate: file under restricted/g1/attachments/', !!head(bucket, `restricted/g1/attachments/${k}`), k);
	step('Gate: public copy gone', !head(bucket, `attachments/${k}`), `attachments/${k}`);
	const after = await fetchStatus(pubUrl);
	step('Gate: anonymous fetch of the old public URL returns 403', after === 403, String(after));
	const token = idToken(d.pool.UserPoolId, d.pool.UserPoolClientId, G1_READER);
	const member = await fetchStatus(`${d.base}/restricted/g1/attachments/${k}`, token);
	step('Gate: a g1 member fetches the gated copy', member === 200, String(member));
	const st = readStateFile(await profileDirAbs(ctx, PP));
	step('Gate: attachments.json uploaded moved from public to g1', !(st?.uploaded?.['']?.includes(k)) && st?.uploaded?.['restricted/g1/']?.includes(k) === true,
		JSON.stringify({ pub: st?.uploaded?.[''], g1: st?.uploaded?.['restricted/g1/'] }));
}

/** 2. Two notes, one public and one gated, share a file. */
async function scenarioShared(ctx: TestContext, d: Deployed, step: Step): Promise<void> {
	console.log('\n[2] Shared file in two areas');
	const bucket = d.state.bucket!;
	const k = keyOf('shared.mp3');
	const n1 = await publish(ctx, [N('Cln Share Pub'), N('Cln Share Gated')]);
	step('Shared: publish succeeded', published(n1, 2), JSON.stringify(n1.filter(t => /Success|fail|Error/i.test(t))));
	step('Shared: the file exists in both areas', !!head(bucket, `attachments/${k}`) && !!head(bucket, `restricted/g1/attachments/${k}`), k);

	const uid = await uidOf(ctx, N('Cln Share Pub'));
	const deleted = await ctx.page.evaluate(async ({ id, uid }) => {
		const c = (window as any).__cln;
		return c.plugin().publisher.deletePublishedUid(c.profile(id), uid, 'Cln Share Pub');
	}, { id: PP, uid });
	step('Shared: deleting the public note succeeded', deleted === true, String(deleted));
	step('Shared: delete removed the public copy', !head(bucket, `attachments/${k}`), `attachments/${k}`);
	step('Shared: delete left the gated note\'s copy intact', !!head(bucket, `restricted/g1/attachments/${k}`), `restricted/g1/attachments/${k}`);

	const n2 = await publish(ctx, [N('Cln Share Pub')]);
	step('Shared: republishing the public note re-uploads its copy', published(n2, 1) && !!head(bucket, `attachments/${k}`), k);
	step('Shared: gated note frontmatter cleared', await setGroups(ctx, N('Cln Share Gated'), []), N('Cln Share Gated'));
	const n3 = await publish(ctx, [N('Cln Share Gated')]);
	step('Shared: ungate publish succeeded', published(n3, 1), JSON.stringify(n3.filter(t => /Success|fail|Error|Couldn't/i.test(t))));
	step('Shared: ungating removed the g1 copy (no g1 note uses it)', !head(bucket, `restricted/g1/attachments/${k}`), `restricted/g1/attachments/${k}`);
	step('Shared: ungating left the public copy intact', !!head(bucket, `attachments/${k}`), `attachments/${k}`);
	await waitInvalidations(d.state.dist!);
}

/** 3. attachments.json deleted: the probe finds objects, the sweep rebuilds first. */
async function scenarioRebuild(ctx: TestContext, d: Deployed, step: Step): Promise<void> {
	console.log('\n[3] Rebuild after losing attachments.json');
	const bucket = d.state.bucket!;
	const k = keyOf('rebuild.mp3');
	const n1 = await publish(ctx, [N('Cln Rebuild')]);
	step('Rebuild: public publish succeeded', published(n1, 1) && !!head(bucket, `attachments/${k}`), k);

	const dir = await profileDirAbs(ctx, PP);
	fs.unlinkSync(path.join(dir, 'attachments.json'));
	step('Rebuild: note frontmatter now lists g1', await setGroups(ctx, N('Cln Rebuild'), [G1]), N('Cln Rebuild'));
	const logMark = ctx.collector.getStructuredLogs().length;
	const n2 = await publish(ctx, [N('Cln Rebuild')]);
	const logs = ctx.collector.getStructuredLogs().slice(logMark).map(l => l.message);
	step('Rebuild: gated publish succeeded', published(n2, 1), JSON.stringify(n2.filter(t => /Success|fail|Error|Couldn't/i.test(t))));
	step('Rebuild: the probe found attachment objects (file created incomplete)', logs.some(m => m.includes('attachments.json (complete: false)')),
		JSON.stringify(logs.filter(m => m.includes('attachments.json'))));
	step('Rebuild: the sweep rebuilt the state from the bucket', logs.some(m => m.includes(`Rebuilt attachments.json for profile ${PP}`))
		&& n2.some(t => t.includes('Rebuilding attachment state from published notes') || t.includes('Attachment state rebuilt')),
		JSON.stringify({ logs: logs.filter(m => /Rebuil/.test(m)), notices: n2.filter(t => /ebuil/.test(t)) }));
	await waitInvalidations(d.state.dist!);
	step('Rebuild: the public copy was swept', !head(bucket, `attachments/${k}`), `attachments/${k}`);
	step('Rebuild: the gated copy exists', !!head(bucket, `restricted/g1/attachments/${k}`), k);
	const keep = keyOf('keep.png');
	const shared = keyOf('shared.mp3');
	const gate = keyOf('gate.mp3');
	step('Rebuild: files other notes use survive', !!head(bucket, `attachments/${keep}`) && !!head(bucket, `attachments/${shared}`)
		&& !!head(bucket, `restricted/g1/attachments/${gate}`), 'keep.png, shared.mp3 (public), gate.mp3 (g1)');
	const st = readStateFile(dir);
	const keepHash = await latest(ctx, N('Cln Keep'));
	step('Rebuild: attachments.json is complete and holds refs read from the bucket',
		st?.complete === true && !!keepHash && st.refs?.[keepHash]?.includes(keep) === true, JSON.stringify({ complete: st?.complete, keepRefs: keepHash ? st?.refs?.[keepHash] : null }));
	const listed = s3Keys(bucket, 'attachments/').map(x => x.slice('attachments/'.length)).sort();
	step('Rebuild: uploaded matches the bucket listing', JSON.stringify([...(st?.uploaded?.[''] ?? [])].sort()) === JSON.stringify(listed),
		JSON.stringify({ uploaded: st?.uploaded?.[''], listed }));
}

/** 4. Audit: a missing object and an unreferenced one. */
async function scenarioAudit(ctx: TestContext, d: Deployed, step: Step): Promise<void> {
	console.log('\n[4] Audit published notes');
	const { page } = ctx;
	const bucket = d.state.bucket!;
	const k = keyOf('audit.mp3');
	const n1 = await publish(ctx, [N('Cln Audit')]);
	step('Audit: publish succeeded', published(n1, 1) && !!head(bucket, `attachments/${k}`), k);
	aws(['s3api', 'delete-object', '--bucket', bucket, '--key', `attachments/${k}`], { json: false });
	const stray = `${crypto.randomBytes(32).toString('hex')}/stray.mp3`;
	aws(['s3api', 'put-object', '--bucket', bucket, '--key', `attachments/${stray}`, '--body', media('off.mp3')]);

	const mark = await noticeMark(ctx);
	const logMark = ctx.collector.getStructuredLogs().length;
	await page.evaluate(() => {
		const c = (window as any).__cln;
		c.auditRun = c.plugin().publisher.auditPublishedNotes().then(() => 'done', (e: unknown) => String(e));
	});
	// Profile picker.
	await page.waitForSelector('.prompt-input', { timeout: 15_000 });
	await page.keyboard.type('Cln Public', { delay: 20 });
	await page.waitForTimeout(300);
	await page.keyboard.press('Enter');

	// The audit summary, then the delete offer for the stray object.
	let summary = '';
	for (let i = 0; i < 240 && !summary; i++) {
		summary = (await noticesSince(ctx, mark)).find(t => t.startsWith('Audit of "Cln Public"')) ?? '';
		if (!summary) await sleep(250);
	}
	step('Audit: reports 1 unreferenced object and 1 missing', summary.includes('Attachments: 1 unreferenced object(s), 1 missing.')
		&& summary.includes('1 missing file(s) re-upload at the next publish of a note that uses them.'), summary);
	await ctx.screenshot('04-audit-summary');
	const offer = await page.waitForSelector('.prompt-input[placeholder*="unreferenced attachment object"]', { timeout: 15_000 }).catch(() => null);
	step('Audit: offers to delete the unreferenced object', !!offer, offer ? String(await offer.getAttribute('placeholder')) : 'no confirm prompt');
	if (offer) {
		await page.keyboard.type('Yes', { delay: 20 });
		await page.waitForTimeout(300);
		await page.keyboard.press('Enter');
	}
	let done = '';
	for (let i = 0; i < 240 && !done; i++) {
		done = (await noticesSince(ctx, mark)).find(t => t.includes('unreferenced attachment object') && t.startsWith('Deleted')) ?? '';
		if (!done) await sleep(250);
	}
	step('Audit: the delete offer removed the stray object', done === 'Deleted 1 unreferenced attachment object.' && !head(bucket, `attachments/${stray}`), done);
	// A UID picker only opens when UIDs are flagged; none should be.
	await page.waitForTimeout(1_000);
	const picker = await page.$('.prompt-input[placeholder*="stale published UID"]');
	if (picker) await page.keyboard.press('Escape');
	step('Audit: no stale UIDs flagged', !picker, picker ? 'UID picker opened' : 'none');
	const run = await page.evaluate(() => Promise.race([(window as any).__cln.auditRun, new Promise(r => setTimeout(() => r('pending'), 10_000))]));
	step('Audit: command finished', run === 'done', String(run));

	const logs = ctx.collector.getStructuredLogs().slice(logMark).map(l => l.message).join('\n');
	step('Audit: console lists the missing file under "re-uploaded at the next publish"', logs.includes('Missing attachment objects, re-uploaded at the next publish of a note that uses them: 1')
		&& logs.includes(k) && logs.includes('used by Cln Audit'), logs.split('\n').filter(l => /ttachment/.test(l)).slice(0, 8).join(' | '));
	const st = readStateFile(await profileDirAbs(ctx, PP));
	step('Audit: the missing key was cleared from uploaded', !(st?.uploaded?.['']?.includes(k)), JSON.stringify(st?.uploaded?.['']));

	const n2 = await publish(ctx, [N('Cln Audit')]);
	step('Audit: the next publish of the note re-uploads the missing file', published(n2, 1) && !!head(bucket, `attachments/${k}`), k);
}

/** 5. Mode off, then gate: the public copy is still swept. */
async function scenarioModeOff(ctx: TestContext, d: Deployed, step: Step): Promise<void> {
	console.log('\n[5] Mode off, then gate');
	const bucket = d.state.bucket!;
	const k = keyOf('off.mp3');
	const n1 = await publish(ctx, [N('Cln Off')]);
	step('Mode off: public publish with the mode on', published(n1, 1) && !!head(bucket, `attachments/${k}`), k);
	await waitInvalidations(d.state.dist!);
	const url = `${d.base}/attachments/${k}`;
	step('Mode off: the public URL works (now cached)', await fetchStatus(url) === 200, url);
	await patchAttachments(ctx, PP, { mode: 'off' });
	step('Mode off: note frontmatter now lists g1', await setGroups(ctx, N('Cln Off'), [G1]), N('Cln Off'));
	try {
		const n2 = await publish(ctx, [N('Cln Off')]);
		step('Mode off: gated publish succeeded', published(n2, 1), JSON.stringify(n2.filter(t => /Success|fail|Error|Couldn't/i.test(t))));
		await waitInvalidations(d.state.dist!);
		step('Mode off: the public copy was swept', !head(bucket, `attachments/${k}`), `attachments/${k}`);
		step('Mode off: nothing uploaded to g1 (the mode is off)', !head(bucket, `restricted/g1/attachments/${k}`), k);
		const after = await fetchStatus(url);
		step('Mode off: anonymous fetch of its URL returns 403', after === 403, String(after));
	} finally {
		await patchAttachments(ctx, PP, { mode: 'embeds' });
	}
}

/** 6. History but no attachment objects: created complete, never rebuilt. */
async function scenarioFresh(ctx: TestContext, d: Deployed, step: Step): Promise<void> {
	console.log('\n[6] Profile with history but no attachment objects');
	const bucket = d.state.bucket!;
	const dir = await profileDirAbs(ctx, PQ);
	const n1 = await publish(ctx, [N('Cln Fresh Plain')], PQ);
	step('Fresh: a publish with the mode off builds history', published(n1, 1) && !!(await latest(ctx, N('Cln Fresh Plain'), PQ)), JSON.stringify(n1.filter(t => /Success|fail|Error/i.test(t))));
	step('Fresh: no attachments.json yet', readStateFile(dir) === null, dir);
	step('Fresh: no attachment objects under its prefix', s3Keys(bucket, `${PQ_PREFIX}attachments/`).length === 0
		&& s3Keys(bucket, `${PQ_PREFIX}restricted/`).length === 0, PQ_PREFIX);

	await patchAttachments(ctx, PQ, { mode: 'embeds' });
	const logMark = ctx.collector.getStructuredLogs().length;
	const n2 = await publish(ctx, [N('Cln Fresh Media')], PQ);
	const logs = ctx.collector.getStructuredLogs().slice(logMark).map(l => l.message);
	const st = readStateFile(dir);
	step('Fresh: first publish with attachments on succeeded', published(n2, 1) && !!head(bucket, `${PQ_PREFIX}attachments/${keyOf('fresh.mp3')}`), keyOf('fresh.mp3'));
	step('Fresh: attachments.json created complete', st?.complete === true && logs.some(m => m.includes('attachments.json (complete: true)')),
		JSON.stringify({ complete: st?.complete, logs: logs.filter(m => m.includes('attachments.json')) }));
	step('Fresh: never rebuilt', !logs.some(m => /Rebuilt attachments\.json/.test(m)) && !n2.some(t => /Rebuilding attachment state|Attachment state rebuilt/.test(t)),
		JSON.stringify(n2.filter(t => /ebuil/.test(t))));
}

interface RouteProbe { status: number; type: string; origin: string }

/** Which origin answered: S3, API Gateway, a Lambda Function URL, or neither. */
function originOf(h: Headers): string {
	if (h.get('apigw-requestid')) return 'apigateway';
	if (h.get('x-amz-request-id') || h.get('server') === 'AmazonS3') return 's3';
	if (h.get('x-amzn-requestid')) return 'lambda';
	return 'edge';
}

async function probeRoutes(base: string): Promise<Record<string, RouteProbe>> {
	const chatBody = JSON.stringify({ question: 'ping' });
	const reqs: Record<string, [string, RequestInit]> = {
		control: [`${base}/api/cln-nothing-here`, {}],
		authCallback: [`${base}/auth/callback`, {}],
		apiComments: [`${base}/api/comments?uid=CLNPROBE00`, {}],
		apiMe: [`${base}/api/me`, {}],
		commentsBucket: [`${base}/comments/CLNPROBE00.json`, {}],
		chat: [`${base}/api/chat`, {
			method: 'POST', body: chatBody,
			headers: { 'content-type': 'application/json', 'x-amz-content-sha256': crypto.createHash('sha256').update(chatBody).digest('hex') },
		}],
	};
	const out: Record<string, RouteProbe> = {};
	for (const [name, [url, init]] of Object.entries(reqs)) {
		const r = await fetch(url, { redirect: 'manual', ...init });
		await r.arrayBuffer().catch(() => undefined);
		out[name] = { status: r.status, type: (r.headers.get('content-type') ?? '').split(';')[0], origin: originOf(r.headers) };
	}
	return out;
}

function distributionShape(distId: string): string {
	const c = aws<{ DistributionConfig: any }>(['cloudfront', 'get-distribution-config', '--id', distId]).DistributionConfig;
	const lfa = (b: any) => (b.LambdaFunctionAssociations?.Items ?? []).map((a: any) => `${a.EventType}:${a.LambdaFunctionARN}`).sort();
	return JSON.stringify({
		origins: (c.Origins?.Items ?? []).map((o: any) => `${o.Id}=${o.DomainName}${o.OriginPath ?? ''}`).sort(),
		default: { target: c.DefaultCacheBehavior.TargetOriginId, lfa: lfa(c.DefaultCacheBehavior) },
		behaviors: (c.CacheBehaviors?.Items ?? []).map((b: any) => ({ path: b.PathPattern, target: b.TargetOriginId, lfa: lfa(b) })),
		aliases: c.Aliases?.Items ?? [],
	});
}

/** Apply `days` through Settings → Infrastructure → Bucket cleanup rule. */
async function applyInSettings(ctx: TestContext, days: number): Promise<any> {
	return ctx.page.evaluate(async ({ pluginId, id, days }) => {
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
		let row: Element | undefined;
		for (let i = 0; i < 40 && !row; i++) {
			for (const d of Array.from(document.querySelectorAll('.modal.mod-settings details.cpn-settings-section'))) (d as HTMLDetailsElement).open = true;
			row = Array.from(document.querySelectorAll('.modal.mod-settings .setting-item'))
				.find((s) => s.querySelector('.setting-item-name')?.textContent === 'Bucket cleanup rule');
			if (!row) await new Promise(r => setTimeout(r, 250));
		}
		if (!row) return { error: 'bucket cleanup row not found' };
		const desc = row.querySelector('.setting-item-description')?.textContent ?? '';
		const input = row.querySelector('input') as HTMLInputElement;
		const button = row.querySelector('button') as HTMLButtonElement;
		const before = { desc, value: input.value };
		input.value = String(days);
		input.dispatchEvent(new Event('input', { bubbles: true }));
		button.click();
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === id);
		let failed = '';
		for (let i = 0; i < 900; i++) {
			if (profile.infrastructureState.bucketLifecycleDays === days) break;
			failed = Array.from(document.querySelectorAll('.notice')).map((n) => n.textContent ?? '').find((t) => t.includes('Bucket cleanup rule change failed')) ?? '';
			if (failed) break;
			await new Promise(r => setTimeout(r, 1000));
		}
		const notices = Array.from(document.querySelectorAll('.notice')).map((n) => n.textContent ?? '');
		(window as any).app.setting.close();
		return { before, days: profile.infrastructureState.bucketLifecycleDays, failed, notices };
	}, { pluginId: PLUGIN_ID, id: PP, days });
}

async function waitRules(bucket: string, want: (rules: any[] | null) => boolean): Promise<any[] | null> {
	let rules = lifecycleRules(bucket);
	for (let i = 0; i < 30 && !want(rules); i++) {
		await sleep(2_000);
		rules = lifecycleRules(bucket);
	}
	return rules;
}

/** 7. The bucket cleanup rule's Apply. */
async function scenarioApply(ctx: TestContext, d: Deployed, step: Step): Promise<void> {
	console.log('\n[7] Bucket cleanup rule: Apply in Settings → Infrastructure');
	const bucket = d.state.bucket!;
	const full = d.state.full!;
	const routes0 = await probeRoutes(d.base);
	const shape0 = distributionShape(d.state.dist!);
	const params0 = stackParams(full);
	const apiRoutes = ['authCallback', 'apiComments', 'apiMe', 'chat'];
	step('Routes before Apply: /auth/*, the comment API and /api/chat reach their own origins',
		apiRoutes.every(r => routes0[r].origin !== 's3' && routes0[r].status < 500 && routes0[r].type !== 'text/html') && routes0.control.origin === 's3',
		JSON.stringify(routes0));

	const off = await applyInSettings(ctx, 0);
	if (off.error) { ctx.fail('Apply 0', off.error); return; }
	step('Apply 0: row showed the default 30 before', off.before.value === '30', JSON.stringify(off.before));
	step('Apply 0: profile records 0', off.days === 0 && !off.failed, `${off.days} ${off.failed}`);
	const rules0 = await waitRules(bucket, r => r?.length === 1);
	step('Apply 0: only the abort-uploads rule remains', rules0?.length === 1 && rules0[0].ID === 'AbortIncompleteMultipartUploads'
		&& rules0[0].AbortIncompleteMultipartUpload?.DaysAfterInitiation === 7, describeRules(rules0));

	const mark = await noticeMark(ctx);
	const on = await applyInSettings(ctx, 14);
	if (on.error) { ctx.fail('Apply 14', on.error); return; }
	step('Apply 14: row showed the applied 0 before', on.before.value === '0', JSON.stringify(on.before));
	step('Apply 14: profile records 14', on.days === 14 && !on.failed, `${on.days} ${on.failed}`);
	await sleep(1_500);
	const applied = (await noticesSince(ctx, mark)).filter(t => /cleanup rule/i.test(t));
	step('Apply 14: success notice', applied.some(t => t.includes('deleted 14 days after')), JSON.stringify(applied));
	const rules14 = await waitRules(bucket, r => r?.length === 2);
	const nc = rules14?.find(r => r.ID === 'ExpireNoncurrentVersions');
	step('Apply 14: GetBucketLifecycleConfiguration shows both rules', rules14?.length === 2 && nc?.NoncurrentVersionExpiration?.NoncurrentDays === 14
		&& rules14.some(r => r.ID === 'AbortIncompleteMultipartUploads' && r.AbortIncompleteMultipartUpload?.DaysAfterInitiation === 7), describeRules(rules14));
	await ctx.screenshot('07-applied');

	const params1 = stackParams(full);
	const changed = Object.keys({ ...params0, ...params1 }).filter(k => params0[k] !== params1[k]);
	step('Apply: only NoncurrentVersionDays changed on the stack', JSON.stringify(changed) === '["NoncurrentVersionDays"]' && params1.NoncurrentVersionDays === '14',
		JSON.stringify(changed.map(k => `${k}: ${params0[k]} -> ${params1[k]}`)));
	step('Apply: distribution origins, behaviors and edge functions unchanged', distributionShape(d.state.dist!) === shape0, shape0);
	const routes1 = await probeRoutes(d.base);
	step('Apply: /auth/*, comments and chat answer exactly as before', JSON.stringify(routes1) === JSON.stringify(routes0),
		JSON.stringify({ before: routes0, after: routes1 }));

	// An imported stack shows the CDK text and no button.
	const imported = await ctx.page.evaluate(async ({ pluginId, id }) => {
		const plugin = (window as any).app.plugins.plugins[pluginId];
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === id);
		profile.infrastructureState.imported = true;
		try {
			plugin.openProfileSettings(id);
			// Settings opens on the CPN tab root; step into the profile's page.
			const profileName = plugin.settings.publishingProfiles.find((p: any) => p.id === id)?.name;
			for (let i = 0; i < 20; i++) {
				const nav = Array.from(document.querySelectorAll('.modal.mod-settings .setting-item.mod-navigable'))
					.find((r) => r.querySelector('.setting-item-name')?.textContent?.trim() === profileName) as HTMLElement | undefined;
				if (nav) { nav.click(); break; }
				await new Promise(r => setTimeout(r, 250));
			}
			let row: Element | undefined;
			for (let i = 0; i < 40 && !row; i++) {
				for (const d of Array.from(document.querySelectorAll('.modal.mod-settings details.cpn-settings-section'))) (d as HTMLDetailsElement).open = true;
				row = Array.from(document.querySelectorAll('.modal.mod-settings .setting-item'))
					.find((s) => s.querySelector('.setting-item-name')?.textContent === 'Bucket cleanup rule');
				if (!row) await new Promise(r => setTimeout(r, 250));
			}
			const out = row ? { desc: row.querySelector('.setting-item-description')?.textContent ?? '', buttons: row.querySelectorAll('button').length } : null;
			(window as any).app.setting.close();
			return out;
		} finally {
			delete profile.infrastructureState.imported;
		}
	}, { pluginId: PLUGIN_ID, id: PP });
	step('Imported stack: "Managed outside the plugin; add a lifecycle rule in CDK." and no Apply button',
		imported?.desc === 'Managed outside the plugin; add a lifecycle rule in CDK.' && imported.buttons === 0, JSON.stringify(imported));
}

/** 8. No sweep gave up, no plugin errors. */
async function scenarioClean(ctx: TestContext, step: Step): Promise<void> {
	const all: string[] = await ctx.page.evaluate(() => (window as any).__cln.notices);
	const cantCheck = all.filter(t => t.startsWith("Couldn't check"));
	step('No sweep reported "Couldn\'t check … Run Audit published notes"', cantCheck.length === 0, JSON.stringify(cantCheck));
	const errors = ctx.collector.getLogsByLevel('error').filter(e => e.source === 'plugin').map(e => e.message);
	step('No plugin errors logged', errors.length === 0, JSON.stringify(errors.slice(0, 5)));
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
	deleteStack(s.chat);
	if (s.commentBucket) { console.log(`Emptying ${s.commentBucket}...`); emptyVersionedBucket(s.commentBucket); }
	deleteStack(s.comment);
	if (s.bucket) { console.log(`Emptying ${s.bucket}...`); emptyVersionedBucket(s.bucket); }
	deleteStack(s.full);
	deleteStack(s.edge);
	deleteStack(s.poolStack);
	for (const b of [s.bucket, s.commentBucket]) {
		if (!b) continue;
		emptyVersionedBucket(b);
		aws(['s3api', 'delete-bucket', '--bucket', b], { json: false, allowFail: true });
	}
	const leftovers = deleteVariantFunctionsAndRoles(s.variant);
	if (s.accountId && s.poolStack) {
		aws(['s3', 'rm', `s3://cpn-assets-${s.accountId}-us-east-1/access/${s.poolStack}/`, '--recursive', '--quiet'], { json: false, allowFail: true });
	}
	if (!leftovers.length && s.bootstrapPreexisting === false && s.accountId) {
		const others = (aws<{ StackSummaries?: { StackName: string }[] }>(['cloudformation', 'list-stacks', '--stack-status-filter', 'CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'CREATE_IN_PROGRESS', 'UPDATE_IN_PROGRESS'])
			.StackSummaries || []).map((x: any) => x.StackName).filter((n: string) => n.startsWith('cpn-') && n !== 'cpn-bootstrap');
		if (others.length) {
			console.log(`Keeping cpn-bootstrap: other cpn- stacks use it (${others.join(', ')})`);
		} else {
			const assets = `cpn-assets-${s.accountId}-us-east-1`;
			console.log(`Removing the bootstrap stack this run created (${assets})...`);
			emptyVersionedBucket(assets);
			deleteStack('cpn-bootstrap');
			aws(['s3api', 'delete-bucket', '--bucket', assets], { json: false, allowFail: true });
		}
	}
	if (leftovers.length) {
		console.log(`\nStill replicating (retry --teardown in a few hours): ${leftovers.join(', ')}`);
	} else {
		fs.unlinkSync(STATE_PATH);
		console.log('\nTeardown complete.');
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function live(ctx: TestContext): Promise<void> {
	const step: Step = (name, cond, detail) => (cond ? ctx.pass(name, detail) : ctx.fail(name, detail));
	await ctx.page.evaluate(INSTALL);
	const indexed = await ctx.page.evaluate((paths) => (window as any).__cln.waitIndexed(paths), Object.keys(NOTES));
	if (!indexed) { ctx.fail('Fixture notes indexed', 'metadata cache never indexed the fixtures'); return; }
	const d = process.argv.includes('--reuse') ? await reuse(ctx, step) : await deploy(ctx, step);
	if (!d) return;
	for (let i = 0; i < 60; i++) {
		const r = await fetch(`${d.base}/index.html`).catch(() => null);
		if (r && r.status < 500) break;
		await sleep(10_000);
	}
	const scenarios: Array<[string, () => Promise<void>]> = [
		['0 new-site rules', () => scenarioNewSiteRules(ctx, d, step)],
		['1 gate', () => scenarioGate(ctx, d, step)],
		['2 shared', () => scenarioShared(ctx, d, step)],
		['3 rebuild', () => scenarioRebuild(ctx, d, step)],
		['4 audit', () => scenarioAudit(ctx, d, step)],
		['5 mode off', () => scenarioModeOff(ctx, d, step)],
		['6 fresh profile', () => scenarioFresh(ctx, d, step)],
		['7 apply', () => scenarioApply(ctx, d, step)],
		['8 clean', () => scenarioClean(ctx, step)],
	];
	for (const [name, run] of scenarios) {
		try {
			await run();
		} catch (err) {
			ctx.fail(`Scenario ${name}`, `aborted: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
		}
	}
}

if (!AWS_PROFILE) {
	console.error('Set CPN_LIVE_AWS_PROFILE to a sandbox AWS CLI profile to run this live test.');
	process.exit(2);
}

if (process.argv.includes('--teardown')) {
	teardown();
} else {
	const snapshot = fs.readFileSync(DATA_JSON, 'utf8');
	const profileDirs = [PP, PQ].map(id => `.obsidian/plugins/${PLUGIN_ID}/profiles/${id}`);
	runTest({
		name: 'attachment-cleanup-live',
		launchTimeout: 60_000,
		cleanupFiles: [...FIXTURE_ROOTS, ...profileDirs],
		setupVault,
	}, async (ctx) => {
		await ctx.page.waitForTimeout(5_000);
		try {
			await live(ctx);
		} catch (err) {
			ctx.fail('Live run', `aborted: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
		} finally {
			await ctx.page.evaluate(async ({ pluginId, snap }) => {
				const plugin = (window as any).app.plugins.plugins[pluginId];
				plugin.settings = JSON.parse(snap);
				await plugin.saveSettings();
			}, { pluginId: PLUGIN_ID, snap: snapshot }).catch(() => {});
			fs.writeFileSync(DATA_JSON, snapshot);
			for (const f of fs.readdirSync(PLUGIN_DIR)) {
				if (f.startsWith('attachment-hash-cache.')) fs.rmSync(path.join(PLUGIN_DIR, f), { force: true });
			}
			console.log(`\n  Live resources recorded in ${STATE_PATH}; run with --teardown to remove them.`);
		}
	});
}
