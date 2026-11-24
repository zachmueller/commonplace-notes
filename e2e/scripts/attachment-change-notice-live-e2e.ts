#!/usr/bin/env npx tsx
/**
 * Attachment change notice (phase 4) — LIVE AWS end-to-end test (opt-in, creates a real bucket)
 *
 * The sandbox check from specs/attachment-publishing/phase-4-change-notice.md
 * §2 ("End-to-end"), driven through a running Obsidian: real vault `modify`
 * events, the real Notice and its button, the real publisher and S3.
 *
 * Creates one plain S3 bucket. Two profiles publish to it under their own
 * prefixes (A: root, B: `two/`); no CloudFront is needed, the checks read the
 * bucket directly.
 *
 * Scenarios:
 *   1. Publish: A publishes Song + Other (both embed song.mp3) and Unrelated
 *      (embeds other.mp3); B publishes Song.
 *   2. song.mp3 rewritten three times within ~2 s: after the 5 s debounce,
 *      exactly one notice per profile, naming the profile and counting its
 *      notes ("2 published notes in Chg A use it.", "1 published note in Chg B
 *      uses it."); no notice for other.mp3.
 *   3. Republish them on A's notice while A is publishing (Unrelated): the busy
 *      notice shows, A's change notice stays open, no new revision.
 *   4. Republish them on A's notice once A is free: exactly Song and Other
 *      publish on A, each records a new revision whose note JSON lists the new
 *      song.mp3 bytes, the object at attachments/<new sha>/song.mp3 holds the
 *      new bytes, the old revision still lists the old bytes; B publishes
 *      nothing and its notice stays open.
 *   5. song.mp3 rewritten with identical bytes: no notice for A (it published
 *      them); B still gets one.
 *   6. B's mode set to off, song.mp3 given new bytes: A gets a notice, B none.
 *   7. No plugin errors were logged.
 *
 * Usage (sandbox account only):
 *   CPN_LIVE_AWS_PROFILE=random npx tsx e2e/scripts/attachment-change-notice-live-e2e.ts
 *   CPN_LIVE_AWS_PROFILE=random npx tsx e2e/scripts/attachment-change-notice-live-e2e.ts --teardown
 *
 * The bucket is deleted at the end of a run; --teardown deletes one a crashed
 * run left behind (its name is in e2e/results/attachment-change-notice-live-state.json).
 * The test vault's plugin data.json is snapshotted and restored.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { runTest, type TestContext } from '../lib/test-harness';
import { VAULT_PATH, RESULTS_DIR, PLUGIN_ID } from '../lib/test-helpers';
import { LIVE_AWS_PROFILE as AWS_PROFILE, LIVE_REGION as REGION, aws, mp3, newUid, s3Json, s3Keys, sha256File, sleep } from '../lib/live-aws';

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const STATE_PATH = path.join(RESULTS_DIR, 'attachment-change-notice-live-state.json');
const PLUGIN_DIR = path.join(VAULT_PATH, '.obsidian', 'plugins', PLUGIN_ID);
const DATA_JSON = path.join(PLUGIN_DIR, 'data.json');
const PA = 'chg-a';
const PB = 'chg-b';
const PB_PREFIX = 'two/';
const DEFAULT_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'mp4', 'm4v', 'webm', 'mov', 'pdf'];
const FIXTURE_ROOTS = ['Chg-Notes', 'Chg-Media'];
const SONG = path.join(VAULT_PATH, 'Chg-Media', 'song.mp3');
/** Debounce (5 s) plus Obsidian's file-watcher delay and the hash. */
const NOTICE_WAIT_MS = 9_000;

interface NoteDef { contexts: string[]; body: string; uid: string }
const NOTES: Record<string, NoteDef> = {
	'Chg-Notes/Chg Song.md': { contexts: [PA, PB], body: 'Listen: ![[Chg-Media/song.mp3]]\n', uid: newUid() },
	'Chg-Notes/Chg Other.md': { contexts: [PA], body: 'Also: ![[Chg-Media/song.mp3]]\n', uid: newUid() },
	'Chg-Notes/Chg Unrelated.md': { contexts: [PA], body: 'Different: ![[Chg-Media/other.mp3]]\n', uid: newUid() },
};
const N = (name: string) => `Chg-Notes/${name}.md`;

