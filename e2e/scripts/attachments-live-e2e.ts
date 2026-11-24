#!/usr/bin/env npx tsx
/**
 * Attachment publishing (phase 2) — LIVE AWS end-to-end test (opt-in, creates real resources)
 *
 * The sandbox checks from specs/attachment-publishing/phase-2-core.md §10
 * ("End-to-end"), plus the §10 checks that need a running Obsidian (publish
 * lock, publish error handling) and the §4 bare-space indexing question.
 *
 * Deploys, through the plugin's own CloudFormationManager:
 *   - one Cognito pool (current template, 12 h sessions);
 *   - site A: public reads + per-note access groups (g1, g2), the Cognito edge
 *     function in public-reads mode (via upgradeCognitoGate);
 *   - site B: a whole-site Cognito gate on its own edge function, the pool's
 *     callback pointed at it;
 *   - a plain bucket for a mode-`off` profile.
 * A separate headless Chromium drives the published SPA.
 *
 * Scenarios:
 *   1. Publish all (A) with the lock held: Publish current note and the delete
 *      picker are refused with the busy notice; lastFullPublishTimestamp is the
 *      start time and a note edited mid-publish is in the next updates run;
 *      every revision's refs are in attachments.json.
 *   2. Public mp3: plays from /attachments/, seeks (206 range responses).
 *   3. PDF embed and [[file.pdf]] open in a new tab under their own name
 *      (inline application/pdf); svg/html/js opened directly download; the svg
 *      renders inline in the note; a %20 Markdown image publishes; bare-space
 *      destination indexing recorded.
 *   4. Two-group note: a member of only g2 plays it; copies in both areas.
 *   5. Gated host (g2) embedding a public note: host file from
 *      restricted/g2/attachments/, embedded file from attachments/.
 *   6. **\/private/: only b.mp3 publishes; a.mp3 is an unpublished span,
 *      null.mp3 in raw, no object in any area.
 *   7. Multipart (> 16 MB): CRC32 accepted, plays, no incomplete uploads.
 *   8. Replace the mp3's bytes, Publish updates: new revision + new audio, old
 *      permalink plays old audio, diff "The text is identical. Attachments
 *      changed: song.mp3."
 *   9. Tag edit keeping size and mtime: Publish updates picks it up (ctime),
 *      new revision plays the new bytes.
 *  10. Mode off (bucket C): no attachment objects; unpublished spans with names.
 *  11. Failed batch: upload denied (bucket policy) → returns false, staging kept,
 *      no error session; a staging-time throw (uidConflicts) copies staging to
 *      staged-error and keeps it; folder then excluded → next publish uploads the
 *      staged note without the file, names it, note shows "Attachment unavailable".
 *  12. "Still changing": a file written during queueing aborts the publish,
 *      committing nothing.
 *  13. A large file overwritten mid-upload: multipart aborted, no object, the
 *      "changed while publishing" notice; the next publish drops the entry.
 *  14. A file near the cap: renderer memory stays near the in-flight parts.
 *  15. Session expiry: whole-site gate (B) shows "Your session has ended", no
 *      reload, link → Hosted UI with the note route, and native sign-in through
 *      it lands back on the note; public site (A) gated note shows the sign-in
 *      link.
 *  16. Show PDFs inline (A): the toggle keeps note hashes; after a republish
 *      the PDF embed is a frame on the file (#page kept, 200 application/pdf)
 *      with its new-tab link, [[file.pdf]] stays a link; a g2 member's gated
 *      PDF frame loads from restricted/g2/; signed out, a frame gets no src
 *      and shows "Sign in again to view this".
 *
 * Usage (sandbox account only):
 *   CPN_LIVE_AWS_PROFILE=random npx tsx e2e/scripts/attachments-live-e2e.ts
 *   CPN_LIVE_AWS_PROFILE=random npx tsx e2e/scripts/attachments-live-e2e.ts --reuse
 *   CPN_LIVE_AWS_PROFILE=random npx tsx e2e/scripts/attachments-live-e2e.ts --teardown
 *
 * --reuse runs the scenarios against the stacks a previous run deployed
 * (from the state file), re-seeding the plugin profiles from their outputs.
 *
 * Resource names go to e2e/results/attachments-live-state.json. Lambda@Edge
 * replicas take CloudFront hours to release: teardown reports functions it
 * couldn't delete yet; re-run --teardown later. The test vault's plugin
 * data.json is snapshotted and restored.
 */

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium, type Browser as PwBrowser, type BrowserContext, type Page as PwPage } from 'playwright-core';
import { runTest, type TestContext } from '../lib/test-harness';
import { VAULT_PATH, RESULTS_DIR, PLUGIN_ID } from '../lib/test-helpers';

const AWS_PROFILE = process.env.CPN_LIVE_AWS_PROFILE;
const REGION = 'us-east-1';
const STATE_PATH = path.join(RESULTS_DIR, 'attachments-live-state.json');
const PLUGIN_DIR = path.join(VAULT_PATH, '.obsidian', 'plugins', PLUGIN_ID);
const DATA_JSON = path.join(PLUGIN_DIR, 'data.json');
const PASSWORD = 'Att-E2e-Passw0rd!';
const PA = 'att-pub';
const PB = 'att-gate';
const PC = 'att-off';
const G2_READER = 'g2reader@example.com';
const G1_READER = 'g1reader@example.com';
const B_READER = 'reader@example.com';
const CAP_MB = 320;
const MB = 1024 * 1024;

const DEFAULT_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'mp4', 'm4v', 'webm', 'mov', 'pdf'];

const FIXTURE_ROOTS = ['Att-Media', 'Att-Projects', 'Att-Later', 'Att-Big', 'Att-Notes'];

interface LiveState {
	variant: string;
	accountId?: string;
	bootstrapPreexisting?: boolean;
	poolStack?: string;
	fullA?: string;
	edgeA?: string;
	fullB?: string;
	edgeB?: string;
	bucketA?: string;
	bucketB?: string;
	bucketC?: string;
	distA?: string;
	distB?: string;
	domainA?: string;
	domainB?: string;
}

// ---------------------------------------------------------------------------
// Node-side helpers: AWS CLI
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

function s3Keys(bucket: string, prefix = ''): string[] {
	const keys: string[] = [];
	let token: string | undefined;
	do {
		const d = aws(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix,
			...(token ? ['--continuation-token', token] : [])], { allowFail: true });
		for (const o of d?.Contents || []) keys.push(o.Key);
		token = d?.IsTruncated ? d.NextContinuationToken : undefined;
	} while (token);
	return keys;
}

function s3Json(bucket: string, key: string): any {
	const tmp = path.join(os.tmpdir(), `cpn-att-${crypto.randomBytes(4).toString('hex')}.json`);
	aws(['s3api', 'get-object', '--bucket', bucket, '--key', key, tmp]);
	const v = JSON.parse(fs.readFileSync(tmp, 'utf8'));
	fs.unlinkSync(tmp);
	return v;
}

function head(bucket: string, key: string, checksum = false): any {
	return aws(['s3api', 'head-object', '--bucket', bucket, '--key', key, ...(checksum ? ['--checksum-mode', 'ENABLED'] : [])], { allowFail: true });
}

function multipartUploads(bucket: string, prefix = ''): any[] {
	return aws(['s3api', 'list-multipart-uploads', '--bucket', bucket, '--prefix', prefix], { allowFail: true })?.Uploads || [];
}

/** Find a note JSON in any area. */
function noteJsonAnywhere(bucket: string, hash: string, groups: string[] = []): any | null {
	for (const area of ['', ...groups.map(g => `restricted/${g}/`)]) {
		if (head(bucket, `${area}notes/${hash}.json`)) return s3Json(bucket, `${area}notes/${hash}.json`);
	}
	return null;
}

async function waitInvalidations(distId: string): Promise<void> {
	for (let i = 0; i < 120; i++) {
		const list = aws(['cloudfront', 'list-invalidations', '--distribution-id', distId]).InvalidationList?.Items || [];
		if (!list.some((x: any) => x.Status !== 'Completed')) return;
		await sleep(10_000);
	}
	throw new Error(`invalidations on ${distId} still in progress`);
}

function saveState(s: LiveState): void {
	fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
	fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sha256File = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ---------------------------------------------------------------------------
// Cognito users and tokens
// ---------------------------------------------------------------------------

function describeClient(poolId: string, clientId: string): any {
	return aws(['cognito-idp', 'describe-user-pool-client', '--user-pool-id', poolId, '--client-id', clientId]).UserPoolClient;
}

/** Native users + admin auth on the stack's own client, keeping its token validity. */
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
	if (c.TokenValidityUnits) args.push('--token-validity-units', Object.entries(c.TokenValidityUnits).map(([k, v]) => `${k}=${v}`).join(','));
	aws(args);
}

function ensureUser(poolId: string, email: string): void {
	aws(['cognito-idp', 'admin-create-user', '--user-pool-id', poolId, '--username', email, '--message-action', 'SUPPRESS',
		'--user-attributes', `Name=email,Value=${email}`, 'Name=email_verified,Value=true'], { allowFail: true });
	aws(['cognito-idp', 'admin-set-user-password', '--user-pool-id', poolId, '--username', email, '--password', PASSWORD, '--permanent'], { json: false });
}

/** A real id token (the pre-token trigger adds cognito:groups from the membership file). */
function idToken(poolId: string, clientId: string, email: string): string {
	const secret = describeClient(poolId, clientId).ClientSecret as string;
	const secretHash = crypto.createHmac('sha256', secret).update(email + clientId).digest('base64');
	const d = aws(['cognito-idp', 'admin-initiate-auth', '--user-pool-id', poolId, '--client-id', clientId,
		'--auth-flow', 'ADMIN_USER_PASSWORD_AUTH', '--auth-parameters', `USERNAME=${email},PASSWORD=${PASSWORD},SECRET_HASH=${secretHash}`]);
	return d.AuthenticationResult.IdToken;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ffmpeg(args: string[]): void {
	execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}
const mp3 = (out: string, freq: number, seconds: number, title = 'Att') =>
	ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`, '-c:a', 'libmp3lame', '-b:a', '64k',
		'-metadata', `title=${title}`, '-id3v2_version', '3', out]);
const png = (out: string, color: string) =>
	ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=64x48`, '-frames:v', '1', out]);

