#!/usr/bin/env npx tsx
/**
 * Malformed profile names in data.json (startup item 5i) E2E test.
 *
 * getSettingDefinitions() runs inside addSettingTab during onload, so a throw
 * there stops the whole plugin loading. Setup (before launch): two extra
 * profiles, one with no `name` and one whose `name` is a number. data.json is
 * restored at the end.
 *
 * Scenarios:
 *   1. The plugin loads: settings tab and commands are registered.
 *   2. The profile list shows both as "Untitled" pages (made unique), next to
 *      the existing profile.
 *
 * Run: npx tsx e2e/scripts/test-malformed-profile-e2e.ts
 */

import * as fs from "fs";
import * as path from "path";
import { runTest, type TestContext } from "../lib/test-harness";
import { PLUGIN_ID, RESULTS_DIR, VAULT_PATH } from "../lib/test-helpers";

const IDS = ["e2e-noname", "e2e-numname"];
const DATA_JSON = path.join(VAULT_PATH, ".obsidian", "plugins", PLUGIN_ID, "data.json");
const DATA_BACKUP = path.join(RESULTS_DIR, "malformed-profile-e2e.data.json.bak");

function setupVault(): void {
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	const original = fs.readFileSync(DATA_JSON, "utf8");
	fs.writeFileSync(DATA_BACKUP, original);
	const data = JSON.parse(original);
	const base = data.publishingProfiles[0];
	data.publishingProfiles = data.publishingProfiles.filter((p: any) => !IDS.includes(p.id));
	const { name: _drop, ...nameless } = { ...base, id: IDS[0], infrastructureState: undefined, cognitoAuth: undefined };
	data.publishingProfiles.push(nameless, { ...base, id: IDS[1], name: 42, infrastructureState: undefined, cognitoAuth: undefined });
	fs.writeFileSync(DATA_JSON, JSON.stringify(data, null, 2));
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
}

async function tests(ctx: TestContext): Promise<void> {
	await ctx.page.waitForTimeout(5_000);
	try {
		const state = await ctx.page.evaluate((id) => {
			const app = (window as any).app;
			const plugin = app?.plugins?.plugins?.[id];
			const tabs: { id?: string }[] = app?.setting?.pluginTabs ?? [];
			// Page names under the "Publishing profiles" list. (A loop, not a named
			// inner function: tsx's __name helper doesn't exist in the page.)
			const names: string[] = [];
			const stack: any[] = [...(plugin?.settingTab?.settingItems ?? [])];
			while (stack.length) {
				const it = stack.pop();
				if (it?.type === "list" && it.heading === "Publishing profiles") {
					for (const p of it.items ?? []) if (p.type === "page") names.push(p.name);
				} else if (it?.items) stack.push(...it.items);
			}
			return {
				loaded: !!plugin,
				settingTab: tabs.some((t) => t.id === id),
				command: !!app?.commands?.commands?.[`${id}:refresh-credentials`],
				names,
			};
		}, PLUGIN_ID);

		if (state.loaded && state.settingTab && state.command) ctx.pass("plugin loads with malformed profile names", "settings tab and commands registered");
		else ctx.fail("plugin loads with malformed profile names", JSON.stringify(state));

		const untitled = state.names.filter((n) => n === "Untitled" || n === "Untitled (2)");
		if (untitled.length === 2 && state.names.length >= 3) ctx.pass("malformed names show as Untitled pages", state.names.join(", "));
		else ctx.fail("malformed names show as Untitled pages", state.names.join(", "));
	} finally {
		await restoreSettings(ctx);
	}
}

runTest({ name: "malformed-profile-e2e", setupVault }, tests);
