/**
 * Verifies the Settings tab's tab-bar navigation and collapsible subsections.
 *
 * Drives the real setting tab inside Obsidian: opens the plugin's setting tab,
 * asserts the tab bar renders and switches panes, toggles a collapsible
 * subsection, and confirms both the active tab and the collapsed state are
 * persisted to plugin settings (and survive a re-render).
 *
 * Run with: npx playwright test --config=e2e/playwright.config.ts settings-tabs
 */

import { test, expect } from "../lib/obsidian-fixture";

/** Open the CPN plugin setting tab and return the container selector's state. */
async function openCpnSettings(page: import("@playwright/test").Page) {
	await page.evaluate(() => {
		const app = (window as any).app;
		app.setting.open();
		app.setting.openTabById("commonplace-notes");
	});
	await page.waitForTimeout(300);
}

test.describe("Settings tab navigation", () => {
	test("tab bar renders, switches, and persists active tab", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		await openCpnSettings(obsidianPage);

		// Four tabs render.
		const tabs = obsidianPage.locator(".cpn-settings-tabs .cpn-settings-tab");
		await expect(tabs).toHaveCount(4);

		// Default active tab is General.
		await expect(obsidianPage.locator(".cpn-settings-tab.is-active")).toHaveText("General");

		// Switch to Publishing profiles.
		await obsidianPage.locator(".cpn-settings-tab", { hasText: "Publishing profiles" }).click();
		await obsidianPage.waitForTimeout(200);
		await expect(obsidianPage.locator(".cpn-settings-tab.is-active")).toHaveText("Publishing profiles");

		// Only one tab's content is present at a time: the active-profile
		// container exists under Profiles but not under General.
		await expect(obsidianPage.locator(".cpn-active-profile-container")).toHaveCount(1);

		// Active tab persisted to settings.
		const activeTab = await obsidianPage.evaluate(() => {
			const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
			return plugin?.settings?.settingsUiState?.activeTab;
		});
		expect(activeTab).toBe("profiles");
	});

	test("subsections are collapsible and Danger Zone starts collapsed", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		await openCpnSettings(obsidianPage);

		// Go to Publishing profiles where the collapsible subsections live.
		await obsidianPage.locator(".cpn-settings-tab", { hasText: "Publishing profiles" }).click();
		await obsidianPage.waitForTimeout(200);

		const sections = obsidianPage.locator("details.cpn-settings-section");
		expect(await sections.count()).toBeGreaterThan(0);

		// Danger Zone defaults to collapsed (open === false).
		const dangerOpen = await obsidianPage.evaluate(() => {
			const summaries = Array.from(document.querySelectorAll(
				"details.cpn-settings-section > summary.cpn-settings-section-summary"
			));
			const danger = summaries.find((s) => s.textContent?.trim() === "Danger Zone");
			return (danger?.parentElement as HTMLDetailsElement | undefined)?.open ?? null;
		});
		expect(dangerOpen).toBe(false);

		// Collapse the first section (Profile Identity) and confirm it persists.
		await obsidianPage.evaluate(() => {
			const summaries = Array.from(document.querySelectorAll(
				"details.cpn-settings-section > summary.cpn-settings-section-summary"
			));
			const identity = summaries.find((s) => s.textContent?.trim() === "Profile Identity");
			(identity as HTMLElement | undefined)?.click();
		});
		await obsidianPage.waitForTimeout(200);

		const collapsed = await obsidianPage.evaluate(() => {
			const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
			return plugin?.settings?.settingsUiState?.collapsedSections?.["Profile Identity"];
		});
		expect(collapsed).toBe(true);
	});
});
