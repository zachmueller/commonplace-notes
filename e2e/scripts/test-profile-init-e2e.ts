#!/usr/bin/env npx tsx
/**
 * Profile folder setup at layout-ready (startup item 2) E2E test.
 *
 * profileManager.initialize() runs in the background once the layout is ready,
 * not inside onload, and a failure there is caught. Setup (before launch):
 *   - Two extra profiles are added to data.json (restored at the end):
 *     - `e2e-pinit`, whose folder doesn't exist;
 *     - `e2e-pinit-broken`, added last, whose `profiles/<id>` path is a
 *       regular file, so creating its subfolders fails.
 *
 * Scenarios:
 *   1. onload's timing marks have no profileInit step (it left onload).
 *   2. The broken profile's failure didn't stop the plugin: the settings tab
 *      and commands are registered.
 *   3. After layout-ready, `e2e-pinit` has mapping/, staged-notes/,
 *      staged-error/ and publish-history.json (`{}`).
 *
 * Run: npx tsx e2e/scripts/test-profile-init-e2e.ts
 */

import * as fs from "fs";
import * as path from "path";
import { runTest, type TestContext } from "../lib/test-harness";
import { PLUGIN_ID, RESULTS_DIR, VAULT_PATH } from "../lib/test-helpers";

const GOOD = "e2e-pinit";
const BROKEN = "e2e-pinit-broken";
const PLUGIN_DIR = path.join(VAULT_PATH, ".obsidian", "plugins", PLUGIN_ID);
const DATA_JSON = path.join(PLUGIN_DIR, "data.json");
const DATA_BACKUP = path.join(RESULTS_DIR, "profile-init-e2e.data.json.bak");
const PROFILES_DIR = path.join(PLUGIN_DIR, "profiles");

function setupVault(): void {
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	const original = fs.readFileSync(DATA_JSON, "utf8");
	fs.writeFileSync(DATA_BACKUP, original);

	const data = JSON.parse(original);
	const base = data.publishingProfiles[0];
	data.publishingProfiles = data.publishingProfiles.filter((p: any) => p.id !== GOOD && p.id !== BROKEN);
	for (const [id, name] of [[GOOD, "E2E Profile Init"], [BROKEN, "E2E Profile Init Broken"]]) {
		data.publishingProfiles.push({ ...base, id, name, infrastructureState: undefined, cognitoAuth: undefined });
	}
	fs.writeFileSync(DATA_JSON, JSON.stringify(data, null, 2));

	fs.rmSync(path.join(PROFILES_DIR, GOOD), { recursive: true, force: true });
	fs.rmSync(path.join(PROFILES_DIR, BROKEN), { recursive: true, force: true });
	fs.mkdirSync(PROFILES_DIR, { recursive: true });
	fs.writeFileSync(path.join(PROFILES_DIR, BROKEN), "not a folder");
}

async function restoreSettings(ctx: TestContext): Promise<void> {
	const original = fs.readFileSync(DATA_BACKUP, "utf8");
	await ctx.page.evaluate(async ({ pluginId, original }) => {
		const plugin = (window as any).app?.plugins?.plugins?.[pluginId];
		if (!plugin) return;
		plugin.settings = JSON.parse(original);
		await plugin.saveSettings();
	}, { pluginId: PLUGIN_ID, original });
	fs.writeFileSync(DATA_JSON, original);
	fs.rmSync(path.join(PROFILES_DIR, GOOD), { recursive: true, force: true });
	fs.rmSync(path.join(PROFILES_DIR, BROKEN), { recursive: true, force: true });
}

async function testOnloadMarks(ctx: TestContext): Promise<void> {
	const labels: string[] = await ctx.page.evaluate((id) => {
		const t = (window as any).app?.plugins?.plugins?.[id]?.startupTimings;
		return (t?.marks ?? []).map((m: { label: string }) => m.label);
	}, PLUGIN_ID);
	const ok = labels.includes("registration") && labels.includes("layoutWait") && !labels.includes("profileInit");
	if (ok) ctx.pass("profile init left onload", `marks: ${labels.join(", ")}`);
	else ctx.fail("profile init left onload", `marks: ${labels.join(", ")}`);
}

async function testPluginRegistered(ctx: TestContext): Promise<void> {
	const state = await ctx.page.evaluate(async (id) => {
		const app = (window as any).app;
		const plugin = app?.plugins?.plugins?.[id];
		const tabs: { id?: string }[] = app?.setting?.pluginTabs ?? [];
		// The fixture must really make initialize() fail, or this check proves nothing.
		const rejects = await plugin.profileManager.initialize().then(() => false, () => true);
		return {
			initializeRejects: rejects,
			settingTab: tabs.some((t) => t.id === id),
			command: !!app?.commands?.commands?.[`${id}:refresh-credentials`],
		};
	}, PLUGIN_ID);
	if (state.initializeRejects && state.settingTab && state.command) {
		ctx.pass("a failing profile folder doesn't stop onload", "settings tab and commands registered");
	} else {
		ctx.fail("a failing profile folder doesn't stop onload", JSON.stringify(state));
	}
}

async function testFoldersCreated(ctx: TestContext): Promise<void> {
	const dir = path.join(PROFILES_DIR, GOOD);
	const expected = ["mapping", "staged-notes", "staged-error"].map((d) => path.join(dir, d));
	const history = path.join(dir, "publish-history.json");
	const deadline = Date.now() + 10_000;
	const ready = () => expected.every((d) => fs.existsSync(d)) && fs.existsSync(history);
	while (!ready() && Date.now() < deadline) await ctx.page.waitForTimeout(250);
	if (!ready()) {
		ctx.fail("profile folders created after layout-ready", `missing under ${dir}`);
		return;
	}
	const body = fs.readFileSync(history, "utf8").trim();
	if (body === "{}") ctx.pass("profile folders created after layout-ready", "mapping/, staged-notes/, staged-error/, publish-history.json");
	else ctx.fail("profile folders created after layout-ready", `publish-history.json = ${body.slice(0, 80)}`);
}

async function tests(ctx: TestContext): Promise<void> {
	await ctx.page.waitForTimeout(5_000); // plugin init + layout-ready work
	try {
		await testOnloadMarks(ctx);
		await testPluginRegistered(ctx);
		await testFoldersCreated(ctx);
	} finally {
		await restoreSettings(ctx);
	}
}

runTest({ name: "profile-init-e2e", setupVault }, tests);
