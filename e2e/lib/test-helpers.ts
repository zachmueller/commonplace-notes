/**
 * Shared E2E test helpers for the Commonplace Notes plugin.
 *
 * Provides constants, page interaction utilities, and vault page discovery.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Browser } from "playwright-core";

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = path.resolve(LIB_DIR, "..");
export const PROJECT_ROOT = path.resolve(E2E_DIR, "..");
export const VAULT_PATH = path.resolve(E2E_DIR, "test-vault");
export const RESULTS_DIR = path.resolve(E2E_DIR, "results");
export const LOGS_DIR = path.join(RESULTS_DIR, "logs");

export const PLUGIN_ID = "commonplace-notes";
export const CDP_PORT = 9222;

// ---------------------------------------------------------------------------
// Page finders
// ---------------------------------------------------------------------------

/**
 * Find the Obsidian vault page across all CDP contexts.
 *
 * Obsidian spawns multiple renderer processes. This polls every 500ms until
 * a page that looks like the vault workspace is found, or the timeout expires.
 */
export async function findVaultPage(browser: Browser, timeout = 20_000): Promise<Page> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		for (const ctx of browser.contexts()) {
			for (const p of ctx.pages()) {
				try {
					// Look for Obsidian's workspace container
					const el = await p.$(".workspace");
					if (el) return p;
				} catch { /* page may be closed or not ready */ }
			}
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error("Could not find Obsidian vault page with .workspace within timeout");
}

// ---------------------------------------------------------------------------
// Element helpers
// ---------------------------------------------------------------------------

/**
 * Wait for an element matching `selector` with a timeout.
 * Returns null if not found (instead of throwing).
 */
export async function waitForSelector(
	page: Page,
	selector: string,
	timeoutMs = 8_000,
): Promise<import("playwright-core").ElementHandle | null> {
	try {
		return await page.waitForSelector(selector, { timeout: timeoutMs });
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Plugin access helpers
// ---------------------------------------------------------------------------

/**
 * Access the plugin instance from within the Obsidian page context.
 */
export async function getPluginInstance(page: Page): Promise<boolean> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		return !!plugin;
	});
}

/**
 * Get the plugin settings from within the Obsidian page context.
 */
export async function getPluginSettings(page: Page): Promise<Record<string, unknown> | null> {
	return page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		return plugin?.settings ?? null;
	});
}

/**
 * Open the Obsidian command palette and execute a command by name.
 */
export async function executeCommand(page: Page, commandName: string): Promise<void> {
	// Open command palette with Cmd+P (macOS) or Ctrl+P
	await page.keyboard.press("Meta+p");
	await page.waitForTimeout(500);

	// Type the command name
	await page.keyboard.type(commandName, { delay: 50 });
	await page.waitForTimeout(500);

	// Press Enter to execute
	await page.keyboard.press("Enter");
	await page.waitForTimeout(1000);
}

// ---------------------------------------------------------------------------
// Vault helpers
// ---------------------------------------------------------------------------

/**
 * Create a test note in the vault.
 */
export function createTestNote(vaultPath: string, name: string, content: string): void {
	fs.writeFileSync(path.join(vaultPath, name), content);
}

/**
 * Remove a test note from the vault.
 */
export function removeTestNote(vaultPath: string, name: string): void {
	const notePath = path.join(vaultPath, name);
	if (fs.existsSync(notePath)) {
		fs.unlinkSync(notePath);
	}
}
