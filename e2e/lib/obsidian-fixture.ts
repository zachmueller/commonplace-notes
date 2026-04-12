/**
 * Playwright Test Fixture for Obsidian
 *
 * Extends Playwright's base test with custom fixtures that:
 *  1. Launch Obsidian with CDP remote debugging
 *  2. Connect Playwright to the running Obsidian instance
 *  3. Attach the log collector to capture plugin output
 *  4. Provide the connected Page to tests
 *  5. Clean up (write summary, close browser, shut down Obsidian) after tests
 *
 * Usage in tests:
 *   import { test, expect } from "../lib/obsidian-fixture";
 *   test("plugin loads", async ({ obsidianPage, logCollector }) => {
 *     // obsidianPage is a Playwright Page connected to Obsidian
 *     // logCollector has all captured plugin logs
 *   });
 */

import { test as base, chromium, type Page, type Browser } from "@playwright/test";
import { launchObsidian, closeObsidian, type ObsidianProcess } from "./obsidian-launcher";
import { LogCollector } from "./log-collector";
import { PLUGIN_ID } from "./test-helpers";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OBSIDIAN_CONFIG_DIR = ".obsidian";

/** Default test vault path — can be overridden with E2E_VAULT_PATH env var */
function getVaultPath(): string {
	if (process.env.E2E_VAULT_PATH) {
		return process.env.E2E_VAULT_PATH;
	}
	return path.resolve(__dirname, "..", "test-vault");
}

/**
 * Ensure the test vault exists with minimal structure.
 *
 * Unlike the notor setup which symlinks a build/ directory, this plugin
 * outputs main.js to the project root. We create the plugin directory and
 * symlink individual files (main.js, manifest.json, styles.css) to avoid
 * a recursive symlink loop (since e2e/test-vault is inside the project).
 */
function ensureTestVault(vaultPath: string): void {
	const obsidianDir = path.join(vaultPath, OBSIDIAN_CONFIG_DIR);
	if (!fs.existsSync(obsidianDir)) {
		fs.mkdirSync(obsidianDir, { recursive: true });
		fs.writeFileSync(
			path.join(obsidianDir, "app.json"),
			JSON.stringify({ alwaysUpdateLinks: true, restrictMode: false }, null, 2)
		);
		fs.writeFileSync(
			path.join(obsidianDir, "appearance.json"),
			JSON.stringify({}, null, 2)
		);
	}

	const pluginDir = path.join(obsidianDir, "plugins", PLUGIN_ID);
	const projectRoot = path.resolve(__dirname, "..", "..");

	if (!fs.existsSync(path.join(obsidianDir, "plugins"))) {
		fs.mkdirSync(path.join(obsidianDir, "plugins"), { recursive: true });
	}

	// Create plugin directory (not a symlink) and symlink individual files
	if (!fs.existsSync(pluginDir)) {
		fs.mkdirSync(pluginDir, { recursive: true });
	}

	const filesToLink = ["main.js", "manifest.json", "styles.css"];
	for (const file of filesToLink) {
		const src = path.join(projectRoot, file);
		const dest = path.join(pluginDir, file);
		if (fs.existsSync(src)) {
			// Remove existing symlink/file before creating new one
			try {
				fs.lstatSync(dest);
				fs.unlinkSync(dest);
			} catch {
				// File doesn't exist — fine
			}
			fs.symlinkSync(src, dest);
		}
	}

	// Ensure community plugins are enabled and our plugin is active
	const communityPluginsPath = path.join(obsidianDir, "community-plugins.json");
	let enabledPlugins: string[] = [];
	if (fs.existsSync(communityPluginsPath)) {
		try {
			enabledPlugins = JSON.parse(fs.readFileSync(communityPluginsPath, "utf8"));
		} catch {
			enabledPlugins = [];
		}
	}
	if (!enabledPlugins.includes(PLUGIN_ID)) {
		enabledPlugins.push(PLUGIN_ID);
		fs.writeFileSync(communityPluginsPath, JSON.stringify(enabledPlugins));
	}
}

// Custom fixture types
type ObsidianFixtures = {
	obsidianPage: Page;
	logCollector: LogCollector;
};

export const test = base.extend<ObsidianFixtures>({
	obsidianPage: async ({}, use) => {
		const vaultPath = getVaultPath();
		ensureTestVault(vaultPath);

		const cdpPort = parseInt(process.env.CDP_PORT ?? "9222", 10);
		let obsidian: ObsidianProcess | undefined;
		let browser: Browser | undefined;

		try {
			obsidian = await launchObsidian({
				vaultPath,
				cdpPort,
				timeout: 30_000,
			});

			browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);

			const contexts = browser.contexts();
			const pages = contexts[0]?.pages() ?? [];
			const page = pages[0] ?? (await contexts[0]?.newPage());

			if (!page) {
				throw new Error("Could not get a page from Obsidian's browser context");
			}

			await page.waitForLoadState("domcontentloaded");
			await page.waitForTimeout(3000);

			await use(page);
		} finally {
			if (browser) {
				await browser.close().catch(() => {});
			}
			if (obsidian) {
				await closeObsidian(obsidian);
			}
		}
	},

	logCollector: async ({ obsidianPage }, use) => {
		const outputDir = path.resolve(__dirname, "..", "results", "logs");
		const collector = new LogCollector({ outputDir });
		collector.attach(obsidianPage);

		await use(collector);

		await collector.dispose();
	},
});

export { expect } from "@playwright/test";
