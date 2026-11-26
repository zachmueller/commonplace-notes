#!/usr/bin/env npx tsx
/**
 * Layout-ready startup chain (startup item 4) E2E test.
 *
 * Setup (before launch): a temporary profile `e2e-layout` with commenting
 * enabled, a (fake) deployed comment table and a stale feed
 * (`commentsLastRefreshed: 0`). data.json is restored at the end.
 *
 * The plugin is reloaded in-page with the Comments panel open, so its
 * layout-ready chain runs again (layout is already ready). The new instance's
 * DynamoDB client cache is seeded with a fake that records queries, so
 * nothing calls AWS.
 *
 * Scenarios:
 *   1. The chain recorded every step (upgradeExcludedDirs, indicators,
 *      comments, edgeSweep) without waiting on the network.
 *   2. Within the startup delay, the restored stale panel hasn't queried:
 *      neither onOpen nor the chain fetched while starting up.
 *   3. After the delay (5 s), the panel refreshed once and startupSettled is
 *      true.
 *   4. A failing layout step is logged and doesn't stop the next one.
 *
 * Run: npx tsx e2e/scripts/test-layout-ready-e2e.ts
 */

import * as fs from "fs";
import * as path from "path";
import { runTest, type TestContext } from "../lib/test-harness";
import { PLUGIN_ID, RESULTS_DIR, VAULT_PATH } from "../lib/test-helpers";

const PROFILE_ID = "e2e-layout";
const DATA_JSON = path.join(VAULT_PATH, ".obsidian", "plugins", PLUGIN_ID, "data.json");
const DATA_BACKUP = path.join(RESULTS_DIR, "layout-ready-e2e.data.json.bak");
const STARTUP_DELAY_MS = 5_000;

function setupVault(): void {
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	const original = fs.readFileSync(DATA_JSON, "utf8");
	fs.writeFileSync(DATA_BACKUP, original);
	const data = JSON.parse(original);
	const base = data.publishingProfiles[0];
	data.publishingProfiles = data.publishingProfiles.filter((p: any) => p.id !== PROFILE_ID);
	// First, so the Comments panel picks it as its profile.
	data.publishingProfiles.unshift({
		...base,
		id: PROFILE_ID,
		name: "E2E Layout",
		commenting: { enabled: true },
		commentsLastRefreshed: 0,
		cognitoAuth: undefined,
		infrastructureState: {
			status: "deployed",
			useRoute53: false,
			originAccessMethod: "oac",
			comment: {
				stackName: "e2e-layout-comments",
				enabled: true,
				bucketName: "e2e-layout-comments",
				bucketDomainName: "e2e-layout-comments.example.com",
				apiDomain: "comments.e2e-layout.example.com",
				tableName: "e2e-layout-comments",
			},
		},
	});
	data.commentsPanelMode = "recent";
	fs.writeFileSync(DATA_JSON, JSON.stringify(data, null, 2));
}

async function restoreSettings(ctx: TestContext): Promise<void> {
	const original = fs.readFileSync(DATA_BACKUP, "utf8");
	await ctx.page.evaluate(async ({ pluginId, original }) => {
		const app = (window as any).app;
		app.workspace.detachLeavesOfType("cpn-recent-comments");
		const plugin = app?.plugins?.plugins?.[pluginId];
		if (!plugin) return;
		plugin.settings = JSON.parse(original);
		await plugin.saveSettings();
	}, { pluginId: PLUGIN_ID, original });
	fs.writeFileSync(DATA_JSON, original);
}

/**
 * Open the Comments panel, then reload the plugin and seed the new instance's
 * DynamoDB client with a recording fake before its delayed refresh can run.
 * Returns ms since the reload began, measured right after seeding.
 */