interface LiveState { bucket?: string }

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function setupVault(vaultPath: string): void {
	const at = (p: string) => {
		const full = path.join(vaultPath, p);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		return full;
	};
	for (const [p, def] of Object.entries(NOTES)) {
		fs.writeFileSync(at(p), `---\ncpn-uid: ${def.uid}\ncpn-publish-contexts:\n${def.contexts.map(c => `  - ${c}`).join('\n')}\n---\n${def.body}`);
	}
	mp3(at('Chg-Media/song.mp3'), 440, 2, 'Chg song v1');
	mp3(at('Chg-Media/other.mp3'), 660, 2, 'Chg other');
}

/** Replace song.mp3's bytes in place (as an external tag editor or DAW would). */
function rewriteSong(freq: number, title: string): void {
	const tmp = path.join(path.dirname(SONG), '.song-tmp.mp3');
	mp3(tmp, freq, 2, title);
	fs.writeFileSync(SONG, fs.readFileSync(tmp));
	fs.rmSync(tmp);
}

const INSTALL = `
window.__name = (f) => f;
window.__chg = {
	plugin() { return app.plugins.plugins['${PLUGIN_ID}']; },
	profile(id) { return this.plugin().settings.publishingProfiles.find((p) => p.id === id); },
	file(p) { return app.vault.getAbstractFileByPath(p); },
	notices: [],
	async publish(paths, id) {
		const files = paths.map((p) => this.file(p));
		if (files.some((f) => !f)) throw new Error('missing file in ' + JSON.stringify(paths));
		await this.plugin().publisher.publishNotes(files, this.profile(id), false, false);
	},
	async history(id) {
		const p = this.plugin().profileManager.getPublishHistoryPath(id);
		return (await app.vault.adapter.exists(p)) ? JSON.parse(await app.vault.adapter.read(p)) : {};
	},
	uid(p) { return this.plugin().frontmatterManager.peekNoteUID(this.file(p)); },
	async revisions(id, p) { return (await this.history(id))[this.uid(p)] || []; },
	async waitIndexed(paths) {
		for (let i = 0; i < 100; i++) {
			if (paths.every((p) => { const f = this.file(p); return f && app.metadataCache.getFileCache(f); })) return true;
			await new Promise((r) => setTimeout(r, 200));
		}
		return false;
	},
	/** Change notices on screen (text). */
	openChangeNotices() {
		return [...document.querySelectorAll('.notice')].map((n) => (n.textContent || '').trim()).filter((t) => t.includes(' changed. '));
	},
	changeNotice(profileName) {
		return [...document.querySelectorAll('.notice')].find((n) => (n.textContent || '').includes(' changed. ') && (n.textContent || '').includes(' in ' + profileName + ' '));
	},
	hideChangeNotices() {
		for (const n of document.querySelectorAll('.notice')) if ((n.textContent || '').includes(' changed. ')) n.remove();
	},
};
(() => {
	const seen = new WeakMap();
	const rec = () => {
		for (const n of document.querySelectorAll('.notice')) {
			const t = (n.textContent || '').trim();
			let texts = seen.get(n);
			if (!texts) { texts = new Set(); seen.set(n, texts); }
			if (t && !texts.has(t)) { texts.add(t); window.__chg.notices.push(t); }
		}
	};
	new MutationObserver(rec).observe(document.body, { childList: true, subtree: true, characterData: true });
})();
`;

type Step = (name: string, cond: boolean, detail: string) => void;

async function noticeMark(ctx: TestContext): Promise<number> {
	return ctx.page.evaluate(() => (window as any).__chg.notices.length);
}
async function noticesSince(ctx: TestContext, mark: number): Promise<string[]> {
	return ctx.page.evaluate((m) => (window as any).__chg.notices.slice(m), mark);
}
const changeNotices = (notices: string[]) => notices.filter(t => t.includes(' changed. '));
async function publish(ctx: TestContext, paths: string[], id: string): Promise<string[]> {
	const mark = await noticeMark(ctx);
	await ctx.page.evaluate(({ paths, id }) => (window as any).__chg.publish(paths, id), { paths, id });
	return noticesSince(ctx, mark);
}
async function revisions(ctx: TestContext, id: string, p: string): Promise<string[]> {
	return ctx.page.evaluate(({ id, p }) => (window as any).__chg.revisions(id, p), { id, p });
}
async function hideChangeNotices(ctx: TestContext): Promise<void> {
	await ctx.page.evaluate(() => (window as any).__chg.hideChangeNotices());
}

