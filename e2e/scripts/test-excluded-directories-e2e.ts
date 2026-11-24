#!/usr/bin/env npx tsx
/**
 * Excluded Directories (rules v2) E2E Test
 *
 * Verifies, in the real Obsidian runtime, the one-time excluded-directories
 * upgrade and the new folder-pattern matching (src/utils/excludedDirectories.ts).
 *
 * Setup (before launch): a second profile `E2E Excl` with the old-style
 * slashless entry `E2E-Drafts` plus `**\/E2E-Private/`, no rules version, and
 * settings parked on the General tab. data.json is restored at the end.
 *
 * Scenarios:
 *   1. On load, the upgrade appended `**\/E2E-Drafts/` and `E2E-Drafts*\/`
 *      (keeping the user's entries as typed) and recorded
 *      excludedDirsRulesVersion 2 on every profile.
 *   2. A persistent notice names the profile, the added patterns, and the root
 *      file `E2E-Drafts.md` the old rule excluded only by name.
 *   3. Folders the old rule excluded stay excluded (root, nested, prefix), and
 *      `**\/E2E-Private/` excludes `E2E-Projects/E2E-Private/…` but not
 *      `E2E-Projects/E2E-Public/…`; getAllPublishableNotes agrees.
 *   4. Running the upgrade again changes nothing and shows no new notice.
 *   5. The notice's "Open settings" link opens the plugin settings on the
 *      Publishing profiles tab with `E2E Excl` selected.
 *   6. No plugin errors captured.
 *
 * Run: npx tsx e2e/scripts/test-excluded-directories-e2e.ts
 */

import * as fs from "fs";
import * as path from "path";
import { runTest, type TestContext } from "../lib/test-harness";
import { createTestNote, PLUGIN_ID, RESULTS_DIR, VAULT_PATH } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const PROFILE_ID = "e2e-excl";
const PROFILE_NAME = "E2E Excl";
const ENTRIES = ["E2E-Drafts", "**/E2E-Private/"];
const EXPECTED_ENTRIES = [...ENTRIES, "**/E2E-Drafts/", "E2E-Drafts*/"];

const DATA_JSON = path.join(VAULT_PATH, ".obsidian", "plugins", PLUGIN_ID, "data.json");
const DATA_BACKUP = path.join(RESULTS_DIR, "excluded-directories-e2e.data.json.bak");

const FM = `---\ncpn-publish-contexts:\n  - ${PROFILE_ID}\n---\n`;

/** Fixture note → excluded under the upgraded entries? */
const NOTES: Record<string, boolean> = {
	"E2E-Drafts.md": false, // root file matched by name only: reported, no longer excluded
	"E2E-Drafts/a.md": true, // root folder
	"E2E-Nested/E2E-Drafts/b.md": true, // old any-depth match → **/E2E-Drafts/
	"E2E-Drafts-old/c.md": true, // old prefix match → E2E-Drafts*/
	"E2E-Projects/E2E-Private/secret.md": true, // **/E2E-Private/
	"E2E-Projects/E2E-Public/open.md": false,
};

const FIXTURE_ROOTS = ["E2E-Drafts.md", "E2E-Drafts", "E2E-Nested", "E2E-Drafts-old", "E2E-Projects"];

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Back up data.json and add the old-style test profile. Runs before launch. */
function setupVault(vaultPath: string): void {
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	const original = fs.readFileSync(DATA_JSON, "utf8");
	fs.writeFileSync(DATA_BACKUP, original);

	const data = JSON.parse(original);
	const base = data.publishingProfiles[0];
	data.publishingProfiles = data.publishingProfiles.filter((p: any) => p.id !== PROFILE_ID);
	data.publishingProfiles.push({
		...base,
		id: PROFILE_ID,
		name: PROFILE_NAME,
		excludedDirectories: ENTRIES,
		infrastructureState: undefined,
		cognitoAuth: undefined,
	});
	// Every profile starts on the old rules so the upgrade runs on load.
	for (const p of data.publishingProfiles) delete p.excludedDirsRulesVersion;
	data.settingsUiState = { ...(data.settingsUiState ?? {}), activeTab: "general" };
	fs.writeFileSync(DATA_JSON, JSON.stringify(data, null, 2));

	for (const note of Object.keys(NOTES)) {
		fs.mkdirSync(path.join(vaultPath, path.dirname(note)), { recursive: true });
		createTestNote(vaultPath, note, FM + `# ${note}\n`);
	}
}