function randomFile(p: string, bytes: number): void {
	const fd = fs.openSync(p, 'w');
	try {
		for (let done = 0; done < bytes;) {
			const n = Math.min(8 * MB, bytes - done);
			fs.writeSync(fd, crypto.randomBytes(n));
			done += n;
		}
	} finally {
		fs.closeSync(fd);
	}
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newUid = () => Array.from(crypto.randomBytes(10), b => CROCKFORD[b % 32]).join('');
/** Frontmatter with a pre-minted UID, so publishing never rewrites the note (and its mtime). */
const fm = (contexts: string[], groups: string[] = []) =>
	`---\ncpn-uid: ${newUid()}\ncpn-publish-contexts:\n${contexts.map(c => `  - ${c}`).join('\n')}\n`
	+ (groups.length ? `cpn-access-groups:\n${groups.map(g => `  - ${g}`).join('\n')}\n` : '') + '---\n';

/** Notes present at launch (vault-relative path → content). */
const NOTES: Record<string, string> = {
	'Att-Notes/Att Song.md': fm([PA]) + 'Listen:\n\n![[Att-Media/song.mp3]]\n',
	'Att-Notes/Att Tagged.md': fm([PA]) + '![[Att-Media/tagged.mp3]]\n',
	'Att-Notes/Att Docs.md': fm([PA]) + [
		'Embed: ![[Att-Media/slides.pdf#page=2]]', '',
		'Link: [[Att-Media/slides.pdf]]', '',
		'![[Att-Media/diagram.svg]]', '',
		'[[Att-Media/page.html]] and [[Att-Media/script.js]]', '',
		'Encoded: ![pic](Att-Media/my%20pic.png)', '',
	].join('\n'),
	'Att-Notes/Att Bare.md': fm([PA]) + 'Bare: ![](Att-Media/bare pic.png)\n',
	'Att-Notes/Att Two Groups.md': fm([PA], ['g1', 'g2']) + '![[Att-Media/two.mp3]]\n\n![[Att-Media/cover.png]]\n',
	'Att-Notes/Att Public Embed.md': fm([PA]) + '![[Att-Media/pubembed.mp3]]\n',
	'Att-Notes/Att Gated Host.md': fm([PA], ['g2']) + '![[Att-Media/host.png]]\n\n![[Att Public Embed]]\n',
	'Att-Notes/Att Gated Song.md': fm([PA], ['g2']) + '![[Att-Media/long.wav]]\n',
	'Att-Notes/Att Long.md': fm([PA]) + '![[Att-Media/long.wav]]\n',
	'Att-Notes/Att Excluded.md': fm([PA]) + '![[Att-Projects/private/a.mp3]]\n\n![[Att-Media/b.mp3]]\n',
	'Att-Notes/Att Edit During.md': fm([PA]) + 'Edited during a publish.\n',
	'Att-Notes/Att Gate Song.md': fm([PB]) + '![[Att-Media/long.wav]]\n',
	'Att-Notes/Att Gated Pdf.md': fm([PA], ['g2']) + 'Deck: ![[Att-Media/gated.pdf]]\n',
	'Att-Notes/Att Off.md': fm([PC]) + '![[Att-Media/song.mp3]] and [[Att-Media/slides.pdf]] and ![c](Att-Media/cover.png)\n',
};

/** A fixed whole-second time, so utimes can restore mtime exactly. */
const FIXTURE_MTIME = Math.floor(Date.now() / 1000) - 3600;

function setupVault(vaultPath: string): void {
	const at = (p: string) => {
		const full = path.join(vaultPath, p);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		return full;
	};
	for (const [p, body] of Object.entries(NOTES)) fs.writeFileSync(at(p), body);
	mp3(at('Att-Media/song.mp3'), 440, 5);
	mp3(at('Att-Media/tagged.mp3'), 330, 4, 'TakeAAAA');
	fs.utimesSync(at('Att-Media/tagged.mp3'), FIXTURE_MTIME, FIXTURE_MTIME);
	mp3(at('Att-Media/two.mp3'), 550, 3);
	mp3(at('Att-Media/pubembed.mp3'), 600, 3);
	mp3(at('Att-Media/b.mp3'), 700, 2);
	mp3(at('Att-Projects/private/a.mp3'), 800, 2);
	// ~22 MB: multipart, and long enough that a seek needs a new range request.
	ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=125', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', at('Att-Media/long.wav')]);
	png(at('Att-Media/cover.png'), 'red');
	png(at('Att-Media/host.png'), 'blue');
	png(at('Att-Media/my pic.png'), 'green');
	png(at('Att-Media/bare pic.png'), 'yellow');
	fs.writeFileSync(at('Att-Media/diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="purple"/><script>window.__ran=1</script></svg>');
	fs.writeFileSync(at('Att-Media/page.html'), '<!doctype html><title>Page</title><script>document.title="RAN"</script><p>page</p>');
	fs.writeFileSync(at('Att-Media/script.js'), 'document.title = "RAN";\n');
	fs.writeFileSync(at('Att-Media/slides.pdf'), minimalPdf());
	fs.writeFileSync(at('Att-Media/gated.pdf'), minimalPdf());
}

function minimalPdf(): Buffer {
	const objs = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
	];
	let body = '%PDF-1.4\n';
	const offsets: number[] = [];
	objs.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
	const xref = body.length;
	body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
	body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body);
}

// ---------------------------------------------------------------------------
// Obsidian-side helpers (installed once as window.__att)
// ---------------------------------------------------------------------------

/** String-evaluated (no tsx transform), so it can define functions freely. */
const INSTALL = `
window.__name = (f) => f;
window.__att = {
	plugin() { return app.plugins.plugins['${PLUGIN_ID}']; },
	profile(id) { return this.plugin().settings.publishingProfiles.find((p) => p.id === id); },
	file(p) { return app.vault.getAbstractFileByPath(p); },
	notices: [],
	async publish(paths, id, updateTs, inval) {
		const files = paths.map((p) => this.file(p));
		if (files.some((f) => !f)) throw new Error('missing file in ' + JSON.stringify(paths));
		await this.plugin().publisher.publishNotes(files, this.profile(id), !!updateTs, inval !== false);
	},
	async history(id) {
		const pl = this.plugin();
		return JSON.parse(await app.vault.adapter.read(pl.profileManager.getPublishHistoryPath(id)));
	},
	uid(p) { return this.plugin().frontmatterManager.peekNoteUID(this.file(p)); },
	async latest(id, p) {
		const h = await this.history(id);
		const list = h[this.uid(p)] || [];
		return list[list.length - 1] || null;
	},
	async revisions(id, p) {
		const h = await this.history(id);
		return h[this.uid(p)] || [];
	},
	async readJson(p) {
		return (await app.vault.adapter.exists(p)) ? JSON.parse(await app.vault.adapter.read(p)) : null;
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
	// Per notice element: the same text in a later notice is recorded again.
	const seen = new WeakMap();
	const rec = () => {
		for (const n of document.querySelectorAll('.notice')) {
			const t = (n.textContent || '').trim();
			let texts = seen.get(n);
			if (!texts) { texts = new Set(); seen.set(n, texts); }
			if (t && !texts.has(t)) { texts.add(t); window.__att.notices.push(t); }
		}
	};
	new MutationObserver(rec).observe(document.body, { childList: true, subtree: true, characterData: true });
})();
`;

async function noticeMark(ctx: TestContext): Promise<number> {
	return ctx.page.evaluate(() => (window as any).__att.notices.length);
}
async function noticesSince(ctx: TestContext, mark: number): Promise<string[]> {
	return ctx.page.evaluate((m) => (window as any).__att.notices.slice(m), mark);
}
async function publish(ctx: TestContext, paths: string[], id: string, updateTs = false): Promise<void> {
	await ctx.page.evaluate(({ paths, id, updateTs }) => (window as any).__att.publish(paths, id, updateTs, true), { paths, id, updateTs });
}
async function latest(ctx: TestContext, id: string, p: string): Promise<string | null> {
	return ctx.page.evaluate(({ id, p }) => (window as any).__att.latest(id, p), { id, p });
}
async function uidOf(ctx: TestContext, p: string): Promise<string> {
	return ctx.page.evaluate((p) => (window as any).__att.uid(p), p);
}
async function patchProfile(ctx: TestContext, id: string, patch: Record<string, unknown>): Promise<void> {
	await ctx.page.evaluate(async ({ id, patch }) => {
		const att = (window as any).__att;
		Object.assign(att.profile(id), patch);
		await att.plugin().saveSettings();
	}, { id, patch });
}
async function profileDir(ctx: TestContext, id: string): Promise<string> {
	return ctx.page.evaluate((id) => (window as any).__att.plugin().profileManager.getProfileDir(id), id);
}
/** Vault-relative staging snapshot: staged-notes listing + staged-attachments.json. */
function stagingSnapshot(profileDirRel: string): { notes: string[]; attachments: any[] | null } {
	const dir = path.join(VAULT_PATH, profileDirRel);
	const notes: string[] = [];
	const walk = (d: string) => {
		if (!fs.existsSync(d)) return;
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p); else notes.push(path.relative(dir, p));
		}
	};
	walk(path.join(dir, 'staged-notes'));
	const sa = path.join(dir, 'staged-attachments.json');
	return { notes: notes.sort(), attachments: fs.existsSync(sa) ? JSON.parse(fs.readFileSync(sa, 'utf8')) : null };
}

// ---------------------------------------------------------------------------
// Browser-side helpers (headless Chromium on the published site)
// ---------------------------------------------------------------------------

interface Visit { context: BrowserContext; page: PwPage; responses: Array<{ url: string; status: number }>; navigations: string[] }

async function visit(browser: PwBrowser, base: string, route: string, token?: string): Promise<Visit> {
	const context = await browser.newContext({ acceptDownloads: true, ignoreHTTPSErrors: false });
	if (token) {
		await context.addCookies([{ name: 'cpn_id', value: token, domain: new URL(base).hostname, path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }]);
	}
	const page = await context.newPage();
	const responses: Visit['responses'] = [];
	const navigations: string[] = [];
	page.on('response', r => responses.push({ url: r.url(), status: r.status() }));
	page.on('framenavigated', f => { if (f === page.mainFrame()) navigations.push(f.url()); });
	await page.goto(`${base}/${route}`, { waitUntil: 'domcontentloaded' });
	return { context, page, responses, navigations };
}

/** Wait for a media element to load metadata (or fail). */
async function mediaState(page: PwPage, selector: string, timeoutMs = 30_000): Promise<{ src: string; readyState: number; duration: number; error: number | null; found: boolean }> {
	const el = await page.waitForSelector(`${selector}[src]`, { timeout: timeoutMs, state: 'attached' }).catch(() => null);
	if (!el) return { src: '', readyState: 0, duration: 0, error: null, found: false };
	return page.evaluate(async ({ selector, timeoutMs }) => {
		const m = document.querySelector(selector) as HTMLMediaElement;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline && m.readyState < 1 && !m.error) await new Promise(r => setTimeout(r, 200));
		return { src: m.getAttribute('src') || '', readyState: m.readyState, duration: m.duration, error: m.error ? m.error.code : null, found: true };
	}, { selector, timeoutMs });
}

async function imageState(page: PwPage, selector: string): Promise<{ src: string; width: number; found: boolean }> {
	const el = await page.waitForSelector(`${selector}[src]`, { timeout: 30_000, state: 'attached' }).catch(() => null);
	if (!el) return { src: '', width: 0, found: false };
	return page.evaluate(async (selector) => {
		const img = document.querySelector(selector) as HTMLImageElement;
		for (let i = 0; i < 100 && !(img.complete && img.naturalWidth > 0); i++) await new Promise(r => setTimeout(r, 200));
		return { src: img.getAttribute('src') || '', width: img.naturalWidth, found: true };
	}, selector);
}