const awsSettings = (bucketName: string, accountId: string, s3Prefix = '') => ({
	awsProfile: AWS_PROFILE, region: REGION, bucketName, s3Prefix, awsAccountId: accountId,
	cloudFrontDistributionId: '', cloudFrontInvalidationScheme: 'manual', credentialMode: 'sdk',
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

function saveState(s: LiveState): void {
	fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
	fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function deleteBucket(bucket: string): void {
	aws(['s3', 'rb', `s3://${bucket}`, '--force'], { json: false, allowFail: true });
}

/** The note JSON of one revision, from the profile's area. */
const noteJson = (bucket: string, prefix: string, hash: string) => s3Json(bucket, `${prefix}notes/${hash}.json`);
const songKeyIn = (json: any): string | undefined =>
	(json?.attachments as Array<{ key: string; name: string }> | undefined)?.find(a => a.name === 'song.mp3')?.key;

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface Run { bucket: string; v1Sha: string; before: Record<string, string[]> }

/** 1. Initial publishes. */
async function scenarioPublish(ctx: TestContext, bucket: string, accountId: string, step: Step): Promise<Run | null> {
	console.log('\n[1] Initial publishes');
	await putProfile(ctx, {
		id: PA, name: 'Chg A', publishMechanism: 'AWS', awsSettings: awsSettings(bucket, accountId),
		baseUrl: 'https://chg-a.invalid', isPublic: true, publishContentIndex: false, excludedDirectories: [],
		obscureRawAttachments: true, attachments: { mode: 'embeds', allowedExtensions: [...DEFAULT_EXTS], maxFileSizeMB: 50 },
	});
	await putProfile(ctx, {
		id: PB, name: 'Chg B', publishMechanism: 'AWS', awsSettings: awsSettings(bucket, accountId, PB_PREFIX),
		baseUrl: 'https://chg-b.invalid', isPublic: true, publishContentIndex: false, excludedDirectories: [],
		obscureRawAttachments: true, attachments: { mode: 'embeds', allowedExtensions: [...DEFAULT_EXTS], maxFileSizeMB: 50 },
	});
	const indexed = await ctx.page.evaluate((ps) => (window as any).__chg.waitIndexed(ps), Object.keys(NOTES));
	if (!indexed) { ctx.fail('Publish: fixtures indexed', 'metadata cache never indexed the notes'); return null; }

	const a = await publish(ctx, [N('Chg Song'), N('Chg Other'), N('Chg Unrelated')], PA);
	const b = await publish(ctx, [N('Chg Song')], PB);
	const v1Sha = sha256File(SONG);
	const keys = s3Keys(bucket);
	step('Publish: A (3 notes) and B (1 note) succeed',
		a.some(t => t.includes('Successfully published 3 note(s)')) && b.some(t => t.includes('Successfully published 1 note(s)')),
		JSON.stringify([...a, ...b]));
	step('Publish: song.mp3 uploaded to both areas',
		keys.includes(`attachments/${v1Sha}/song.mp3`) && keys.includes(`${PB_PREFIX}attachments/${v1Sha}/song.mp3`), `${keys.length} keys`);
	const before: Record<string, string[]> = {};
	for (const [id, n] of [[PA, 'Chg Song'], [PA, 'Chg Other'], [PA, 'Chg Unrelated'], [PB, 'Chg Song']]) {
		before[`${id}:${n}`] = await revisions(ctx, id, N(n));
	}
	step('Publish: each note has one revision', Object.values(before).every(r => r.length === 1), JSON.stringify(before));
	return { bucket, v1Sha, before };
}

/** 2. Several writes → one notice per profile. */
async function scenarioNotice(ctx: TestContext, run: Run, step: Step): Promise<string> {
	console.log('\n[2] song.mp3 rewritten three times');
	const mark = await noticeMark(ctx);
	rewriteSong(523, 'Chg song v2a');
	await sleep(800);
	rewriteSong(587, 'Chg song v2b');
	await sleep(800);
	rewriteSong(659, 'Chg song v2');
	const v2Sha = sha256File(SONG);
	await sleep(NOTICE_WAIT_MS);
	const got = changeNotices(await noticesSince(ctx, mark));
	await ctx.screenshot('change-notices');
	step('Notice: exactly one notice per profile after three writes', got.length === 2, JSON.stringify(got));
	step('Notice: A named, counting both notes',
		got.some(t => t.startsWith('song.mp3 changed. 2 published notes in Chg A use it.')), JSON.stringify(got));
	step('Notice: B named, counting its one note',
		got.some(t => t.startsWith('song.mp3 changed. 1 published note in Chg B uses it.')), JSON.stringify(got));
	const buttons = await ctx.page.evaluate(() => [...document.querySelectorAll('.notice button')].map(b => b.textContent));
	step('Notice: each carries a Republish them button', buttons.filter(t => t === 'Republish them').length === 2, JSON.stringify(buttons));
	step('Notice: none for other.mp3', !got.some(t => t.includes('other.mp3')), JSON.stringify(got));
	step('Notice: v2 bytes differ from v1', v2Sha !== run.v1Sha, v2Sha);
	return v2Sha;
}

/** 3. Republish refused while A is publishing. */
async function scenarioRefused(ctx: TestContext, run: Run, step: Step): Promise<void> {
	console.log('\n[3] Republish them while A is publishing');
	const mark = await noticeMark(ctx);
	// One synchronous evaluate: the publish takes A's lock before its first
	// await, so the click lands while it is held.
	const clicked = await ctx.page.evaluate(() => {
		const c = (window as any).__chg;
		(window as any).__chgRunning = c.publish(['Chg-Notes/Chg Unrelated.md'], 'chg-a');
		const btn = c.changeNotice('Chg A')?.querySelector('button');
		if (!btn) return false;
		btn.click();
		return true;
	});
	await sleep(300);
	const stillOpen = await ctx.page.evaluate(() => !!(window as any).__chg.changeNotice('Chg A'));
	await ctx.page.evaluate(() => (window as any).__chgRunning);
	const seen = await noticesSince(ctx, mark);
	await ctx.screenshot('republish-refused');
	step('Refused: the button was clicked during the publish', clicked, '');
	step('Refused: busy notice shown', seen.some(t => t.includes('Chg A is busy (publishing). Try again when it finishes.')), JSON.stringify(seen));
	step('Refused: the change notice stays open', stillOpen, '');
	const song = await revisions(ctx, PA, N('Chg Song'));
	const other = await revisions(ctx, PA, N('Chg Other'));
	step('Refused: Song and Other recorded no revision', song.length === 1 && other.length === 1, JSON.stringify({ song, other }));
	step('Refused: only the running publish (1 note) published', seen.filter(t => t.includes('Successfully published')).every(t => t.includes('1 note(s)')), JSON.stringify(seen));
}

/** 4. Republish them on A. */
async function scenarioRepublish(ctx: TestContext, run: Run, v2Sha: string, step: Step): Promise<void> {
	console.log('\n[4] Republish them on A');
	const mark = await noticeMark(ctx);
	const notice = ctx.page.locator('.notice', { hasText: 'in Chg A use it' });
	await notice.locator('button', { hasText: 'Republish them' }).click();
	let seen: string[] = [];
	for (let i = 0; i < 120; i++) {
		seen = await noticesSince(ctx, mark);
		if (seen.some(t => t.includes('Successfully published') || t.includes('Publishing failed') || t.includes('Error during publishing'))) break;
		await sleep(500);
	}
	await ctx.screenshot('republished');
	step('Republish: exactly the two referencing notes publish', seen.some(t => t.includes('Successfully published 2 note(s)')), JSON.stringify(seen));
	const aOpen = await ctx.page.evaluate(() => !!(window as any).__chg.changeNotice('Chg A'));
	const bOpen = await ctx.page.evaluate(() => !!(window as any).__chg.changeNotice('Chg B'));
	step('Republish: A\'s notice closes, B\'s stays open', !aOpen && bOpen, `A ${aOpen} B ${bOpen}`);

	for (const name of ['Chg Song', 'Chg Other']) {
		const revs = await revisions(ctx, PA, N(name));
		const [oldHash] = run.before[`${PA}:${name}`];
		const newHash = revs[revs.length - 1];
		step(`Republish: ${name} records a new revision`, revs.length === 2 && newHash !== oldHash, JSON.stringify(revs));
		if (revs.length !== 2) continue;
		const newJson = noteJson(run.bucket, '', newHash);
		const oldJson = noteJson(run.bucket, '', oldHash);
		step(`Republish: ${name}'s new revision lists the new bytes`, songKeyIn(newJson) === `${v2Sha}/song.mp3`, String(songKeyIn(newJson)));
		step(`Republish: ${name}'s old revision keeps the old bytes`, songKeyIn(oldJson) === `${run.v1Sha}/song.mp3`, String(songKeyIn(oldJson)));
	}
	const dl = path.join(RESULTS_DIR, 'chg-song-download.mp3');
	aws(['s3api', 'get-object', '--bucket', run.bucket, '--key', `attachments/${v2Sha}/song.mp3`, dl], { allowFail: true });
	const dlSha = fs.existsSync(dl) ? sha256File(dl) : null;
	fs.rmSync(dl, { force: true });
	step('Republish: the uploaded object holds the new bytes', dlSha === v2Sha, String(dlSha));
	const unrelated = await revisions(ctx, PA, N('Chg Unrelated'));
	const bSong = await revisions(ctx, PB, N('Chg Song'));
	step('Republish: Unrelated (A) and Song (B) untouched', unrelated.length === 1 && bSong.length === 1, JSON.stringify({ unrelated, bSong }));
}

/** 5. Identical bytes: A already has them. */
async function scenarioSameBytes(ctx: TestContext, step: Step): Promise<void> {
	console.log('\n[5] song.mp3 rewritten with identical bytes');
	await hideChangeNotices(ctx);
	const mark = await noticeMark(ctx);
	fs.writeFileSync(SONG, fs.readFileSync(SONG));
	await sleep(NOTICE_WAIT_MS);
	const got = changeNotices(await noticesSince(ctx, mark));
	step('Same bytes: no notice for A, which published them', !got.some(t => t.includes('Chg A')), JSON.stringify(got));
	step('Same bytes: B, still on the old bytes, gets one', got.length === 1 && got[0].includes('1 published note in Chg B uses it.'), JSON.stringify(got));
}

/** 6. Mode off on B. */
async function scenarioModeOff(ctx: TestContext, step: Step): Promise<void> {
	console.log('\n[6] B mode off, new bytes');
	await hideChangeNotices(ctx);
	await ctx.page.evaluate(async (id) => {
		const c = (window as any).__chg;
		const p = c.profile(id);
		p.attachments = { ...p.attachments, mode: 'off' };
		await c.plugin().saveSettings();
	}, PB);
	const mark = await noticeMark(ctx);
	rewriteSong(784, 'Chg song v3');
	await sleep(NOTICE_WAIT_MS);
	const got = changeNotices(await noticesSince(ctx, mark));
	step('Mode off: A gets a notice', got.some(t => t.startsWith('song.mp3 changed. 2 published notes in Chg A use it.')), JSON.stringify(got));
	step('Mode off: B gets none', !got.some(t => t.includes('Chg B')), JSON.stringify(got));
	await hideChangeNotices(ctx);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function live(ctx: TestContext): Promise<void> {
	const step: Step = (name, cond, detail) => (cond ? ctx.pass(name, detail) : ctx.fail(name, detail));
	await ctx.page.evaluate(INSTALL);
	const accountId = aws(['sts', 'get-caller-identity']).Account as string;
	const bucket = `cpn-chg-${crypto.randomBytes(3).toString('hex')}-${accountId}`;
	saveState({ bucket });
	console.log(`  bucket: ${bucket}`);
	aws(['s3api', 'create-bucket', '--bucket', bucket], { json: false });
	try {
		const run = await scenarioPublish(ctx, bucket, accountId, step);
		if (!run) return;
		const v2Sha = await scenarioNotice(ctx, run, step);
		await scenarioRefused(ctx, run, step);
		await scenarioRepublish(ctx, run, v2Sha, step);
		await scenarioSameBytes(ctx, step);
		await scenarioModeOff(ctx, step);
		const errors = ctx.collector.getLogsByLevel('error').filter(e => e.source === 'plugin');
		step('No plugin errors logged', errors.length === 0, errors.map(e => e.message).join(' | ').slice(0, 500));
	} finally {
		deleteBucket(bucket);
		const gone = aws(['s3api', 'head-bucket', '--bucket', bucket], { allowFail: true }) === null;
		if (gone) fs.rmSync(STATE_PATH, { force: true });
		console.log(gone ? `  bucket ${bucket} deleted` : `  bucket ${bucket} NOT deleted; run --teardown`);
	}
}

if (!AWS_PROFILE) {
	console.error('Set CPN_LIVE_AWS_PROFILE to a sandbox AWS CLI profile to run this live test.');
	process.exit(2);
}

if (process.argv.includes('--teardown')) {
	const state: LiveState = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : {};
	if (state.bucket) deleteBucket(state.bucket);
	fs.rmSync(STATE_PATH, { force: true });
	console.log(state.bucket ? `Deleted ${state.bucket}` : 'Nothing to tear down');
} else {
	const snapshot = fs.readFileSync(DATA_JSON, 'utf8');
	const profileDirs = [PA, PB].map(id => `.obsidian/plugins/${PLUGIN_ID}/profiles/${id}`);
	runTest({
		name: 'attachment-change-notice-live',
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
		}
	});
}