async function reloadWithPanelOpen(ctx: TestContext): Promise<number> {
	return ctx.page.evaluate(async ({ id, profileId }) => {
		const w = window as any;
		const app = w.app;
		await app.plugins.plugins[id].activateRecentCommentsView();
		w.__cpnQueries = [] as string[];
		const fake = {
			send: async (cmd: any) => { w.__cpnQueries.push(cmd?.constructor?.name ?? "?"); return { Items: [] }; },
			destroy: () => {},
		};
		const started = performance.now();
		await app.plugins.disablePlugin(id);
		const enabling = app.plugins.enablePlugin(id);
		// Seed as soon as the new instance exists, before onload's layout-ready
		// chain schedules the delayed refresh (5 s away).
		for (let i = 0; i < 200 && !app.plugins.plugins[id]?.awsSdkManager; i++) await new Promise((r) => setTimeout(r, 5));
		app.plugins.plugins[id].awsSdkManager.ddbClients.set(profileId, fake);
		await enabling;
		return performance.now() - started;
	}, { id: PLUGIN_ID, profileId: PROFILE_ID });
}

async function state(ctx: TestContext) {
	return ctx.page.evaluate((id) => {
		const w = window as any;
		const plugin = w.app.plugins.plugins[id];
		return {
			queries: [...(w.__cpnQueries ?? [])] as string[],
			settled: plugin?.startupSettled as boolean,
			panelOpen: w.app.workspace.getLeavesOfType("cpn-recent-comments").length > 0,
			marks: (plugin?.startupTimings?.marks ?? []).map((m: { label: string }) => m.label) as string[],
		};
	}, PLUGIN_ID);
}

async function tests(ctx: TestContext): Promise<void> {
	await ctx.page.waitForTimeout(STARTUP_DELAY_MS + 1_000); // first startup fully settled
	try {
		const reloadMs = await reloadWithPanelOpen(ctx);
		await ctx.page.waitForTimeout(500);
		const early = await state(ctx);

		const steps = ["layout.upgradeExcludedDirs", "layout.indicators", "layout.comments", "layout.edgeSweep"];
		const missing = steps.filter((s) => !early.marks.includes(s));
		if (missing.length === 0) ctx.pass("layout-ready chain ran every step", `reload took ${reloadMs.toFixed(0)} ms`);
		else ctx.fail("layout-ready chain ran every step", `missing: ${missing.join(", ")}; marks: ${early.marks.join(", ")}`);

		if (!early.panelOpen) ctx.fail("stale panel doesn't fetch during startup", "Comments panel not open after reload");
		else if (early.queries.length === 0 && early.settled === false) {
			ctx.pass("stale panel doesn't fetch during startup", "no query, startupSettled false");
		} else ctx.fail("stale panel doesn't fetch during startup", JSON.stringify(early));

		await ctx.page.waitForTimeout(STARTUP_DELAY_MS);
		const late = await state(ctx);
		if (late.settled && late.queries.length === 1) {
			ctx.pass("stale panel refreshes once after the delay", `queries: ${late.queries.join(", ")}`);
		} else ctx.fail("stale panel refreshes once after the delay", JSON.stringify(late));

		const isolation = await ctx.page.evaluate(async (id) => {
			const plugin = (window as any).app.plugins.plugins[id];
			let ranAfter = false;
			await plugin.layoutStep("e2eFailing", () => { throw new Error("e2e boom"); });
			await plugin.layoutStep("e2eAfter", () => { ranAfter = true; });
			const labels = plugin.startupTimings.marks.map((m: { label: string }) => m.label);
			return { ranAfter, marked: labels.includes("layout.e2eFailing") && labels.includes("layout.e2eAfter") };
		}, PLUGIN_ID);
		const logged = ctx.collector.getLogsByLevel("error").some((e) => e.message.includes('Startup step "e2eFailing" failed'));
		if (isolation.ranAfter && isolation.marked && logged) ctx.pass("a failing step is logged and the next still runs", JSON.stringify(isolation));
		else ctx.fail("a failing step is logged and the next still runs", JSON.stringify({ ...isolation, logged }));
	} finally {
		await restoreSettings(ctx);
	}
}

runTest({ name: "layout-ready-e2e", setupVault }, tests);