/** Navigate to a URL that should download; returns the suggested name, or null. */
async function downloadOf(browser: PwBrowser, url: string): Promise<{ name: string | null; title: string }> {
	const context = await browser.newContext({ acceptDownloads: true });
	const page = await context.newPage();
	try {
		const dl = page.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
		await page.goto(url).catch(() => { /* "Download is starting" */ });
		const d = await dl;
		const title = await page.title().catch(() => '');
		return { name: d ? d.suggestedFilename() : null, title };
	} finally {
		await context.close();
	}
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

function emptyVersionedBucket(bucket: string): void {
	aws(['s3', 'rm', `s3://${bucket}`, '--recursive', '--quiet'], { json: false, allowFail: true });
	for (const u of multipartUploads(bucket)) {
		aws(['s3api', 'abort-multipart-upload', '--bucket', bucket, '--key', u.Key, '--upload-id', u.UploadId], { json: false, allowFail: true });
	}
	for (let round = 0; round < 50; round++) {
		const versions = aws(['s3api', 'list-object-versions', '--bucket', bucket], { allowFail: true });
		const objs = [...(versions?.Versions || []), ...(versions?.DeleteMarkers || [])].map((v: any) => ({ Key: v.Key, VersionId: v.VersionId }));
		if (objs.length === 0) break;
		for (let i = 0; i < objs.length; i += 500) {
			aws(['s3api', 'delete-objects', '--bucket', bucket, '--delete', JSON.stringify({ Objects: objs.slice(i, i + 500), Quiet: true })], { allowFail: true });
		}
	}
}

function deleteStack(stack?: string): void {
	if (!stack || !aws(['cloudformation', 'describe-stacks', '--stack-name', stack], { allowFail: true })) return;
	console.log(`Deleting ${stack}...`);
	aws(['cloudformation', 'delete-stack', '--stack-name', stack], { json: false });
	aws(['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', stack], { json: false, allowFail: true });
	const after = aws(['cloudformation', 'describe-stacks', '--stack-name', stack], { allowFail: true });
	if (after?.Stacks?.[0]?.StackStatus === 'DELETE_FAILED') {
		const res = aws(['cloudformation', 'list-stack-resources', '--stack-name', stack]);
		const stuck = (res.StackResourceSummaries || []).filter((r: any) => r.ResourceStatus !== 'DELETE_COMPLETE').map((r: any) => r.LogicalResourceId);
		console.log(`  ${stack} DELETE_FAILED; retaining ${stuck.join(', ')}`);
		aws(['cloudformation', 'delete-stack', '--stack-name', stack, '--retain-resources', ...stuck], { json: false });
		aws(['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', stack], { json: false, allowFail: true });
	}
}

function teardown(): void {
	if (!fs.existsSync(STATE_PATH)) {
		console.log('No live state recorded; nothing to tear down.');
		return;
	}
	const s: LiveState = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
	for (const b of [s.bucketA, s.bucketB]) {
		if (b) { console.log(`Emptying ${b}...`); emptyVersionedBucket(b); }
	}
	deleteStack(s.fullA);
	deleteStack(s.fullB);
	deleteStack(s.edgeA);
	deleteStack(s.edgeB);
	deleteStack(s.poolStack);
	for (const b of [s.bucketA, s.bucketB, s.bucketC]) {
		if (!b) continue;
		emptyVersionedBucket(b);
		aws(['s3api', 'delete-bucket', '--bucket', b], { json: false, allowFail: true });
	}
	const leftovers: string[] = [];
	for (const f of aws(['lambda', 'list-functions'], { allowFail: true })?.Functions || []) {
		if (!String(f.FunctionName).includes(s.variant)) continue;
		if (aws(['lambda', 'delete-function', '--function-name', f.FunctionName], { json: false, allowFail: true }) === null) leftovers.push(f.FunctionName);
		else console.log(`Deleted function ${f.FunctionName}`);
	}
	for (const r of aws(['iam', 'list-roles'], { allowFail: true })?.Roles || []) {
		if (!String(r.RoleName).includes(s.variant)) continue;
		for (const p of aws(['iam', 'list-attached-role-policies', '--role-name', r.RoleName], { allowFail: true })?.AttachedPolicies || []) {
			aws(['iam', 'detach-role-policy', '--role-name', r.RoleName, '--policy-arn', p.PolicyArn], { json: false, allowFail: true });
		}
		for (const n of aws(['iam', 'list-role-policies', '--role-name', r.RoleName], { allowFail: true })?.PolicyNames || []) {
			aws(['iam', 'delete-role-policy', '--role-name', r.RoleName, '--policy-name', n], { json: false, allowFail: true });
		}
		if (aws(['iam', 'delete-role', '--role-name', r.RoleName], { json: false, allowFail: true }) !== null) console.log(`Deleted role ${r.RoleName}`);
	}
	if (s.accountId && s.poolStack) {
		aws(['s3', 'rm', `s3://cpn-assets-${s.accountId}-us-east-1/access/${s.poolStack}/`, '--recursive', '--quiet'], { json: false, allowFail: true });
	}
	if (!leftovers.length && s.bootstrapPreexisting === false && s.accountId) {
		const assets = `cpn-assets-${s.accountId}-us-east-1`;
		console.log(`Removing the bootstrap stack this run created (${assets})...`);
		emptyVersionedBucket(assets);
		deleteStack('cpn-bootstrap');
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
// Deploy
// ---------------------------------------------------------------------------

type Step = (name: string, cond: boolean, detail: string) => void;

interface Deployed {
	state: LiveState;
	pool: Record<string, string>;
	baseA: string;
	baseB: string;
}

const awsSettings = (bucketName = '', distributionId = '') => ({
	awsProfile: AWS_PROFILE, region: REGION, bucketName, s3Prefix: '', awsAccountId: '',
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

/** --reuse: rebuild the profiles from a previous run's stacks. */
async function reuse(ctx: TestContext, step: Step): Promise<Deployed | null> {
	if (!fs.existsSync(STATE_PATH)) { ctx.fail('Reuse', 'no state file'); return null; }
	const state: LiveState = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
	if (!state.poolStack || !state.fullA || !state.edgeA || !state.fullB || !state.edgeB || !state.bucketC) {
		ctx.fail('Reuse', 'state file is missing stacks'); return null;
	}
	const po = stackOutputs(state.poolStack);
	const edgeA = stackOutputs(state.edgeA);
	const edgeB = stackOutputs(state.edgeB);
	// Only A owns the pool's membership file: B syncing its (empty) groups would
	// overwrite A's, as the fresh deploy (no location on B) never does.
	const cognito = (edgeStack: string, edge: Record<string, string>, publicReads: boolean) => ({
		stackName: state.poolStack, enabled: true, commentIdentity: false, userPoolId: po.UserPoolId,
		userPoolClientId: po.UserPoolClientId, hostedUiDomain: po.HostedUiDomain, jwksUri: po.JwksUri, issuer: po.Issuer,
		callbackApiDomain: po.CallbackApiDomain, edgeStackName: edgeStack, edgeFunctionVersionArn: edge.EdgeFunctionVersionArn,
		...(publicReads ? { accessGroupsBucket: po.AccessGroupsBucket, accessGroupsKey: po.AccessGroupsKey } : {}),
		edgePublicReads: publicReads || undefined, sessionHours: 12,
	});
	const infra = (full: string, variant: string, mode: string, edgeStack: string, edge: Record<string, string>, publicReads: boolean) => ({
		status: 'deployed', fullStackName: full, useRoute53: false, region: REGION, variantName: variant, originAccessMethod: 'oac',
		readGateMode: mode, authLambdaEdgeArn: edge.EdgeFunctionVersionArn, cognitoAuth: cognito(edgeStack, edge, publicReads),
	});
	await putProfile(ctx, {
		id: PA, name: 'Att Public', publishMechanism: 'AWS', awsSettings: awsSettings(state.bucketA, state.distA),
		baseUrl: `https://${state.domainA}`, isPublic: true, publishContentIndex: false, excludedDirectories: ['**/private/'],
		obscureRawWikilinks: true, obscureRawAttachments: true,
		attachments: { mode: 'embedsAndLinks', allowedExtensions: [...DEFAULT_EXTS, 'html', 'js'], maxFileSizeMB: CAP_MB },
		accessGroups: { g1: { members: [G1_READER] }, g2: { members: [G2_READER] } }, publicSiteAccessGroups: true,
		infrastructureState: infra(state.fullA, state.variant, 'none', state.edgeA, edgeA, true),
	});
	await putProfile(ctx, {
		id: PB, name: 'Att Gate', publishMechanism: 'AWS', awsSettings: awsSettings(state.bucketB, state.distB),
		baseUrl: `https://${state.domainB}`, isPublic: false, publishContentIndex: false, excludedDirectories: [], readGate: { mode: 'cognito' },
		attachments: { mode: 'embeds', allowedExtensions: [...DEFAULT_EXTS], maxFileSizeMB: CAP_MB },
		infrastructureState: infra(state.fullB, `${state.variant}b`, 'cognito', state.edgeB, edgeB, false),
	});
	await putProfile(ctx, {
		id: PC, name: 'Att Off', publishMechanism: 'AWS', awsSettings: awsSettings(state.bucketC),
		baseUrl: 'https://att-off.invalid', isPublic: true, publishContentIndex: false, excludedDirectories: [],
		obscureRawAttachments: true, attachments: { mode: 'off', allowedExtensions: [...DEFAULT_EXTS], maxFileSizeMB: 50 },
	});
	const gated = await ctx.page.evaluate(async (id) => {
		const att = (window as any).__att;
		await att.plugin().syncAccessGroups(att.profile(id), { force: true });
		return att.profile(id).infrastructureState.authLambdaEdgeArn;
	}, PA);
	step('Reuse: profiles re-seeded from the deployed stacks', !!gated && !!po.AccessGroupsKey, `${state.variant}`);
	enableNativeSignIn(po.UserPoolId, po.UserPoolClientId);
	for (const u of [G1_READER, G2_READER, B_READER]) ensureUser(po.UserPoolId, u);
	return { state, pool: po, baseA: `https://${state.domainA}`, baseB: `https://${state.domainB}` };
}

async function deploy(ctx: TestContext, step: Step): Promise<Deployed | null> {
	const { page } = ctx;
	const accountId = aws(['sts', 'get-caller-identity']).Account as string;
	const variant = `atte2e${crypto.randomBytes(3).toString('hex')}`;
	const state: LiveState = { variant, accountId };
	state.bootstrapPreexisting = !!aws(['cloudformation', 'describe-stacks', '--stack-name', 'cpn-bootstrap'], { allowFail: true });
	saveState(state);
	console.log(`  variant: ${variant} (account ${accountId})`);

	// Profile A first: the pool deploy reads the profile's AWS settings.
	await putProfile(ctx, {
		id: PA, name: 'Att Public', publishMechanism: 'AWS', awsSettings: awsSettings(),
		isPublic: true, publishContentIndex: false, excludedDirectories: ['**/private/'],
		obscureRawWikilinks: true, obscureRawAttachments: true,
		attachments: { mode: 'embedsAndLinks', allowedExtensions: [...DEFAULT_EXTS, 'html', 'js'], maxFileSizeMB: CAP_MB },
		accessGroups: { g1: { members: [G1_READER] }, g2: { members: [G2_READER] } },
		publicSiteAccessGroups: true,
	});

	// --- Pool --------------------------------------------------------------
	console.log('\n[deploy] Cognito pool');
	state.poolStack = `cpn-cognito-${variant}`;
	saveState(state);
	const pool = await page.evaluate(async ({ id, variant, prefix }) => {
		const att = (window as any).__att;
		const profile = att.profile(id);
		const cfm = att.plugin().cloudFormationManager;
		const config: any = {
			profileId: id, variantName: variant, awsProfile: profile.awsSettings.awsProfile, region: 'us-east-1', s3Prefix: '',
			customDomain: '', useRoute53: false, hostedZoneId: '', hostedZoneName: '', originAccessMethod: 'oac',
			readGateMode: 'none', googleClientId: 'att-e2e-fake-client', googleClientSecret: 'att-e2e-fake-secret',
			authDomainPrefix: prefix, sessionHours: 12,
		};
		try {
			await cfm.prepareCognitoAssets(config, profile, () => {});
			const stack = await cfm.deployCognitoAuthStack(config);
			const s = await cfm.pollStackUntilComplete(stack, profile, () => {}, 'us-east-1');
			return { stack, s };
		} catch (e) {
			return { error: String(e) };
		}
	}, { id: PA, variant, prefix: `attpool${crypto.randomBytes(4).toString('hex')}` }) as any;
	if (pool.error || pool.s !== 'CREATE_COMPLETE') { ctx.fail('Deploy: Cognito pool', pool.error ?? pool.s); return null; }
	const po = stackOutputs(state.poolStack);
	step('Deploy: Cognito pool', !!po.UserPoolId, `${po.UserPoolId}`);

	// --- Site A: public reads + per-note groups -------------------------------
	console.log('\n[deploy] Site A (public reads, access groups)');
	const siteA = await page.evaluate(async ({ id, variant, callbackDomain }) => {
		const att = (window as any).__att;
		const profile = att.profile(id);
		const cfm = att.plugin().cloudFormationManager;
		const config: any = {
			profileId: id, variantName: variant, s3Prefix: '', customDomain: '', useRoute53: false, hostedZoneId: '',
			hostedZoneName: '', region: 'us-east-1', awsProfile: profile.awsSettings.awsProfile, originAccessMethod: 'oac',
			authLambdaEdgeArn: '', callbackApiDomainName: callbackDomain,
		};
		try {
			const stack = await cfm.deployFullStack(config);
			const s = await cfm.pollStackUntilComplete(stack, profile, () => {}, 'us-east-1');
			if (s !== 'CREATE_COMPLETE') return { error: `full stack ${s}` };
			return { stack, ...(await cfm.getStackOutputs(stack, profile, 'us-east-1')) };
		} catch (e) {
			return { error: String(e) };
		}
	}, { id: PA, variant, callbackDomain: po.CallbackApiDomain }) as any;
	if (siteA.error) { ctx.fail('Deploy: site A', siteA.error); return null; }
	state.fullA = siteA.stack;
	state.bucketA = siteA.bucketName;
	state.distA = siteA.distributionId;
	state.domainA = siteA.distributionDomainName;
	saveState(state);

	const upA = await page.evaluate(async ({ id, poolStack, po, siteA }) => {
		const att = (window as any).__att;
		const profile = att.profile(id);
		profile.awsSettings.bucketName = siteA.bucketName;
		profile.awsSettings.cloudFrontDistributionId = siteA.distributionId;
		profile.baseUrl = `https://${siteA.distributionDomainName}`;
		profile.infrastructureState = {
			status: 'deployed', fullStackName: siteA.stack, useRoute53: false, region: 'us-east-1',
			variantName: siteA.variant, originAccessMethod: 'oac', readGateMode: 'none',
			cognitoAuth: {
				stackName: poolStack, enabled: true, commentIdentity: false, userPoolId: po.UserPoolId,
				userPoolClientId: po.UserPoolClientId, hostedUiDomain: po.HostedUiDomain, jwksUri: po.JwksUri,
				issuer: po.Issuer, edgeFunctionVersionArn: '', callbackApiDomain: po.CallbackApiDomain, sessionHours: 12,
			},
		};
		await att.plugin().saveSettings();
		try {
			const r = await att.plugin().cloudFormationManager.upgradeCognitoGate(profile, () => {});
			await att.plugin().syncAccessGroups(profile, { force: true });
			return { r, edgeStack: profile.infrastructureState.cognitoAuth.edgeStackName };
		} catch (e) {
			return { error: String(e) };
		}
	}, { id: PA, poolStack: state.poolStack, po, siteA: { ...siteA, variant } }) as any;
	if (upA.error) { ctx.fail('Deploy: site A edge (upgradeCognitoGate)', upA.error); return null; }
	state.edgeA = upA.edgeStack;
	saveState(state);
	const gatedCheck = await page.evaluate((id) => {
		const att = (window as any).__att;
		const p = att.profile(id);
		const c = p.infrastructureState.cognitoAuth;
		return { arn: p.infrastructureState.authLambdaEdgeArn, edgeArn: c.edgeFunctionVersionArn, publicReads: c.edgePublicReads };
	}, PA);
	step('Deploy: site A runs the public-reads edge fn', !!gatedCheck.arn && gatedCheck.arn === gatedCheck.edgeArn && gatedCheck.publicReads === true,
		JSON.stringify(gatedCheck));

	// --- Site B: whole-site Cognito gate on its own edge fn --------------------------
	console.log('\n[deploy] Site B (whole-site Cognito gate)');
	const variantB = `${variant}b`;
	await putProfile(ctx, {
		id: PB, name: 'Att Gate', publishMechanism: 'AWS', awsSettings: awsSettings(),
		isPublic: false, publishContentIndex: false, excludedDirectories: [], readGate: { mode: 'cognito' },
		attachments: { mode: 'embeds', allowedExtensions: [...DEFAULT_EXTS], maxFileSizeMB: CAP_MB },
	});
	const siteB = await page.evaluate(async ({ id, variantB, po, poolStack }) => {
		const att = (window as any).__att;
		const profile = att.profile(id);
		const cfm = att.plugin().cloudFormationManager;
		const config: any = {
			profileId: id, variantName: variantB, s3Prefix: '', customDomain: '', useRoute53: false, hostedZoneId: '',
			hostedZoneName: '', region: 'us-east-1', awsProfile: profile.awsSettings.awsProfile, originAccessMethod: 'oac',
			readGateMode: 'cognito', callbackApiDomainName: po.CallbackApiDomain,
		};
		try {
			const poolOut = { hostedUiDomain: po.HostedUiDomain, userPoolClientId: po.UserPoolClientId, userPoolId: po.UserPoolId };
			const edgeStack = await cfm.deployCognitoEdgeStack(config, profile, poolOut, () => {}, { publicReads: false });
			const es = await cfm.pollStackUntilComplete(edgeStack, profile, () => {}, 'us-east-1');
			if (es !== 'CREATE_COMPLETE') return { error: `edge B ${es}`, edgeStack };
			const edgeArn = (await cfm.getEdgeStackOutputs(edgeStack, profile)).edgeFunctionVersionArn;
			config.authLambdaEdgeArn = edgeArn;
			const stack = await cfm.deployFullStack(config);
			const s = await cfm.pollStackUntilComplete(stack, profile, () => {}, 'us-east-1');
			if (s !== 'CREATE_COMPLETE') return { error: `full B ${s}`, edgeStack };
			const out = await cfm.getStackOutputs(stack, profile, 'us-east-1');
			profile.awsSettings.bucketName = out.bucketName;
			profile.awsSettings.cloudFrontDistributionId = out.distributionId;
			profile.baseUrl = `https://${out.distributionDomainName}`;
			profile.infrastructureState = {
				status: 'deployed', fullStackName: stack, useRoute53: false, region: 'us-east-1', variantName: variantB,
				originAccessMethod: 'oac', readGateMode: 'cognito', authLambdaEdgeArn: edgeArn,
				cognitoAuth: {
					stackName: poolStack, enabled: true, commentIdentity: false, userPoolId: po.UserPoolId,
					userPoolClientId: po.UserPoolClientId, hostedUiDomain: po.HostedUiDomain, jwksUri: po.JwksUri,
					issuer: po.Issuer, edgeStackName: edgeStack, edgeFunctionVersionArn: edgeArn,
					callbackApiDomain: po.CallbackApiDomain, sessionHours: 12,
				},
			};
			await att.plugin().saveSettings();
			// The Hosted UI hands codes to site B's /auth/callback.
			await cfm.updateCognitoCallbackUrl(poolStack, `https://${out.distributionDomainName}/auth/callback`, profile);
			const cs = await cfm.pollStackUntilComplete(poolStack, profile, () => {}, 'us-east-1');
			return { edgeStack, stack, cs, ...out };
		} catch (e) {
			return { error: String(e) };
		}
	}, { id: PB, variantB, po, poolStack: state.poolStack }) as any;
	if (siteB.edgeStack) state.edgeB = siteB.edgeStack;
	if (siteB.stack) state.fullB = siteB.stack;
	if (siteB.bucketName) state.bucketB = siteB.bucketName;
	state.distB = siteB.distributionId;
	state.domainB = siteB.distributionDomainName;
	saveState(state);
	if (siteB.error) { ctx.fail('Deploy: site B', siteB.error); return null; }
	step('Deploy: site B (whole-site gate) and callback', siteB.cs === 'UPDATE_COMPLETE', `${siteB.distributionDomainName} callback ${siteB.cs}`);

	// --- Bucket C: mode off --------------------------------------------------------
	state.bucketC = `cpn-att-off-${variant}-${accountId}`;
	saveState(state);
	aws(['s3api', 'create-bucket', '--bucket', state.bucketC], { json: false });
	await putProfile(ctx, {
		id: PC, name: 'Att Off', publishMechanism: 'AWS', awsSettings: awsSettings(state.bucketC),
		baseUrl: 'https://att-off.invalid', isPublic: true, publishContentIndex: false, excludedDirectories: [],
		obscureRawAttachments: true, attachments: { mode: 'off', allowedExtensions: [...DEFAULT_EXTS], maxFileSizeMB: 50 },
	});

	// --- Users (after every pool-stack update, which resets the client) -----------------
	enableNativeSignIn(po.UserPoolId, po.UserPoolClientId);
	for (const u of [G1_READER, G2_READER, B_READER]) ensureUser(po.UserPoolId, u);

	return { state, pool: po, baseA: `https://${state.domainA}`, baseB: `https://${state.domainB}` };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const N = (name: string) => `Att-Notes/${name}.md`;
const INITIAL_A = Object.keys(NOTES).filter(p => NOTES[p].includes(`- ${PA}\n`));

/** 1. Publish all with the lock held; timestamp; refs. */
async function scenarioLockAndPublishAll(ctx: TestContext, d: Deployed, step: Step): Promise<void> {
	console.log('\n[1] Publish all (A), lock, timestamp, refs');
	const { page } = ctx;
	const mark = await noticeMark(ctx);
	const before = Date.now();
	await page.evaluate(({ paths, id }) => {
		const att = (window as any).__att;
		att.pubAll = att.publish(paths, id, true, true).then(() => 'done', (e: unknown) => String(e));
	}, { paths: INITIAL_A, id: PA });
	// Same tick as the publish start: the lock is already held.
	const refused = await page.evaluate(async ({ id, songPath }) => {
		const att = (window as any).__att;
		const pl = att.plugin();
		await pl.publisher.publishSingle(att.file(songPath));
		const del = await pl.publisher.deletePublishedUid(att.profile(id), 'ZZZZZZZZ', 'probe');
		return { del };
	}, { id: PA, songPath: N('Att Song') });

	// Edit a note once the upload has started (it was queued and hashed by then).
	let edited = 0;
	for (let i = 0; i < 600 && !edited; i++) {
		const n = await noticesSince(ctx, mark);
		if (n.some(t => t.startsWith('Uploading attachments to S3') || t.startsWith('Uploading notes to S3'))) {
			fs.appendFileSync(path.join(VAULT_PATH, N('Att Edit During')), '\nmore\n');
			edited = Date.now();
		} else await sleep(250);
	}
	const result = await page.evaluate(() => (window as any).__att.pubAll);
	const notices = await noticesSince(ctx, mark);
	step('Publish all (A) succeeded', result === 'done' && notices.some(t => t.includes(`Successfully published ${INITIAL_A.length} note(s)`)),
		`${result}; ${JSON.stringify(notices.filter(t => /Success|fail|Error/i.test(t)))}`);
	step('Lock: Publish current note refused while publishing', notices.some(t => t === 'Att Public is busy (publishing). Try again when it finishes.'),
		JSON.stringify(notices.filter(t => t.includes('busy'))));
	step('Lock: delete picker refused while publishing', refused.del === false
		&& notices.filter(t => t.includes('is busy (publishing)')).length >= 1, JSON.stringify(refused));

	await sleep(2_000);
	const ts = await page.evaluate((id) => (window as any).__att.profile(id).lastFullPublishTimestamp, PA);
	step('lastFullPublishTimestamp is the start time', ts >= before && ts < before + 3_000 && (!edited || ts < edited),
		`start=${before} ts=${ts} edit=${edited}`);
	const updated: string[] = await page.evaluate(async (id) => (await (window as any).__att.plugin().publisher.getUpdatedNotes(id)).map((f: any) => f.path), PA);
	step('Note edited mid-publish is in the next updates run (and nothing else)', !!edited
		&& JSON.stringify(updated) === JSON.stringify([N('Att Edit During')]), `edited=${!!edited} updated=${JSON.stringify(updated)}`);

	// Every revision's refs are in attachments.json and match the note JSON.
	const dir = await profileDir(ctx, PA);
	const stateFile = JSON.parse(fs.readFileSync(path.join(VAULT_PATH, dir, 'attachments.json'), 'utf8'));
	const problems: string[] = [];
	for (const p of INITIAL_A) {
		const hash = await latest(ctx, PA, p);
		if (!hash) { problems.push(`${p}: no revision`); continue; }
		const json = noteJsonAnywhere(d.state.bucketA!, hash, ['g1', 'g2']);
		const keys = (json?.attachments || []).map((a: any) => a.key).sort();
		const refs = stateFile.refs[hash] || [];
		if (JSON.stringify(keys) !== JSON.stringify(refs)) problems.push(`${p}: json ${keys.length} vs refs ${refs.length}`);
	}
	step('attachments.json refs cover every revision', problems.length === 0 && stateFile.complete === true,
		problems.join('; ') || `complete=${stateFile.complete}, ${Object.keys(stateFile.refs).length} revisions with refs`);
	await waitInvalidations(d.state.distA!);
}

/** 2. Public mp3 plays and seeks. */
async function scenarioPlayAndSeek(ctx: TestContext, d: Deployed, step: Step, browser: PwBrowser): Promise<void> {
	console.log('\n[2] Public mp3: plays and seeks');
	const uid = await uidOf(ctx, N('Att Song'));
	const sha = sha256File(path.join(VAULT_PATH, 'Att-Media/song.mp3'));
	const v = await visit(browser, d.baseA, `#/u${uid}`);
	try {
		const m = await mediaState(v.page, 'audio[data-cpn-attachment$="/song.mp3"]');
		step('mp3 player loads from /attachments/', m.src === `/attachments/${sha}/song.mp3` && m.readyState >= 1 && m.error === null,
			JSON.stringify(m));
		const seek = await v.page.evaluate(async () => {
			const a = document.querySelector('audio[data-cpn-attachment$="/song.mp3"]') as HTMLAudioElement;
			const seeked = new Promise<boolean>(r => { a.addEventListener('seeked', () => r(true), { once: true }); setTimeout(() => r(false), 15_000); });
			a.currentTime = 3;
			return { seeked: await seeked, at: a.currentTime };
		});
		const ranged = v.responses.some(r => r.url.endsWith(`/attachments/${sha}/song.mp3`) && r.status === 206);
		step('mp3 seeks (206 range responses)', seek.seeked && Math.abs(seek.at - 3) < 0.5 && ranged,
			`${JSON.stringify(seek)}, 206 seen: ${ranged}`);
		const r = await fetch(`${d.baseA}/attachments/${sha}/song.mp3`, { headers: { Range: 'bytes=100-199' } });
		step('CloudFront serves byte ranges', r.status === 206 && r.headers.get('content-range')?.startsWith('bytes 100-199/') === true
			&& r.headers.get('cache-control') === 'public, max-age=31536000, immutable', `${r.status} ${r.headers.get('content-range')} ${r.headers.get('cache-control')}`);
		await ctx.screenshot('02-song');
	} finally {
		await v.context.close();
	}
}

/** 3. PDF, svg, html, js, %20, bare space. */
async function scenarioDocs(ctx: TestContext, d: Deployed, step: Step, browser: PwBrowser): Promise<void> {
	console.log('\n[3] PDF / svg / html / js / encoded and bare-space destinations');
	const uid = await uidOf(ctx, N('Att Docs'));
	const pdfSha = sha256File(path.join(VAULT_PATH, 'Att-Media/slides.pdf'));
	const v = await visit(browser, d.baseA, `#/u${uid}`);
	try {
		await v.page.waitForSelector('a.cpn-attachment-file[href]', { timeout: 30_000 });
		const links = await v.page.evaluate(() => Array.from(document.querySelectorAll('a.cpn-attachment-file')).map(a => ({
			text: a.textContent, href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'),
		})));
		const pdfEmbed = links.find(l => l.href === `/attachments/${pdfSha}/slides.pdf#page=2`);
		const pdfLink = links.find(l => l.href === `/attachments/${pdfSha}/slides.pdf`);
		step('PDF embed and [[file.pdf]] are new-tab links under the file name', !!pdfEmbed && !!pdfLink
			&& [pdfEmbed, pdfLink].every(l => l!.target === '_blank' && l!.rel === 'noopener' && l!.text === 'slides.pdf'), JSON.stringify(links));
		// Headless Chromium has no PDF viewer: the new tab navigates to the file and
		// gets the PDF, but ends on a blank URL. So check the tab's navigation.
		const pdfUrl = `${d.baseA}/attachments/${pdfSha}/slides.pdf`;
		const navResponse = v.context.waitForEvent('response', {
			predicate: r => r.url() === pdfUrl && r.request().isNavigationRequest(), timeout: 15_000,
		}).catch(() => null);
		const [popup] = await Promise.all([
			v.context.waitForEvent('page', { timeout: 15_000 }).catch(() => null),
			v.page.click(`a.cpn-attachment-file[href="/attachments/${pdfSha}/slides.pdf"]`),
		]);
		const nav = await navResponse;
		step('Clicking the PDF link opens a new tab on the file', !!popup && !!nav && nav.status() === 200
			&& nav.headers()['content-type'] === 'application/pdf' && popup !== v.page,
			`popup: ${!!popup}; tab navigation: ${nav ? `${nav.status()} ${nav.headers()['content-type']}` : 'none'}`);
		const pdfHead = await fetch(`${d.baseA}/attachments/${pdfSha}/slides.pdf`, { method: 'HEAD' });
		step('PDF served inline (browser viewer) under its own name', pdfHead.headers.get('content-type') === 'application/pdf'
			&& pdfHead.headers.get('content-disposition') === "inline; filename*=UTF-8''slides.pdf",
			`${pdfHead.headers.get('content-type')}; ${pdfHead.headers.get('content-disposition')}`);

		const svg = await imageState(v.page, 'img[data-cpn-attachment$="/diagram.svg"]');
		step('svg renders inline in the note', svg.width > 0, JSON.stringify(svg));
		for (const [name, file] of [['svg', 'diagram.svg'], ['html', 'page.html'], ['js', 'script.js']]) {
			const sha = sha256File(path.join(VAULT_PATH, `Att-Media/${file}`));
			const url = `${d.baseA}/attachments/${sha}/${file}`;
			const h = await fetch(url, { method: 'HEAD' });
			const dl = await downloadOf(browser, url);
			step(`${name} opened directly downloads, never runs`, dl.name === file && dl.title !== 'RAN'
				&& h.headers.get('content-disposition') === `attachment; filename*=UTF-8''${file}`
				&& (name === 'svg' ? h.headers.get('content-type') === 'image/svg+xml' : h.headers.get('content-type') === 'application/octet-stream'),
				`download=${dl.name} title=${dl.title}; ${h.headers.get('content-type')}; ${h.headers.get('content-disposition')}`);
		}

		const encSha = sha256File(path.join(VAULT_PATH, 'Att-Media/my pic.png'));
		const enc = await imageState(v.page, 'img[data-cpn-attachment$="/my pic.png"]');
		step('%20 Markdown image is collected, published and rendered', enc.src === `/attachments/${encSha}/${encodeURIComponent('my pic.png')}` && enc.width > 0,
			JSON.stringify(enc));
		await ctx.screenshot('03-docs');
	} finally {
		await v.context.close();
	}

	// §4: does Obsidian index a bare-space destination?
	const bare = await ctx.page.evaluate((p) => {
		const app = (window as any).app;
		const c = app.metadataCache.getFileCache(app.vault.getAbstractFileByPath(p));
		return { embeds: (c?.embeds || []).map((e: any) => e.link), links: (c?.links || []).map((e: any) => e.link) };
	}, N('Att Bare'));
	const bareSha = sha256File(path.join(VAULT_PATH, 'Att-Media/bare pic.png'));
	const bareUploaded = !!head(d.state.bucketA!, `attachments/${bareSha}/bare pic.png`);
	const bareHash = await latest(ctx, PA, N('Att Bare'));
	const bareJson = bareHash ? noteJsonAnywhere(d.state.bucketA!, bareHash) : null;
	ctx.pass('Bare-space destination indexing (§4 check, recorded)',
		`metadata cache embeds=${JSON.stringify(bare.embeds)} links=${JSON.stringify(bare.links)}; uploaded=${bareUploaded}; raw=${JSON.stringify(bareJson?.raw)}`);
	step('Bare-space destination never leaks into rendered HTML as an attachment', !(bareJson?.content || '').includes('data-cpn-attachment'),
		String(bareJson?.content));
}

/** 4 + 5. Groups and scoping. */
async function scenarioGroups(ctx: TestContext, d: Deployed, step: Step, browser: PwBrowser): Promise<void> {
	console.log('\n[4] Two-group note, member of g2 only  [5] gated host embedding a public note');
	const token = idToken(d.pool.UserPoolId, d.pool.UserPoolClientId, G2_READER);
	const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
	step('g2 reader token carries only g2', JSON.stringify(claims['cognito:groups']) === '["g2"]', JSON.stringify(claims['cognito:groups']));
	const twoSha = sha256File(path.join(VAULT_PATH, 'Att-Media/two.mp3'));
	const coverSha = sha256File(path.join(VAULT_PATH, 'Att-Media/cover.png'));
	step('Two-group files are in both group areas, not public', !!head(d.state.bucketA!, `restricted/g1/attachments/${twoSha}/two.mp3`)
		&& !!head(d.state.bucketA!, `restricted/g2/attachments/${twoSha}/two.mp3`) && !head(d.state.bucketA!, `attachments/${twoSha}/two.mp3`), twoSha);

	const v = await visit(browser, d.baseA, `#/u${await uidOf(ctx, N('Att Two Groups'))}`, token);
	try {
		const m = await mediaState(v.page, 'audio[data-cpn-attachment$="/two.mp3"]');
		const img = await imageState(v.page, 'img[data-cpn-attachment$="/cover.png"]');
		step('Member of only the second group plays it', m.src === `/restricted/g2/attachments/${twoSha}/two.mp3` && m.readyState >= 1 && m.error === null
			&& img.src === `/restricted/g2/attachments/${coverSha}/cover.png` && img.width > 0, `${JSON.stringify(m)} ${JSON.stringify(img)}`);
		await ctx.screenshot('04-two-groups');
	} finally {
		await v.context.close();
	}

	const hostSha = sha256File(path.join(VAULT_PATH, 'Att-Media/host.png'));
	const pubSha = sha256File(path.join(VAULT_PATH, 'Att-Media/pubembed.mp3'));
	const h = await visit(browser, d.baseA, `#/u${await uidOf(ctx, N('Att Gated Host'))}`, token);
	try {
		const host = await imageState(h.page, 'img[data-cpn-attachment$="/host.png"]');
		const emb = await mediaState(h.page, '.cpn-transclusion audio[data-cpn-attachment$="/pubembed.mp3"]');
		step('Gated host: its own file from restricted/g2/attachments/', host.src === `/restricted/g2/attachments/${hostSha}/host.png` && host.width > 0, JSON.stringify(host));
		step('Gated host: embedded public note\'s file from attachments/', emb.src === `/attachments/${pubSha}/pubembed.mp3` && emb.readyState >= 1 && emb.error === null,
			JSON.stringify(emb));
		await ctx.screenshot('05-gated-host');
	} finally {
		await h.context.close();
	}
}

/** 6. **\/private/. */
async function scenarioExcluded(ctx: TestContext, d: Deployed, step: Step): Promise<void> {
	console.log('\n[6] **/private/ exclusion');
	const hash = await latest(ctx, PA, N('Att Excluded'));
	const json = hash ? noteJsonAnywhere(d.state.bucketA!, hash) : null;
	const bSha = sha256File(path.join(VAULT_PATH, 'Att-Media/b.mp3'));
	const aSha = sha256File(path.join(VAULT_PATH, 'Att-Projects/private/a.mp3'));
	const allKeys = s3Keys(d.state.bucketA!);
	step('Excluded: only b.mp3 publishes', JSON.stringify((json?.attachments || []).map((a: any) => a.name)) === '["b.mp3"]'
		&& allKeys.includes(`attachments/${bSha}/b.mp3`), JSON.stringify(json?.attachments));
	step('Excluded: a.mp3 is an unpublished span with its name', (json?.content || '').includes('<span class="unpublished-link">a.mp3</span>')
		&& !(json?.content || '').includes('Att-Projects'), String(json?.content));
	step('Excluded: a.mp3 is null.mp3 in raw', (json?.raw || '').includes('![[null.mp3]]') && (json?.raw || '').includes(`![[${bSha}.mp3]]`), JSON.stringify(json?.raw));
	step('Excluded: no object for a.mp3 in any area', !allKeys.some(k => k.endsWith('/a.mp3') || k.includes(aSha)), `${allKeys.length} keys`);
}

/** 7. Multipart. */
async function scenarioMultipart(ctx: TestContext, d: Deployed, step: Step, browser: PwBrowser): Promise<void> {
	console.log('\n[7] Multipart upload (> 16 MB)');
	const sha = sha256File(path.join(VAULT_PATH, 'Att-Media/long.wav'));
	const h = head(d.state.bucketA!, `attachments/${sha}/long.wav`, true);
	step('Multipart: object complete with a composite CRC32', !!h && h.ContentLength > 16 * MB && /-\d+$/.test(h.ChecksumCRC32 || '')
		&& h.ContentType === 'audio/wav', `${h?.ContentLength} ${h?.ChecksumCRC32} ${h?.ContentType}`);
	step('Multipart: no incomplete multipart uploads remain', multipartUploads(d.state.bucketA!).length === 0, JSON.stringify(multipartUploads(d.state.bucketA!)));
	step('Multipart: gated copy uploaded too', !!head(d.state.bucketA!, `restricted/g2/attachments/${sha}/long.wav`), 'restricted/g2');
	const v = await visit(browser, d.baseA, `#/u${await uidOf(ctx, N('Att Long'))}`);
	try {
		const m = await mediaState(v.page, 'audio[data-cpn-attachment$="/long.wav"]');
		step('Multipart file plays', m.src === `/attachments/${sha}/long.wav` && m.readyState >= 1 && m.error === null && Math.abs(m.duration - 125) < 1,
			JSON.stringify(m));
	} finally {
		await v.context.close();
	}
}

/** 8. Replace bytes, publish updates, permalink, diff. */
async function scenarioReplace(ctx: TestContext, d: Deployed, step: Step, browser: PwBrowser): Promise<void> {
	console.log('\n[8] Replace the mp3, Publish updates, permalink and diff');
	const songPath = path.join(VAULT_PATH, 'Att-Media/song.mp3');
	const oldSha = sha256File(songPath);
	const oldHash = await latest(ctx, PA, N('Att Song'));
	await sleep(1_500);
	mp3(songPath, 880, 5);
	const newSha = sha256File(songPath);
	await sleep(2_000);
	const updated: string[] = await ctx.page.evaluate(async (id) => (await (window as any).__att.plugin().publisher.getUpdatedNotes(id)).map((f: any) => f.path), PA);
	step('Publish updates includes the note whose mp3 changed, not untouched notes', updated.includes(N('Att Song'))
		&& !updated.includes(N('Att Docs')) && !updated.includes(N('Att Long')), JSON.stringify(updated));
	await publish(ctx, updated, PA, true);
	const newHash = await latest(ctx, PA, N('Att Song'));
	const revs: string[] = await ctx.page.evaluate(({ id, p }) => (window as any).__att.revisions(id, p), { id: PA, p: N('Att Song') });
	step('Replaced bytes → new revision', !!newHash && newHash !== oldHash && revs.includes(oldHash!), `${oldHash} → ${newHash}`);
	await waitInvalidations(d.state.distA!);

	const uid = await uidOf(ctx, N('Att Song'));
	const cur = await visit(browser, d.baseA, `#/u${uid}`);
	try {
		const m = await mediaState(cur.page, 'audio[data-cpn-attachment$="/song.mp3"]');
		step('Current revision plays the new audio', m.src === `/attachments/${newSha}/song.mp3` && m.readyState >= 1 && m.error === null, JSON.stringify(m));
	} finally { await cur.context.close(); }
	const old = await visit(browser, d.baseA, `#/p${oldHash}`);
	try {
		const m = await mediaState(old.page, 'audio[data-cpn-attachment$="/song.mp3"]');
		step('Old permalink plays the old audio', m.src === `/attachments/${oldSha}/song.mp3` && m.readyState >= 1 && m.error === null, JSON.stringify(m));
	} finally { await old.context.close(); }
	const diff = await visit(browser, d.baseA, `#/u${uid};diff=p${oldHash}`);
	try {
		const notice = await diff.page.waitForSelector('.diff-notice', { timeout: 30_000 }).then(e => e.textContent()).catch(() => null);
		step('Diff: "The text is identical. Attachments changed: song.mp3."', notice?.trim() === 'The text is identical. Attachments changed: song.mp3.', String(notice));
		await ctx.screenshot('08-diff');
	} finally { await diff.context.close(); }
}

/** 9. Tag edit keeping size and mtime. */
async function scenarioTagEdit(ctx: TestContext, d: Deployed, step: Step, browser: PwBrowser): Promise<void> {
	console.log('\n[9] Tag edit keeping size and mtime');
	const p = path.join(VAULT_PATH, 'Att-Media/tagged.mp3');
	const before = fs.statSync(p);
	const buf = fs.readFileSync(p);
	const at = buf.indexOf('TakeAAAA');
	if (at < 0) { ctx.fail('Tag edit', 'title tag not found in tagged.mp3'); return; }
	const oldHash = await latest(ctx, PA, N('Att Tagged'));
	await sleep(1_500);
	const fd = fs.openSync(p, 'r+');
	fs.writeSync(fd, Buffer.from('TakeBBBB'), 0, 8, at);
	fs.closeSync(fd);
	fs.utimesSync(p, before.atime, before.mtime);
	const after = fs.statSync(p);
	step('Tag edit kept size and mtime (ctime moved)', after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs > before.ctimeMs,
		`size ${before.size}/${after.size} mtime ${before.mtimeMs}/${after.mtimeMs}`);
	await sleep(2_000);
	const updated: string[] = await ctx.page.evaluate(async (id) => (await (window as any).__att.plugin().publisher.getUpdatedNotes(id)).map((f: any) => f.path), PA);
	step('Publish updates picks up the tag edit', updated.includes(N('Att Tagged')), JSON.stringify(updated));
	await publish(ctx, updated, PA, true);
	const newHash = await latest(ctx, PA, N('Att Tagged'));
	const sha = sha256File(p);
	step('Tag edit → new revision', !!newHash && newHash !== oldHash, `${oldHash} → ${newHash}`);
	await waitInvalidations(d.state.distA!);
	const v = await visit(browser, d.baseA, `#/u${await uidOf(ctx, N('Att Tagged'))}`);
	try {
		const m = await mediaState(v.page, 'audio[data-cpn-attachment$="/tagged.mp3"]');
		step('Tag-edited file plays the new bytes', m.src === `/attachments/${sha}/tagged.mp3` && m.readyState >= 1 && m.error === null, JSON.stringify(m));
	} finally { await v.context.close(); }
}

/** 10. Mode off. */
async function scenarioModeOff(ctx: TestContext, d: Deployed, step: Step): Promise<void> {
	console.log('\n[10] Mode off');
	await publish(ctx, [N('Att Off')], PC);
	const hash = await latest(ctx, PC, N('Att Off'));
	const keys = s3Keys(d.state.bucketC!);
	const json = hash && keys.includes(`notes/${hash}.json`) ? s3Json(d.state.bucketC!, `notes/${hash}.json`) : null;
	step('Mode off: no attachment objects written', !keys.some(k => k.includes('attachments/')) && !!json, `${keys.length} keys`);
	const c: string = json?.content || '';
	step('Mode off: links render as unpublished spans with the file name', ['song.mp3', 'slides.pdf', 'c'].every(t => c.includes(`<span class="unpublished-link">${t}</span>`))
		&& !c.includes('Att-Media') && !c.includes('data-cpn-attachment'), c);
	step('Mode off: raw obscured to null.<ext>', (json?.raw || '').includes('![[null.mp3]]') && !(json?.raw || '').includes('Att-Media'), JSON.stringify(json?.raw));
}

/** 11. Failed batch, staging-time throw, then exclusion. */
async function scenarioFailedBatch(ctx: TestContext, d: Deployed, step: Step, browser: PwBrowser): Promise<void> {
	console.log('\n[11] Failed batch → staging-time throw → exclusion');
	const { page } = ctx;
	const bucket = d.state.bucketA!;
	fs.mkdirSync(path.join(VAULT_PATH, 'Att-Later'), { recursive: true });
	mp3(path.join(VAULT_PATH, 'Att-Later/take1.mp3'), 990, 2);
	fs.writeFileSync(path.join(VAULT_PATH, N('Att Fail')), fm([PA]) + '![[Att-Later/take1.mp3]]\n');
	fs.writeFileSync(path.join(VAULT_PATH, N('Att Other')), fm([PA]) + 'Just text.\n');
	await page.evaluate((ps) => (window as any).__att.waitIndexed(ps), [N('Att Fail'), N('Att Other'), 'Att-Later/take1.mp3']);
	await sleep(1_000);
	const dir = await profileDir(ctx, PA);
	const errDir = path.join(VAULT_PATH, dir, 'staged-error');
	const errBefore = fs.existsSync(errDir) ? fs.readdirSync(errDir) : [];

	// Deny every PutObject on the site bucket (the original policy is restored after).
	const original = aws(['s3api', 'get-bucket-policy', '--bucket', bucket]).Policy as string;
	const policy = JSON.parse(original);
	policy.Statement.push({ Sid: 'CpnE2eDenyPut', Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: `arn:aws:s3:::${bucket}/*` });
	aws(['s3api', 'put-bucket-policy', '--bucket', bucket, '--policy', JSON.stringify(policy)], { json: false });
	const probe = path.join(os.tmpdir(), 'cpn-att-probe.txt');
	fs.writeFileSync(probe, 'x');
	for (let i = 0; i < 30 && aws(['s3api', 'put-object', '--bucket', bucket, '--key', 'e2e-probe.txt', '--body', probe], { allowFail: true }); i++) await sleep(2_000);
	try {
		const mark = await noticeMark(ctx);
		await publish(ctx, [N('Att Fail')], PA);
		const n = await noticesSince(ctx, mark);
		const snap = stagingSnapshot(dir);
		const takeSha = sha256File(path.join(VAULT_PATH, 'Att-Later/take1.mp3'));
		const failHash = await latest(ctx, PA, N('Att Fail'));
		const errAfter = fs.existsSync(errDir) ? fs.readdirSync(errDir) : [];
		step('Upload failure returns false: "Staged files preserved for retry."', n.includes('Publishing failed. Staged files preserved for retry.'), JSON.stringify(n));
		step('Upload failure keeps staging (note JSON + staged-attachments.json)', !!failHash && snap.notes.includes(`staged-notes/${failHash}.json`)
			&& (snap.attachments || []).some((e: any) => e.fileName === 'take1.mp3'), JSON.stringify(snap));
		step('Upload failure doesn\'t run handlePublishError', errAfter.length === errBefore.length, `${errBefore.length} → ${errAfter.length}`);
		step('Nothing uploaded for the failed batch', !head(bucket, `attachments/${takeSha}/take1.mp3`) && !head(bucket, `notes/${failHash}.json`), String(failHash));
	} finally {
		aws(['s3api', 'put-bucket-policy', '--bucket', bucket, '--policy', original], { json: false });
		for (let i = 0; i < 30 && !aws(['s3api', 'put-object', '--bucket', bucket, '--key', 'e2e-probe.txt', '--body', probe], { allowFail: true }); i++) await sleep(2_000);
		aws(['s3api', 'delete-object', '--bucket', bucket, '--key', 'e2e-probe.txt'], { json: false, allowFail: true });
	}

	// A staging-time throw (uidConflicts) on the next publish.
	const failHash = await latest(ctx, PA, N('Att Fail'));
	const mark2 = await noticeMark(ctx);
	await page.evaluate(() => {
		const fmm = (window as any).__att.plugin().frontmatterManager;
		const origHas = fmm.hasUpdates.bind(fmm);
		const origProc = fmm.process.bind(fmm);
		let calls = 0;
		fmm.hasUpdates = () => calls < 2 || origHas();
		fmm.process = async () => {
			calls++;
			if (calls === 2) {
				fmm.hasUpdates = origHas;
				fmm.process = origProc;
				return { uidConflicts: ['Att-Notes/Fake.md'] };
			}
			return origProc();
		};
	});
	await publish(ctx, [N('Att Other')], PA);
	const n2 = await noticesSince(ctx, mark2);
	const errNow = fs.existsSync(errDir) ? fs.readdirSync(errDir).filter(x => !errBefore.includes(x)) : [];
	const session = errNow.length ? path.join(errDir, errNow[errNow.length - 1]) : '';
	const snap2 = stagingSnapshot(dir);
	step('Staging-time throw reported', n2.some(t => t.includes('changed while publishing. Nothing was published')), JSON.stringify(n2));
	step('handlePublishError copied the earlier batch (note JSON + staged-attachments.json)', !!session
		&& fs.existsSync(path.join(session, `${failHash}.json`)) && fs.existsSync(path.join(session, 'staged-attachments.json')), session);
	step('…and kept staging', snap2.notes.includes(`staged-notes/${failHash}.json`) && (snap2.attachments || []).some((e: any) => e.fileName === 'take1.mp3'),
		JSON.stringify(snap2));

	// Exclude the folder and publish an unrelated note: the staged batch uploads without the file.
	await patchProfile(ctx, PA, { excludedDirectories: ['**/private/', 'Att-Later/'] });
	const mark3 = await noticeMark(ctx);
	await publish(ctx, [N('Att Other')], PA);
	const n3 = await noticesSince(ctx, mark3);
	const takeSha = sha256File(path.join(VAULT_PATH, 'Att-Later/take1.mp3'));
	step('Excluded after staging: the notice names it', n3.some(t => t.includes("1 attachment wasn't uploaded because it's now excluded") && t.includes('take1.mp3')), JSON.stringify(n3));
	step('Excluded after staging: file not uploaded in any area', !s3Keys(bucket).some(k => k.includes(takeSha)), takeSha);
	step('Excluded after staging: the staged note JSON uploaded and staging cleared', !!head(bucket, `notes/${failHash}.json`)
		&& stagingSnapshot(dir).notes.length === 0 && stagingSnapshot(dir).attachments === null, String(failHash));
	await waitInvalidations(d.state.distA!);
	const v = await visit(browser, d.baseA, `#/u${await uidOf(ctx, N('Att Fail'))}`);
	try {
		const label = await v.page.waitForSelector('.cpn-attachment-unavailable', { timeout: 30_000 }).then(e => e.textContent()).catch(() => null);
		step('The note shows "Attachment unavailable"', label === 'Attachment unavailable', String(label));
		await ctx.screenshot('11-unavailable');
	} finally { await v.context.close(); }
}

/** 12. Still changing. */
async function scenarioStillChanging(ctx: TestContext, d: Deployed, step: Step): Promise<void> {
	console.log('\n[12] File still changing during queueing');
	fs.mkdirSync(path.join(VAULT_PATH, 'Att-Big'), { recursive: true });
	const p = path.join(VAULT_PATH, 'Att-Big/changing.wav');
	randomFile(p, 24 * MB);
	fs.writeFileSync(path.join(VAULT_PATH, N('Att Changing')), fm([PA]) + '![[Att-Big/changing.wav]]\n');
	await ctx.page.evaluate((ps) => (window as any).__att.waitIndexed(ps), [N('Att Changing'), 'Att-Big/changing.wav']);
	await sleep(1_000);
	const dir = await profileDir(ctx, PA);
	const snapBefore = JSON.stringify(stagingSnapshot(dir));
	const histBefore = JSON.stringify(await ctx.page.evaluate((id) => (window as any).__att.history(id), PA));
	const writer = setInterval(() => fs.appendFileSync(p, crypto.randomBytes(4096)), 5);
	const mark = await noticeMark(ctx);
	try {
		await publish(ctx, [N('Att Changing')], PA);
	} finally {
		clearInterval(writer);
	}
	const n = await noticesSince(ctx, mark);
	step('"still changing" abort notice', n.includes('changing.wav is still changing. Publish again when it is saved.'), JSON.stringify(n));
	step('Abort commits nothing (history unchanged)', JSON.stringify(await ctx.page.evaluate((id) => (window as any).__att.history(id), PA)) === histBefore, '');
	step('Abort leaves staging untouched', JSON.stringify(stagingSnapshot(dir)) === snapBefore, snapBefore);
	step('Abort uploads nothing', !s3Keys(d.state.bucketA!).some(k => k.endsWith('/changing.wav')), '');
}

/** 13. Overwrite during a multipart upload. */
async function scenarioRace(ctx: TestContext, d: Deployed, step: Step): Promise<void> {
	console.log('\n[13] Large file overwritten while it uploads');
	const p = path.join(VAULT_PATH, 'Att-Big/race.mp4');
	randomFile(p, 120 * MB);
	fs.writeFileSync(path.join(VAULT_PATH, N('Att Race')), fm([PA]) + '![[Att-Big/race.mp4]]\n');
	await ctx.page.evaluate((ps) => (window as any).__att.waitIndexed(ps), [N('Att Race'), 'Att-Big/race.mp4']);
	await sleep(1_000);
	const sha = sha256File(p);
	const mark = await noticeMark(ctx);
	await ctx.page.evaluate((path) => {
		const att = (window as any).__att;
		att.race = att.publish([path], 'att-pub', false, true).then(() => 'done', (e: unknown) => String(e));
	}, N('Att Race'));
	let overwritten = false;
	for (let i = 0; i < 600 && !overwritten; i++) {
		if (multipartUploads(d.state.bucketA!, `attachments/${sha}/`).length > 0) {
			randomFile(p, 120 * MB);
			overwritten = true;
		} else await sleep(500);
	}
	await ctx.page.evaluate(() => (window as any).__att.race);
	const n = await noticesSince(ctx, mark);
	step('Race: overwrite landed during the multipart upload', overwritten, '');
	step('Race: "changed while publishing" notice', n.includes('race.mp4 changed while publishing. Publish the notes that use it again.'), JSON.stringify(n));
	step('Race: no object under the key', !head(d.state.bucketA!, `attachments/${sha}/race.mp4`), sha);
	step('Race: multipart upload aborted (none left)', multipartUploads(d.state.bucketA!).length === 0, JSON.stringify(multipartUploads(d.state.bucketA!)));
}

/** 14. A file near the cap; the next publish drops the race entry. */
async function scenarioMemory(ctx: TestContext, d: Deployed, step: Step): Promise<void> {
	console.log('\n[14] File near the cap: memory');
	const size = 300 * MB;
	const p = path.join(VAULT_PATH, 'Att-Big/big.mp4');
	randomFile(p, size);
	fs.writeFileSync(path.join(VAULT_PATH, N('Att Big')), fm([PA]) + '![[Att-Big/big.mp4]]\n');
	await ctx.page.evaluate((ps) => (window as any).__att.waitIndexed(ps), [N('Att Big'), 'Att-Big/big.mp4']);
	await sleep(1_000);
	const sha = sha256File(p);
	const mark = await noticeMark(ctx);
	const mem = await ctx.page.evaluate(async (path) => {
		const att = (window as any).__att;
		const proc = (globalThis as any).process;
		const rss = () => proc.memoryUsage().rss as number;
		const base = rss();
		let peak = base;
		const timer = setInterval(() => { peak = Math.max(peak, rss()); }, 100);
		const t0 = Date.now();
		try {
			await att.publish([path], 'att-pub', false, false);
		} finally {
			clearInterval(timer);
		}
		return { base, peak, ms: Date.now() - t0 };
	}, N('Att Big'));
	const n = await noticesSince(ctx, mark);
	const h = head(d.state.bucketA!, `attachments/${sha}/big.mp4`);
	step('Near-cap file uploaded intact', !!h && h.ContentLength === size, `${h?.ContentLength} in ${Math.round(mem.ms / 1000)} s`);
	const growth = (mem.peak - mem.base) / MB;
	step('Renderer memory stays near the in-flight parts, not the file size', growth < 150, `rss growth ${growth.toFixed(1)} MB for a ${size / MB} MB file`);
	step('Next publish drops the earlier batch\'s changed entry (race.mp4) instead of stopping',
		n.some(t => t.includes('race.mp4')) && !n.some(t => t.includes('changed while publishing')) && n.some(t => t.startsWith('Successfully published')), JSON.stringify(n));
}

/** 15. Session expiry. */
async function scenarioSessionExpiry(ctx: TestContext, d: Deployed, step: Step, browser: PwBrowser): Promise<void> {
	console.log('\n[15] Session expiry on a whole-site gate (B) and on a public site with groups (A)');
	await publish(ctx, [N('Att Gate Song')], PB);
	await waitInvalidations(d.state.distB!);
	const uidB = await uidOf(ctx, N('Att Gate Song'));
	const sha = sha256File(path.join(VAULT_PATH, 'Att-Media/long.wav'));
	const token = idToken(d.pool.UserPoolId, d.pool.UserPoolClientId, B_READER);

	/** Clear the cookie, then make the player fetch bytes it doesn't have. */
	const expire = async (v: Visit, selector: string) => {
		await v.context.clearCookies();
		const navBefore = v.navigations.length;
		await v.page.evaluate(async (selector) => {
			const a = document.querySelector(selector) as HTMLAudioElement;
			a.currentTime = a.duration * 0.9;
			a.play().catch(() => {});
		}, selector);
		let label = await v.page.waitForSelector('.cpn-attachment-unavailable', { timeout: 20_000 }).catch(() => null);
		let how = 'seek';
		if (!label) {
			// The browser kept the bytes; force a fresh fetch of the resource.
			how = 'reload resource';
			await v.page.evaluate((selector) => {
				const a = document.querySelector(selector) as HTMLAudioElement;
				a.src = a.getAttribute('src') + '?expired';
			}, selector);
			label = await v.page.waitForSelector('.cpn-attachment-unavailable', { timeout: 20_000 }).catch(() => null);
		}
		await sleep(2_000);
		const route = await v.page.evaluate(() => location.pathname + location.search + location.hash);
		return {
			route,
			text: label ? await label.textContent() : null,
			href: label ? await label.evaluate(l => l.querySelector('a')?.getAttribute('href') ?? null) : null,
			reloaded: v.navigations.length !== navBefore,
			how,
		};
	};

	const v = await visit(browser, d.baseB, `#/u${uidB}`, token);
	try {
		const sel = 'audio[data-cpn-attachment$="/long.wav"]';
		const m = await mediaState(v.page, sel);
		step('Gate B: signed-in reader plays the file', m.src === `/attachments/${sha}/long.wav` && m.readyState >= 1 && m.error === null, JSON.stringify(m));
		const r = await expire(v, sel);
		step('Gate B: expired session → "Your session has ended. Sign in again to play this."', r.text === 'Your session has ended. Sign in again to play this.',
			`${r.text} (via ${r.how})`);
		step('Gate B: the page doesn\'t reload by itself', !r.reloaded, JSON.stringify(v.navigations));
		const href = r.href ? new URL(r.href) : null;
		const stateParam = href?.searchParams.get('state') ?? '';
		step('Gate B: the link is the Hosted UI with the note route as state', !!href && href.origin === d.pool.HostedUiDomain && href.pathname === '/oauth2/authorize'
			&& href.searchParams.get('redirect_uri') === `${d.baseB}/auth/callback` && stateParam === r.route && stateParam.endsWith(`/u${uidB}`),
			`${r.href} (route ${r.route})`);
		await ctx.screenshot('15-expired');

		// Through sign-in and back: the same authorize URL with native sign-in
		// (Google itself needs a real account).
		if (href) {
			href.searchParams.set('identity_provider', 'COGNITO');
			await v.page.goto(href.toString());
			await v.page.locator('input[name="username"]:visible').first().fill(B_READER);
			await v.page.locator('input[name="password"]:visible').first().fill(PASSWORD);
			await Promise.all([
				v.page.waitForURL(u => u.toString().startsWith(d.baseB) && !u.pathname.startsWith('/auth/'), { timeout: 30_000 }).catch(() => null),
				v.page.locator('input[name="signInSubmitButton"]:visible, button[name="signInSubmitButton"]:visible').first().click(),
			]);
			const back = await mediaState(v.page, sel);
			step('Gate B: sign-in through the link lands back on the note and plays', v.page.url() === `${d.baseB}${r.route}` && back.readyState >= 1 && back.error === null,
				`${v.page.url()} ${JSON.stringify(back)}`);
		}
	} finally {
		await v.context.close();
	}

	const tokenA = idToken(d.pool.UserPoolId, d.pool.UserPoolClientId, G2_READER);
	const uidA = await uidOf(ctx, N('Att Gated Song'));
	const a = await visit(browser, d.baseA, `#/u${uidA}`, tokenA);
	try {
		const sel = 'audio[data-cpn-attachment$="/long.wav"]';
		const m = await mediaState(a.page, sel);
		step('Site A: g2 member plays the gated recording', m.src === `/restricted/g2/attachments/${sha}/long.wav` && m.readyState >= 1, JSON.stringify(m));
		const r = await expire(a, sel);
		step('Site A: signed out on a gated note → "Sign in again to play this"', r.text === 'Sign in again to play this'
			&& !!r.href && r.href.startsWith(`${d.pool.HostedUiDomain}/oauth2/authorize`) && !r.reloaded, `${r.text} ${r.href} (via ${r.how})`);
	} finally {
		await a.context.close();
	}
}

/** 16. Show PDFs inline. */
async function scenarioInlinePdf(ctx: TestContext, d: Deployed, step: Step, browser: PwBrowser): Promise<void> {
	console.log('\n[16] Show PDFs inline: frames, fallback link, gated frame, signed-out frame');
	const setInline = (on: boolean) => ctx.page.evaluate(async ({ id, on }) => {
		const att = (window as any).__att;
		const p = att.profile(id);
		p.attachments = { ...p.attachments, inlinePdfs: on };
		await att.plugin().saveSettings();
	}, { id: PA, on });
	const docs = N('Att Docs');
	const gated = N('Att Gated Pdf');
	await publish(ctx, [docs, gated], PA);
	const before = [await latest(ctx, PA, docs), await latest(ctx, PA, gated)];
	await setInline(true);
	try {
		await publish(ctx, [docs, gated], PA);
		await waitInvalidations(d.state.distA!);
		const after = [await latest(ctx, PA, docs), await latest(ctx, PA, gated)];
		step('Toggling Show PDFs inline keeps note hashes (republish rewrites in place)', !!before[0] && !!before[1]
			&& before[0] === after[0] && before[1] === after[1], `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

		const pdfSha = sha256File(path.join(VAULT_PATH, 'Att-Media/slides.pdf'));
		const frameUrl = `${d.baseA}/attachments/${pdfSha}/slides.pdf`;
		const v = await visit(browser, d.baseA, `#/u${await uidOf(ctx, docs)}`);
		try {
			const frameNav = v.page.waitForResponse(r => r.url() === frameUrl && r.request().isNavigationRequest()
				&& r.frame() !== v.page.mainFrame(), { timeout: 30_000 }).catch(() => null);
			await v.page.waitForSelector('iframe.cpn-attachment-pdf[src]', { timeout: 30_000 });
			const dom = await v.page.evaluate(() => {
				const frames = Array.from(document.querySelectorAll('iframe.cpn-attachment-pdf'));
				const fallback = document.querySelector('.cpn-attachment-pdf-embed a.cpn-attachment-file');
				const plain = Array.from(document.querySelectorAll('a.cpn-attachment-file'))
					.filter(a => !a.closest('.cpn-attachment-pdf-embed') && /\/slides\.pdf$/.test(a.getAttribute('href') || ''));
				const f = frames[0] as HTMLIFrameElement | undefined;
				return {
					frames: frames.length, src: f?.getAttribute('src'), title: f?.getAttribute('title'),
					height: f ? f.getBoundingClientRect().height : 0, width: f ? f.getBoundingClientRect().width : 0,
					fallback: fallback ? { href: fallback.getAttribute('href'), target: fallback.getAttribute('target'), text: fallback.textContent } : null,
					plain: plain.length,
				};
			});
			step('PDF embed is a frame on the file with #page kept', dom.frames === 1 && dom.src === `/attachments/${pdfSha}/slides.pdf#page=2`
				&& dom.title === 'slides.pdf' && dom.width > 0 && dom.height > 200, JSON.stringify(dom));
			const nav = await frameNav;
			step('The frame loads the PDF (200 application/pdf)', !!nav && nav.status() === 200 && nav.headers()['content-type'] === 'application/pdf',
				nav ? `${nav.status()} ${nav.headers()['content-type']}` : 'no frame navigation');
			step('New-tab fallback link under the frame', dom.fallback?.href === `/attachments/${pdfSha}/slides.pdf#page=2`
				&& dom.fallback?.target === '_blank' && dom.fallback?.text === 'slides.pdf', JSON.stringify(dom.fallback));
			step('[[slides.pdf]] stays a plain new-tab link', dom.plain === 1, JSON.stringify(dom));
			await ctx.screenshot('16-inline-pdf');
		} finally {
			await v.context.close();
		}

		const gSha = sha256File(path.join(VAULT_PATH, 'Att-Media/gated.pdf'));
		const token = idToken(d.pool.UserPoolId, d.pool.UserPoolClientId, G2_READER);
		const g = await visit(browser, d.baseA, `#/u${await uidOf(ctx, gated)}`, token);
		try {
			await g.page.waitForSelector('iframe.cpn-attachment-pdf[src]', { timeout: 30_000 });
			const src = await g.page.getAttribute('iframe.cpn-attachment-pdf', 'src');
			step('g2 member: gated PDF frame loads from restricted/g2/attachments/', src === `/restricted/g2/attachments/${gSha}/gated.pdf`, String(src));
			// Signed out before a frame loads: hydrate a fresh copy of the frame.
			await g.context.clearCookies();
			await g.page.evaluate(() => {
				const box = document.createElement('div');
				box.id = 'cpn-e2e-frame';
				const f = document.querySelector('iframe.cpn-attachment-pdf')!.cloneNode() as HTMLIFrameElement;
				f.removeAttribute('src');
				f.removeAttribute('data-cpn-att');
				delete f.dataset.cpnAttState;
				box.appendChild(f);
				document.body.appendChild(box);
				(window as any).hydrateAttachments(box, 'restricted/g2/');
			});
			await g.page.waitForSelector('#cpn-e2e-frame .cpn-attachment-unavailable', { timeout: 20_000 }).catch(() => null);
			const out = await g.page.evaluate(() => {
				const f = document.querySelector('#cpn-e2e-frame iframe') as HTMLIFrameElement;
				const l = document.querySelector('#cpn-e2e-frame .cpn-attachment-unavailable');
				return { src: f.getAttribute('src'), hidden: f.hidden, text: l?.textContent ?? null, href: l?.querySelector('a')?.getAttribute('href') ?? null };
			});
			step('Signed out: frame gets no src, "Sign in again to view this"', out.src === null && out.hidden && out.text === 'Sign in again to view this'
				&& !!out.href && out.href.startsWith(`${d.pool.HostedUiDomain}/oauth2/authorize`), JSON.stringify(out));
		} finally {
			await g.context.close();
		}
	} finally {
		await setInline(false);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function live(ctx: TestContext): Promise<void> {
	const step: Step = (name, cond, detail) => (cond ? ctx.pass(name, detail) : ctx.fail(name, detail));
	await ctx.page.evaluate(INSTALL);
	const d = process.argv.includes('--reuse') ? await reuse(ctx, step) : await deploy(ctx, step);
	if (!d) return;
	// Freshly created distributions can take a few minutes to serve.
	for (const base of [d.baseA, d.baseB]) {
		for (let i = 0; i < 60; i++) {
			const r = await fetch(`${base}/config.json`).catch(() => null);
			if (r && r.status !== 0 && r.status < 500) break;
			await sleep(10_000);
		}
	}
	const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
	const scenarios: Array<[string, () => Promise<void>]> = [
		['1 lock + publish all', () => scenarioLockAndPublishAll(ctx, d, step)],
		['2 play + seek', () => scenarioPlayAndSeek(ctx, d, step, browser)],
		['3 documents', () => scenarioDocs(ctx, d, step, browser)],
		['4/5 groups', () => scenarioGroups(ctx, d, step, browser)],
		['6 excluded', () => scenarioExcluded(ctx, d, step)],
		['7 multipart', () => scenarioMultipart(ctx, d, step, browser)],
		['8 replace', () => scenarioReplace(ctx, d, step, browser)],
		['9 tag edit', () => scenarioTagEdit(ctx, d, step, browser)],
		['10 mode off', () => scenarioModeOff(ctx, d, step)],
		['11 failed batch', () => scenarioFailedBatch(ctx, d, step, browser)],
		['12 still changing', () => scenarioStillChanging(ctx, d, step)],
		['13 race', () => scenarioRace(ctx, d, step)],
		['14 memory', () => scenarioMemory(ctx, d, step)],
		['15 session expiry', () => scenarioSessionExpiry(ctx, d, step, browser)],
		['16 inline pdf', () => scenarioInlinePdf(ctx, d, step, browser)],
	];
	try {
		for (const [name, run] of scenarios) {
			try {
				await run();
			} catch (err) {
				ctx.fail(`Scenario ${name}`, `aborted: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
			}
		}
	} finally {
		await browser.close();
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
	const profileDirs = [PA, PB, PC].map(id => `.obsidian/plugins/${PLUGIN_ID}/profiles/${id}`);
	runTest({
		name: 'attachments-live',
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
