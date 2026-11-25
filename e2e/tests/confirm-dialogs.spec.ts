/**
 * Verifies the destructive confirmation dialogs (ConfirmationModal, Obsidian
 * 1.13+) resolve correctly: Cancel and Escape decline, the destructive button
 * confirms, and the opt-in checkbox is reported only when confirmed.
 *
 * Drives `plugin.confirmDestroyInfrastructure`, which shares
 * src/utils/confirm.ts with the force-clean and remove-group dialogs.
 *
 * Run with: npx playwright test --config=e2e/playwright.config.ts confirm-dialogs
 */

import { test, expect } from "../lib/obsidian-fixture";
import type { Page } from "@playwright/test";

/** Open the destroy dialog; the result lands on window.__cpnConfirm. */
async function openDestroyDialog(page: Page): Promise<void> {
	await page.evaluate(() => {
		const w = window as any;
		const plugin = w.app.plugins.plugins["commonplace-notes"];
		w.__cpnConfirm = undefined;
		void plugin.confirmDestroyInfrastructure({ name: "Dialog test" }).then((r: unknown) => { w.__cpnConfirm = r; });
	});
	await page.locator(".modal-container .modal", { hasText: "Destroy Infrastructure" }).waitFor();
}

async function result(page: Page): Promise<unknown> {
	await page.waitForFunction(() => (window as any).__cpnConfirm !== undefined);
	return page.evaluate(() => (window as any).__cpnConfirm);
}

test.describe("Destructive confirmation dialogs", () => {
	test("cancel, escape and confirm resolve as expected", async ({ obsidianPage: page }) => {
		await page.waitForTimeout(5000);
		const modal = page.locator(".modal-container .modal", { hasText: "Destroy Infrastructure" });

		// The destructive button is styled destructive + CTA; Cancel declines.
		await openDestroyDialog(page);
		const destroy = modal.locator("button", { hasText: "Destroy" });
		await expect(destroy).toHaveClass(/mod-destructive/);
		await expect(destroy).toHaveClass(/mod-cta/);
		await expect(modal).toContainText("Also delete S3 data");
		await modal.locator("button", { hasText: "Cancel" }).click();
		expect(await result(page)).toEqual({ confirmed: false, deleteBuckets: false });

		// Escape declines, even with the checkbox ticked.
		await openDestroyDialog(page);
		await modal.locator("input[type=checkbox]").check();
		await page.keyboard.press("Escape");
		expect(await result(page)).toEqual({ confirmed: false, deleteBuckets: false });

		// Destroy confirms; the checkbox defaults off.
		await openDestroyDialog(page);
		await modal.locator("button", { hasText: "Destroy" }).click();
		expect(await result(page)).toEqual({ confirmed: true, deleteBuckets: false });

		// Destroy with the checkbox ticked reports it.
		await openDestroyDialog(page);
		await modal.locator("input[type=checkbox]").check();
		await modal.locator("button", { hasText: "Destroy" }).click();
		expect(await result(page)).toEqual({ confirmed: true, deleteBuckets: true });
	});
});
