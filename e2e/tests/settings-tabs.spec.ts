/**
 * Verifies the declarative Settings tab (getSettingDefinitions, Obsidian 1.13+).
 *
 * Drives the real setting tab inside Obsidian: the root shows the General rows,
 * the Markdown parser / Note routing pages and the Publishing profiles list;
 * a profile opens as its own page; controls write through to plugin.settings;
 * and Obsidian's settings search finds CPN rows.
 *
 * Run with: npx playwright test --config=e2e/playwright.config.ts settings-tabs
 */

import { test, expect } from "../lib/obsidian-fixture";
import {
	SETTINGS_CONTENT, closeSettings, currentSettingsPageTitle, openCpnSettings, openSettingsPage,
} from "../lib/test-helpers";
import type { Page } from "@playwright/test";

/** Visible row names on the settings page on screen. */
function rowNames(page: Page): Promise<string[]> {
	return page.evaluate((root) =>
		Array.from(document.querySelectorAll(`${root} .setting-item-name`))
			.filter(e => (e as HTMLElement).offsetParent !== null)
			.map(e => e.textContent?.trim() ?? ""), SETTINGS_CONTENT);
}

/** Names of the profile pages listed under Publishing profiles. */
function profileRowNames(page: Page): Promise<string[]> {
	return page.evaluate((root) => {
		const lists = Array.from(document.querySelectorAll(`${root} .setting-group.mod-list`));
		const list = lists.find(l => l.querySelector(".setting-item-heading .setting-item-name")?.textContent?.trim() === "Publishing profiles");
		return Array.from(list?.querySelectorAll(".setting-item.mod-navigable .setting-item-name") ?? [])
			.map(e => e.textContent?.trim() ?? "");
	}, SETTINGS_CONTENT);
}

test.describe("Declarative settings tab", () => {
	test.afterEach(async ({ obsidianPage }) => {
		await closeSettings(obsidianPage);
	});

	test("root shows General rows, top-level pages and the profile list", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		await openCpnSettings(obsidianPage);

		const names = await rowNames(obsidianPage);
		for (const expected of ["UID length", "Debug mode", "URL stack window (seconds)", "Markdown parser", "Note routing", "Publishing profiles"]) {
			expect(names).toContain(expected);
		}
		// The old custom tab bar is gone.
		await expect(obsidianPage.locator(".cpn-settings-tabs")).toHaveCount(0);

		const profiles = await profileRowNames(obsidianPage);
		expect(profiles.length).toBeGreaterThan(0);
	});

	test("a profile opens as its own page", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		await openCpnSettings(obsidianPage);
		const [first] = await profileRowNames(obsidianPage);
		await openSettingsPage(obsidianPage, first);

		expect(await currentSettingsPageTitle(obsidianPage)).toBe(first);
		const names = await rowNames(obsidianPage);
		expect(names).toContain("Profile name");
		expect(names).toContain("Publish mechanism");

		// Markdown parser is a page too.
		await openCpnSettings(obsidianPage, ["Markdown parser"]);
		expect(await rowNames(obsidianPage)).toContain("CPN directory");
	});

	test("General controls write through to plugin settings", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		const original = await obsidianPage.evaluate(() =>
			(window as any).app.plugins.plugins["commonplace-notes"].settings.urlStackWindowSeconds);
		await openCpnSettings(obsidianPage);

		const input = obsidianPage.locator(`${SETTINGS_CONTENT} .setting-item`, { hasText: "URL stack window (seconds)" }).locator("input");
		await input.fill("42");
		await input.press("Enter");
		await obsidianPage.waitForTimeout(200);
		const stored = await obsidianPage.evaluate(() =>
			(window as any).app.plugins.plugins["commonplace-notes"].settings.urlStackWindowSeconds);
		expect(stored).toBe(42);

		// Out-of-range input is rejected by the control, not stored.
		await input.fill("500");
		await input.press("Enter");
		await obsidianPage.waitForTimeout(200);
		const unchanged = await obsidianPage.evaluate(() =>
			(window as any).app.plugins.plugins["commonplace-notes"].settings.urlStackWindowSeconds);
		expect(unchanged).toBe(42);

		await obsidianPage.evaluate(async (value) => {
			const plugin = (window as any).app.plugins.plugins["commonplace-notes"];
			if (value === undefined) delete plugin.settings.urlStackWindowSeconds;
			else plugin.settings.urlStackWindowSeconds = value;
			await plugin.saveSettings();
		}, original);
	});

	test("parser stage override and reset update the row in place", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		// Start from the built-in for the first stage.
		const stage = await obsidianPage.evaluate(async () => {
			const manager = (window as any).app.plugins.plugins["commonplace-notes"].parserExtensionManager;
			const name: string = manager.getBuiltinParserNames()[0];
			if (manager.builtinVaultFileExists(name)) await manager.resetBuiltinParserToDefault(name);
			return name;
		});
		await openCpnSettings(obsidianPage, ["Markdown parser"]);
		const row = obsidianPage.locator(`${SETTINGS_CONTENT} .setting-item`)
			.filter({ has: obsidianPage.locator(".setting-item-name", { hasText: new RegExp(`^${stage}$`) }) });
		await expect(row.locator(".setting-item-description")).not.toContainText("overridden");
		await expect(row.locator('[aria-label^="Reset to built-in default"]')).toHaveCount(0);

		// Opening the created file closes Settings (Obsidian behavior); the row
		// reads the file's state when the page renders again.
		await row.locator('[aria-label="Create & open stage definition"]').click();
		await obsidianPage.locator(".modal.mod-settings").waitFor({ state: "detached" });
		// Close the opened file: trashing an open file also closes Settings.
		await obsidianPage.evaluate(() => {
			for (const leaf of (window as any).app.workspace.getLeavesOfType("markdown")) leaf.detach();
		});
		await openCpnSettings(obsidianPage, ["Markdown parser"]);
		await expect(row.locator(".setting-item-description")).toContainText("overridden");
		// Reset refreshes the page in place.
		await row.locator('[aria-label^="Reset to built-in default"]').click();
		await expect(row.locator(".setting-item-description")).not.toContainText("overridden");
		// Still on the parser page after both refreshes.
		expect(await currentSettingsPageTitle(obsidianPage)).toBe("Markdown parser");
	});

	test("settings search finds CPN rows", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		await openCpnSettings(obsidianPage);

		const search = obsidianPage.locator(".modal.mod-settings input[type=search]").first();
		await search.fill("URL stack window");
		await obsidianPage.waitForTimeout(500);
		const results = await obsidianPage.evaluate(() =>
			Array.from(document.querySelectorAll(".modal.mod-settings .setting-search-result-item"))
				.map(e => e.textContent?.trim() ?? ""));
		expect(results).toContain("URL stack window (seconds)");
		await search.fill("");
	});
});
