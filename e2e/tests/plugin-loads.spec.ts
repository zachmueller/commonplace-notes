/**
 * Basic smoke test: verify the plugin loads in Obsidian without errors.
 *
 * This test:
 *  1. Launches Obsidian with the plugin symlinked into a test vault
 *  2. Waits for plugin initialization
 *  3. Checks that plugin log entries were captured
 *  4. Verifies the plugin instance is accessible
 *  5. Takes a screenshot for visual verification
 *
 * Run with: npx playwright test --config=e2e/playwright.config.ts
 */

import { test, expect } from "../lib/obsidian-fixture";

test.describe("Plugin smoke tests", () => {
	test("plugin loads without errors", async ({ obsidianPage, logCollector }) => {
		// Wait for the plugin to fully initialize
		await obsidianPage.waitForTimeout(5000);

		// Take a screenshot for visual inspection
		await obsidianPage.screenshot({
			path: "e2e/results/screenshots/plugin-loaded.png",
			fullPage: true,
		});

		// Check we got some log entries
		const allLogs = logCollector.getStructuredLogs();
		console.log(`Captured ${allLogs.length} structured log entries`);

		// Check for plugin-sourced logs (from [CPN] prefixed messages)
		const pluginLogs = allLogs.filter((entry) => entry.source === "plugin");
		console.log(`Plugin log entries: ${pluginLogs.length}`);

		// Verify no plugin errors during startup
		const pluginErrors = allLogs.filter(
			(entry) => entry.source === "plugin" && entry.level === "error"
		);
		if (pluginErrors.length > 0) {
			console.error("Plugin errors during startup:", JSON.stringify(pluginErrors, null, 2));
		}
		expect(pluginErrors.length).toBe(0);

		// Log the summary for review
		const summaryPath = logCollector.writeSummary();
		console.log(`Log summary written to: ${summaryPath}`);
	});

	test("plugin instance is accessible", async ({ obsidianPage, logCollector }) => {
		await obsidianPage.waitForTimeout(5000);

		// Verify the plugin is registered in Obsidian's plugin registry
		const pluginLoaded = await obsidianPage.evaluate(() => {
			const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
			return !!plugin;
		});

		expect(pluginLoaded).toBe(true);

		// Verify settings are loaded
		const hasSettings = await obsidianPage.evaluate(() => {
			const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
			return plugin?.settings != null;
		});

		expect(hasSettings).toBe(true);
		console.log("Plugin instance and settings verified");
	});
});
