#!/usr/bin/env npx tsx
/**
 * Declarative settings — LIVE AWS deploy → destroy through the Settings pages
 * (opt-in, creates real resources; sandbox account only).
 *
 * specs/declarative-settings/design.md (Tests → Regression): drive a real
 * deploy and destroy from the new Infrastructure group and Danger Zone page.
 *
 *   1. A throwaway AWS profile opens as its own settings page; its
 *      Infrastructure group shows "Not deployed" and a Deploy Infrastructure
 *      button.
 *   2. The button opens the wizard; a public site (no custom domain, no
 *      sign-in, so no Lambda@Edge) deploys for real. When the wizard finishes,
 *      the page updates in place: status Deployed, the Stack row appears, and
 *      the Deploy button is hidden. The stack and bucket exist in AWS.
 *   3. Danger Zone → Destroy infrastructure → the confirmation dialog, with
 *      "Also delete S3 data" ticked. While it runs, the live event log fills,
 *      and a forced re-render (settingTab.refresh()) keeps the log and the
 *      busy button. When it finishes, the profile is back to "Not deployed",
 *      and the stack and bucket are gone from AWS.
 *
 * Usage:
 *   CPN_LIVE_AWS_PROFILE=random npx tsx e2e/scripts/settings-deploy-destroy-live-e2e.ts
 *   CPN_LIVE_AWS_PROFILE=random npx tsx e2e/scripts/settings-deploy-destroy-live-e2e.ts --teardown
 *
 * Resource names go to e2e/results/settings-deploy-destroy-live-state.json so
 * a failed run can still be torn down. The test vault's plugin data.json is
 * snapshotted and restored.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { runTest, type TestContext } from '../lib/test-harness';
import { PLUGIN_ID, RESULTS_DIR, SETTINGS_CONTENT, VAULT_PATH, closeSettings, openCpnSettings, openSettingsPage } from '../lib/test-helpers';
import { LIVE_AWS_PROFILE, LIVE_REGION, aws, emptyVersionedBucket, sleep } from '../lib/live-aws';

const STATE_PATH = path.join(RESULTS_DIR, 'settings-deploy-destroy-live-state.json');
const DATA_JSON = path.join(VAULT_PATH, '.obsidian', 'plugins', PLUGIN_ID, 'data.json');
const PROFILE_ID = 'dsl-live';
const PROFILE_NAME = 'DSL Live';
const DEPLOY_TIMEOUT_MS = 30 * 60_000;
const DESTROY_TIMEOUT_MS = 40 * 60_000;

interface LiveState {
	variant: string;
	accountId: string;
	stack: string;
	bucket: string;
}

function saveState(s: LiveState): void {
	fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
	fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function stackStatus(stack: string): string | null {
	const d = aws<{ Stacks?: { StackStatus?: string }[] } | null>(
		['cloudformation', 'describe-stacks', '--stack-name', stack], { allowFail: true });
	return d?.Stacks?.[0]?.StackStatus ?? null;
}

function bucketExists(bucket: string): boolean {
	return aws(['s3api', 'head-bucket', '--bucket', bucket], { allowFail: true }) !== null;
}

function teardown(): void {
	if (!fs.existsSync(STATE_PATH)) {
		console.log('No live state recorded; nothing to tear down.');
		return;
	}
	const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as LiveState;
	if (stackStatus(s.stack)) {
		console.log(`Deleting ${s.stack} (CloudFront deletion can take a while)...`);
		aws(['cloudformation', 'delete-stack', '--stack-name', s.stack], { json: false });
		aws(['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', s.stack], { json: false, allowFail: true });
	}
	if (bucketExists(s.bucket)) {
		console.log(`Removing ${s.bucket}...`);
		emptyVersionedBucket(s.bucket);
		aws(['s3api', 'delete-bucket', '--bucket', s.bucket], { json: false, allowFail: true });
	}
	fs.unlinkSync(STATE_PATH);
	console.log('Teardown complete.');
}

/** Row state on the settings page on screen: visible, description, button text/disabled. */
async function row(ctx: TestContext, name: string) {
	return ctx.page.evaluate(({ root, name }) => {
		// No named function expressions in page.evaluate: tsx wraps them in a
		// `__name` helper the page doesn't have.
		const el = Array.from(document.querySelectorAll(`${root} .setting-item`))
			.find(r => r.querySelector('.setting-item-name')?.textContent?.trim() === name) as HTMLElement | undefined;
		if (!el) return null;
		const btn = el.querySelector('button');
		const log = el.querySelector('.cpn-wizard-event-log');
		return {
			visible: el.offsetParent !== null,
			desc: el.querySelector('.setting-item-description')?.textContent?.trim() ?? '',
			button: btn ? { text: btn.textContent?.trim() ?? '', disabled: btn.disabled } : null,
			logLines: log ? log.querySelectorAll('.cpn-wizard-event-line').length : 0,
		};
	}, { root: SETTINGS_CONTENT, name });
}