/** Put the user's settings back, in memory and on disk. */
async function restoreSettings(ctx: TestContext): Promise<void> {
	const original = fs.readFileSync(DATA_BACKUP, "utf8");
	await ctx.page.evaluate(async ({ pluginId, original }) => {
		const app = (window as any).app;
		app.setting?.close?.();
		const plugin = app?.plugins?.plugins?.[pluginId];
		if (!plugin) return;
		plugin.settings = JSON.parse(original);
		await plugin.saveSettings();
	}, { pluginId: PLUGIN_ID, original });
	fs.writeFileSync(DATA_JSON, original);
}

/** Text of every notice whose text mentions the upgrade. */
async function upgradeNotices(ctx: TestContext): Promise<string[]> {
	return ctx.page.evaluate(() =>
		Array.from(document.querySelectorAll(".notice"))
			.map((n) => n.textContent ?? "")
			.filter((t) => t.includes("Excluded directories now match from the vault root")),
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testUpgradeRecorded(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: upgrade appended patterns and recorded version 2");
	const probe = await ctx.page.evaluate(({ pluginId, profileId }) => {
		const plugin = (window as any).app?.plugins?.plugins?.[pluginId];
		if (!plugin) return { error: "plugin not found" };
		const profiles = plugin.settings.publishingProfiles as any[];
		const profile = profiles.find((p) => p.id === profileId);
		if (!profile) return { error: "test profile not found" };
		return {
			entries: profile.excludedDirectories as string[],
			versions: profiles.map((p) => p.excludedDirsRulesVersion),
		};
	}, { pluginId: PLUGIN_ID, profileId: PROFILE_ID });

	if (probe.error) {
		ctx.fail("Upgrade ran", probe.error);
		return;
	}
	if (JSON.stringify(probe.entries) === JSON.stringify(EXPECTED_ENTRIES)) {
		ctx.pass("Patterns appended", JSON.stringify(probe.entries));
	} else {
		ctx.fail("Patterns appended", `expected ${JSON.stringify(EXPECTED_ENTRIES)}, got ${JSON.stringify(probe.entries)}`);
	}
	if (probe.versions?.every((v: unknown) => v === 2)) {
		ctx.pass("Version recorded", `excludedDirsRulesVersion = 2 on ${probe.versions.length} profile(s)`);
	} else {
		ctx.fail("Version recorded", `versions: ${JSON.stringify(probe.versions)}`);
	}

	const onDisk = JSON.parse(fs.readFileSync(DATA_JSON, "utf8"));
	const saved = onDisk.publishingProfiles.find((p: any) => p.id === PROFILE_ID);
	if (saved?.excludedDirsRulesVersion === 2 && JSON.stringify(saved.excludedDirectories) === JSON.stringify(EXPECTED_ENTRIES)) {
		ctx.pass("Upgrade saved", "data.json has the new entries and version 2");
	} else {
		ctx.fail("Upgrade saved", `data.json profile: ${JSON.stringify(saved?.excludedDirectories)} v${saved?.excludedDirsRulesVersion}`);
	}
}

async function testNotice(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: persistent notice describes the upgrade");
	const notices = await upgradeNotices(ctx);
	const shot = await ctx.screenshot("01-upgrade-notice");
	const mine = notices.filter((t) => t.includes(PROFILE_NAME));
	if (mine.length !== 1) {
		ctx.fail("Notice shown", `expected 1 notice for ${PROFILE_NAME}, found ${mine.length}: ${JSON.stringify(notices)}`, shot);
		return;
	}
	const text = mine[0];
	const wants = ["**/E2E-Drafts/", "E2E-Drafts*/", "so the same folders stay excluded", "No longer excluded", "E2E-Drafts.md", "Open settings"];
	const missing = wants.filter((w) => !text.includes(w));
	if (missing.length === 0) {
		ctx.pass("Notice shown", text, shot);
	} else {
		ctx.fail("Notice shown", `missing ${JSON.stringify(missing)} in: ${text}`, shot);
	}
	// Only the root file is reported; folders stay excluded.
	if (!text.includes("a.md") && !text.includes("b.md") && !text.includes("c.md")) {
		ctx.pass("Only root file reported", "no folder files listed");
	} else {
		ctx.fail("Only root file reported", text, shot);
	}
	// Profiles whose entries all end in `/` gain nothing and get no notice.
	if (notices.length === mine.length) {
		ctx.pass("No notice for unchanged profiles", `${notices.length} upgrade notice(s)`);
	} else {
		ctx.fail("No notice for unchanged profiles", JSON.stringify(notices));
	}
}

async function testMatching(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: folder patterns exclude the right notes");
	const probe = await ctx.page.evaluate(async ({ pluginId, profileId, paths }) => {
		const app = (window as any).app;
		const plugin = app?.plugins?.plugins?.[pluginId];
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === profileId);
		const excluded: Record<string, boolean | string> = {};
		for (const p of paths) {
			const file = app.vault.getAbstractFileByPath(p);
			excluded[p] = file ? plugin.publisher.isFileExcluded(file, profile) : "missing";
		}
		const publishable = (await plugin.publisher.getAllPublishableNotes(profileId)).map((f: any) => f.path);
		return { excluded, publishable };
	}, { pluginId: PLUGIN_ID, profileId: PROFILE_ID, paths: Object.keys(NOTES) });

	for (const [note, want] of Object.entries(NOTES)) {
		const got = probe.excluded[note];
		const publishable = probe.publishable.includes(note);
		if (got === want && publishable === !want) {
			ctx.pass(`Match ${note}`, want ? "excluded, not publishable" : "not excluded, publishable");
		} else {
			ctx.fail(`Match ${note}`, `want excluded=${want}; got isFileExcluded=${got}, publishable=${publishable}`);
		}
	}
}

async function testOpenSettings(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: Open settings lands on the profile");
	const clicked = await ctx.page.evaluate((name) => {
		const notice = Array.from(document.querySelectorAll(".notice"))
			.find((n) => (n.textContent ?? "").includes(name) && (n.textContent ?? "").includes("Open settings"));
		const link = Array.from(notice?.querySelectorAll("a") ?? []).find((a) => a.textContent === "Open settings");
		if (!link) return false;
		(link as HTMLElement).click();
		return true;
	}, PROFILE_NAME);
	if (!clicked) {
		ctx.fail("Open settings link", "link not found in the notice");
		return;
	}
	await ctx.page.waitForTimeout(1_500);
	const state = await ctx.page.evaluate((name) => {
		const modal = document.querySelector(".modal.mod-settings");
		const activeTab = modal?.querySelector(".cpn-settings-tab.is-active")?.textContent ?? null;
		const select = Array.from(modal?.querySelectorAll(".setting-item") ?? [])
			.find((s) => s.querySelector(".setting-item-name")?.textContent === "Active profile")
			?.querySelector("select") as HTMLSelectElement | undefined;
		const selected = select ? select.options[select.selectedIndex]?.text : null;
		return { open: !!modal, activeTab, selected, wanted: name };
	}, PROFILE_NAME);
	const shot = await ctx.screenshot("02-open-settings");
	if (state.open && state.activeTab === "Publishing profiles" && state.selected === PROFILE_NAME) {
		ctx.pass("Open settings link", `settings open on Publishing profiles → ${state.selected}`, shot);
	} else {
		ctx.fail("Open settings link", JSON.stringify(state), shot);
	}
}

async function testRunsOnce(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: a second run changes nothing");
	const before = (await upgradeNotices(ctx)).length;
	const probe = await ctx.page.evaluate(async ({ pluginId, profileId }) => {
		const plugin = (window as any).app?.plugins?.plugins?.[pluginId];
		await plugin.upgradeExcludedDirectoriesOnce();
		return plugin.settings.publishingProfiles.find((p: any) => p.id === profileId).excludedDirectories;
	}, { pluginId: PLUGIN_ID, profileId: PROFILE_ID });
	const after = (await upgradeNotices(ctx)).length;
	if (JSON.stringify(probe) === JSON.stringify(EXPECTED_ENTRIES) && before === 1 && after === before) {
		ctx.pass("Runs once", `entries unchanged, ${after} notice(s) before and after`);
	} else {
		ctx.fail("Runs once", `entries ${JSON.stringify(probe)}, notices ${before} → ${after}`);
	}
}

async function testNoErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: no plugin errors captured");
	const errors = ctx.collector.getLogsByLevel("error");
	if (errors.length === 0) {
		ctx.pass("No plugin errors", "0 error-level log entries");
	} else {
		ctx.fail("No plugin errors", errors.slice(-5).map((e) => e.message).join(" | "));
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	await ctx.page.waitForTimeout(5_000); // plugin init + layout-ready upgrade
	try {
		await testUpgradeRecorded(ctx);
		await testNotice(ctx);
		await testMatching(ctx);
		// Before the click below, which dismisses the notice.
		await testRunsOnce(ctx);
		await testOpenSettings(ctx);
		await testNoErrors(ctx);
	} finally {
		await restoreSettings(ctx);
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runTest(
	{
		name: "excluded-directories-e2e",
		setupVault,
		cleanupFiles: FIXTURE_ROOTS,
	},
	tests,
);
