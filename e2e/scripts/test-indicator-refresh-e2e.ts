#!/usr/bin/env npx tsx
/**
 * Indicator refresh on metadata changes (startup item 3a) E2E test.
 *
 * The metadataCache 'changed' handler refreshes only the changed note's own
 * indicators, and only while that note is open. Two notes in the `public`
 * profile's publish context: one open in a tab, one closed.
 *
 * Scenarios:
 *   1. The open note shows its title indicator.
 *   2. A frontmatter change to the closed note does no indicator work.
 *   3. A frontmatter change to the open note refreshes that note only (no
 *      full pass), and it still has exactly one indicator container.
 *
 * Run: npx tsx e2e/scripts/test-indicator-refresh-e2e.ts
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { createTestNote, PLUGIN_ID } from "../lib/test-helpers";

const OPEN = "E2E-Ind-Open.md";
const CLOSED = "E2E-Ind-Closed.md";
const FM = "---\ncpn-publish-contexts:\n  - public\n---\n";

function setupVault(vaultPath: string): void {
	createTestNote(vaultPath, OPEN, `${FM}# Open\n`);
	createTestNote(vaultPath, CLOSED, `${FM}# Closed\n`);
}

/** Wrap the indicator manager's update methods to record calls. */
async function installSpy(ctx: TestContext): Promise<void> {
	await ctx.page.evaluate((id) => {
		const w = window as any;
		const m = w.app.plugins.plugins[id].indicatorManager;
		w.__cpnIndicatorCalls = { all: 0, files: [] as string[] };
		const one = m.updateIndicators.bind(m);
		const all = m.updateAllVisibleIndicators.bind(m);
		w.__cpnIndicatorRestore = () => { m.updateIndicators = one; m.updateAllVisibleIndicators = all; };
		m.updateIndicators = (file: any) => { w.__cpnIndicatorCalls.files.push(file?.path); return one(file); };
		m.updateAllVisibleIndicators = () => { w.__cpnIndicatorCalls.all++; return all(); };
	}, PLUGIN_ID);
}

async function resetCalls(ctx: TestContext): Promise<void> {
	await ctx.page.evaluate(() => { (window as any).__cpnIndicatorCalls = { all: 0, files: [] }; });
}

async function calls(ctx: TestContext): Promise<{ all: number; files: string[] }> {
	return ctx.page.evaluate(() => (window as any).__cpnIndicatorCalls);
}

async function touchFrontmatter(ctx: TestContext, notePath: string, value: string): Promise<void> {
	await ctx.page.evaluate(async ({ notePath, value }) => {
		const app = (window as any).app;
		const file = app.vault.getFileByPath(notePath);
		await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => { fm["e2e-touch"] = value; });
	}, { notePath, value });
	await ctx.page.waitForTimeout(1_500); // metadata re-index + handler
}

async function titleIndicatorCount(ctx: TestContext, notePath: string): Promise<number> {
	return ctx.page.evaluate((notePath) => {
		const leaf = (window as any).app.workspace.getLeavesOfType("markdown")
			.find((l: any) => l.view?.file?.path === notePath);
		return leaf ? leaf.view.containerEl.querySelectorAll(".view-header-title-parent .cpn-publish-indicators").length : -1;
	}, notePath);
}

async function tests(ctx: TestContext): Promise<void> {
	await ctx.page.waitForTimeout(4_000); // plugin init + layout-ready
	await ctx.page.evaluate(async (notePath) => {
		const app = (window as any).app;
		await app.workspace.getLeaf("tab").openFile(app.vault.getFileByPath(notePath));
	}, OPEN);
	await ctx.page.waitForTimeout(1_000);

	const initial = await titleIndicatorCount(ctx, OPEN);
	if (initial === 1) ctx.pass("open note shows its indicator", "1 title indicator container");
	else ctx.fail("open note shows its indicator", `title indicator containers: ${initial}`);

	await installSpy(ctx);
	try {
		await resetCalls(ctx);
		await touchFrontmatter(ctx, CLOSED, "1");
		const closed = await calls(ctx);
		if (closed.all === 0 && closed.files.length === 0) ctx.pass("closed note change does no indicator work", JSON.stringify(closed));
		else ctx.fail("closed note change does no indicator work", JSON.stringify(closed));

		await resetCalls(ctx);
		await touchFrontmatter(ctx, OPEN, "1");
		const open = await calls(ctx);
		const count = await titleIndicatorCount(ctx, OPEN);
		if (open.all === 0 && open.files.length >= 1 && open.files.every((f) => f === OPEN) && count === 1) {
			ctx.pass("open note change refreshes only that note", `${JSON.stringify(open)}; indicator containers: ${count}`);
		} else {
			ctx.fail("open note change refreshes only that note", `${JSON.stringify(open)}; indicator containers: ${count}`);
		}
	} finally {
		// Restore the spy and close the tab this test opened, so the workspace
		// doesn't keep an empty leaf once the note is cleaned up (other tests
		// rely on the main area's layout).
		await ctx.page.evaluate((notePath) => {
			const w = window as any;
			w.__cpnIndicatorRestore?.();
			for (const leaf of w.app.workspace.getLeavesOfType("markdown")) {
				if (leaf.view?.file?.path === notePath) leaf.detach();
			}
		}, OPEN);
	}
}

runTest({ name: "indicator-refresh-e2e", setupVault, cleanupFiles: [OPEN, CLOSED] }, tests);