async function infraStatus(ctx: TestContext): Promise<string | null> {
	return ctx.page.evaluate((id) => {
		const plugin = (window as any).app.plugins.plugins['commonplace-notes'];
		return plugin.settings.publishingProfiles.find((p: any) => p.id === id)?.infrastructureState?.status ?? null;
	}, PROFILE_ID);
}

async function live(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	const step = (name: string, cond: boolean, detail: string) => (cond ? ctx.pass(name, detail) : ctx.fail(name, detail));

	const accountId = aws<{ Account: string }>(['sts', 'get-caller-identity']).Account;
	const variant = `dsle2e${crypto.randomBytes(3).toString('hex')}`;
	const state: LiveState = { variant, accountId, stack: `cpn-${variant}`, bucket: `published-notes-${accountId}-cpn-${variant}` };
	saveState(state);
	console.log(`  variant: ${variant} (account ${accountId}); stack ${state.stack}, bucket ${state.bucket}`);

	// A fresh AWS profile with no infrastructure.
	await page.evaluate(async ({ id, name, awsProfile, region }) => {
		const plugin = (window as any).app.plugins.plugins['commonplace-notes'];
		const base = plugin.settings.publishingProfiles[0];
		plugin.settings.publishingProfiles = [
			...plugin.settings.publishingProfiles.filter((p: any) => p.id !== id),
			{
				...base, id, name, baseUrl: '', homeNotePath: '', publishMechanism: 'AWS',
				infrastructureState: undefined, readGate: undefined, cognitoAuth: undefined, commenting: undefined,
				chat: undefined, accessGroups: undefined, publicSiteAccessGroups: undefined, pendingEdgeCleanup: undefined,
				awsSettings: {
					awsAccountId: '', awsProfile, region, bucketName: '', s3Prefix: '', cloudFrontDistributionId: '',
					cloudFrontInvalidationScheme: 'manual', credentialMode: 'sdk', credentialRefreshCommands: '', awsCliPath: '',
				},
			},
		];
		await plugin.saveSettings();
		plugin.settingTab.refresh();
	}, { id: PROFILE_ID, name: PROFILE_NAME, awsProfile: LIVE_AWS_PROFILE, region: LIVE_REGION });

	// --- 1. Infrastructure group before deploying --------------------------------
	console.log('\n[1] Profile page: Infrastructure group before deploying');
	await openCpnSettings(page, [PROFILE_NAME]);
	const before = await row(ctx, 'Status');
	const deployRow = await row(ctx, 'Deploy infrastructure');
	step('Status shows Not deployed', before?.desc === 'Not deployed', JSON.stringify(before));
	step('Deploy Infrastructure button shown', !!deployRow?.visible && deployRow.button?.text === 'Deploy Infrastructure', JSON.stringify(deployRow));

	// --- 2. Deploy through the wizard ----------------------------------------------
	console.log('\n[2] Deploy Infrastructure → wizard → real deploy');
	await page.locator(`${SETTINGS_CONTENT} button`, { hasText: 'Deploy Infrastructure' }).click();
	await page.locator('.cpn-wizard-modal').waitFor({ timeout: 10_000 });
	await page.evaluate(({ awsProfile, region, variant }) => {
		const modal = document.querySelector('.cpn-wizard-modal');
		for (const setting of Array.from(modal?.querySelectorAll('.setting-item') ?? [])) {
			const name = setting.querySelector('.setting-item-name')?.textContent?.trim();
			const input = setting.querySelector<HTMLInputElement>("input[type='text']");
			if (!input) continue;
			let value: string | null = null;
			if (name?.includes('AWS Profile')) value = awsProfile;
			else if (name === 'Region') value = region;
			else if (name?.includes('Variant')) value = variant;
			if (value === null) continue;
			input.value = value;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			input.dispatchEvent(new Event('change', { bubbles: true }));
		}
	}, { awsProfile: LIVE_AWS_PROFILE, region: LIVE_REGION, variant });
	await page.waitForTimeout(300);
	await page.locator('.cpn-wizard-modal button', { hasText: /^Next$/ }).click();

	const deployStart = Date.now();
	let completion = '';
	while (Date.now() - deployStart < DEPLOY_TIMEOUT_MS) {
		completion = await page.evaluate(() => document.querySelector('.cpn-wizard-modal')?.textContent ?? 'modal gone');
		if (completion.includes('Deployment Complete') || completion.includes('Error deploying') || completion === 'modal gone') break;
		await sleep(15_000);
		console.log(`  ... deploying (${Math.round((Date.now() - deployStart) / 1000)} s)`);
	}
	const deployed = completion.includes('Deployment Complete');
	step('Wizard deploy completes', deployed, deployed ? `in ${Math.round((Date.now() - deployStart) / 1000)} s` : completion.slice(0, 400));
	if (!deployed) return;
	step('Stack exists in AWS', stackStatus(state.stack) === 'CREATE_COMPLETE', String(stackStatus(state.stack)));
	step('Bucket exists in AWS', bucketExists(state.bucket), state.bucket);

	await page.locator('.cpn-wizard-modal button', { hasText: /^Done$/ }).click().catch(() => {});
	await page.waitForTimeout(1000);
	if (await page.locator('.cpn-wizard-modal').count()) await page.keyboard.press('Escape');
	await page.waitForTimeout(500);

	// The wizard refreshes the tab; the profile page updates in place.
	const after = await row(ctx, 'Status');
	const stackRow = await row(ctx, 'Stack');
	const deployAfter = await row(ctx, 'Deploy infrastructure');
	step('Page updates in place after the wizard', after?.desc === 'Deployed' && !!stackRow?.visible && stackRow.desc.includes(state.stack) && !deployAfter?.visible,
		JSON.stringify({ status: after?.desc, stack: stackRow, deployVisible: deployAfter?.visible }));

	// --- 3. Destroy from the Danger Zone ---------------------------------------------
	console.log('\n[3] Danger Zone → Destroy infrastructure (delete S3 data)');
	await openSettingsPage(page, 'Danger Zone');
	await page.locator(`${SETTINGS_CONTENT} button`, { hasText: 'Destroy infrastructure' }).click();
	// Not the Settings modal, which also contains "Destroy infrastructure".
	const dialog = page.locator('.modal-container .modal:not(.mod-settings)', { hasText: 'Destroy Infrastructure' });
	await dialog.waitFor({ timeout: 10_000 });
	await dialog.locator('input[type=checkbox]').check();
	// Record notices as they appear: they auto-dismiss long before the
	// destroy finishes polling.
	await page.evaluate(() => {
		const w = window as any;
		w.__cpnNotices = [];
		new MutationObserver(() => {
			for (const n of Array.from(document.querySelectorAll('.notice'))) {
				const text = n.textContent ?? '';
				if (!w.__cpnNotices.includes(text)) w.__cpnNotices.push(text);
			}
		}).observe(document.body, { childList: true, subtree: true });
	});
	await dialog.locator('button', { hasText: /^Destroy$/ }).click();

	// Wait for the log to start, then force a re-render mid-operation.
	let during = await row(ctx, 'Destroy infrastructure');
	for (let i = 0; i < 60 && (during?.logLines ?? 0) === 0; i++) {
		await sleep(5_000);
		during = await row(ctx, 'Destroy infrastructure');
	}
	step('Live event log fills while destroying', (during?.logLines ?? 0) > 0 && during?.button?.text === 'Destroying...' && !!during.button.disabled,
		JSON.stringify(during));
	await page.evaluate(() => (window as any).app.plugins.plugins['commonplace-notes'].settingTab.refresh());
	await page.waitForTimeout(500);
	const rerendered = await row(ctx, 'Destroy infrastructure');
	step('Log and busy state survive a re-render', (rerendered?.logLines ?? 0) >= (during?.logLines ?? 1) && rerendered?.button?.text === 'Destroying...' && !!rerendered.button.disabled,
		JSON.stringify(rerendered));

	const destroyStart = Date.now();
	let status = await infraStatus(ctx);
	while (Date.now() - destroyStart < DESTROY_TIMEOUT_MS && status !== 'none' && status !== null && status !== 'failed') {
		await sleep(20_000);
		status = await infraStatus(ctx);
		console.log(`  ... destroying (${Math.round((Date.now() - destroyStart) / 1000)} s, status ${status})`);
	}
	// destroyInfrastructure resets the state once every stack is gone.
	step('Profile back to not deployed', status === 'none' || status === null, `status=${status} after ${Math.round((Date.now() - destroyStart) / 1000)} s`);
	await page.waitForTimeout(1000);
	const notices = await page.evaluate(() => (window as any).__cpnNotices as string[]);
	step('Destroy notice shown', notices.some(n => n.includes('Infrastructure destroyed')), JSON.stringify(notices));
	const destroyRow = await row(ctx, 'Destroy infrastructure');
	step('Destroy row hidden afterwards', !destroyRow?.visible, JSON.stringify(destroyRow));
	step('Stack gone from AWS', stackStatus(state.stack) === null, String(stackStatus(state.stack)));
	step('Bucket gone from AWS', !bucketExists(state.bucket), state.bucket);
	if (stackStatus(state.stack) === null && !bucketExists(state.bucket)) fs.unlinkSync(STATE_PATH);
}

if (!LIVE_AWS_PROFILE) {
	console.error('Set CPN_LIVE_AWS_PROFILE to a sandbox AWS CLI profile to run this live test.');
	process.exit(2);
}
if (LIVE_AWS_PROFILE === 'notes') {
	console.error('Refusing to deploy to the "notes" profile (real site, read-only). Use the sandbox profile.');
	process.exit(2);
}

if (process.argv.includes('--teardown')) {
	teardown();
} else {
	const snapshot = fs.readFileSync(DATA_JSON, 'utf8');
	void runTest({ name: 'settings-deploy-destroy-live', launchTimeout: 60_000 }, async (ctx) => {
		await ctx.page.waitForTimeout(5_000);
		try {
			await live(ctx);
		} catch (err) {
			ctx.fail('Live run', `aborted: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			await closeSettings(ctx.page).catch(() => {});
			await ctx.page.evaluate(async ({ pluginId, snap }) => {
				const plugin = (window as any).app.plugins.plugins[pluginId];
				plugin.settings = JSON.parse(snap);
				await plugin.saveSettings();
			}, { pluginId: PLUGIN_ID, snap: snapshot }).catch(() => {});
			fs.writeFileSync(DATA_JSON, snapshot);
			if (fs.existsSync(STATE_PATH)) {
				console.log(`\n  Live resources recorded in ${STATE_PATH}; run with --teardown to remove them.`);
			}
		}
	});
}
