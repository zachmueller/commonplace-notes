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


const TEMP_ID = "e2e-settings-temp";

/** Add a throwaway AWS profile (no bucket yet) and rebuild the tab. */
async function addTempProfile(page: Page, name: string): Promise<void> {
	await page.evaluate(async ({ id, name }) => {
		const plugin = (window as any).app.plugins.plugins["commonplace-notes"];
		plugin.settings.publishingProfiles = plugin.settings.publishingProfiles.filter((p: any) => p.id !== id);
		plugin.settings.publishingProfiles.push({
			name, id, lastFullPublishTimestamp: 0, excludedDirectories: [], excludedDirsRulesVersion: 2,
			baseUrl: "https://e2e.example.test/", homeNotePath: "", isPublic: false, publishContentIndex: false,
			obscureRawWikilinks: true, obscureRawAttachments: true, publishMechanism: "AWS",
			indicator: { style: "color", color: "#3366cc" },
			awsSettings: {
				awsAccountId: "", awsProfile: "", region: "", bucketName: "",
				cloudFrontInvalidationScheme: "individual", credentialMode: "sdk", credentialRefreshCommands: "", awsCliPath: "",
			},
		});
		await plugin.saveSettings();
		plugin.settingTab.refresh();
	}, { id: TEMP_ID, name });
}

async function removeTempProfile(page: Page): Promise<void> {
	await page.evaluate(async (id) => {
		const plugin = (window as any).app.plugins.plugins["commonplace-notes"];
		plugin.settings.publishingProfiles = plugin.settings.publishingProfiles.filter((p: any) => p.id !== id);
		await plugin.saveSettings();
		plugin.settingTab.refresh();
	}, TEMP_ID);
}

/** The settings row named `name` on the page on screen. */
function settingRow(page: Page, name: string) {
	return page.locator(`${SETTINGS_CONTENT} .setting-item`)
		.filter({ has: page.locator(".setting-item-name", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) })
		.first();
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

	test("profile list shows the site domain and a setup warning", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		await addTempProfile(obsidianPage, "E2E Status");
		try {
			await openCpnSettings(obsidianPage);
			const row = settingRow(obsidianPage, "E2E Status");
			await expect(row.locator(".setting-item-value")).toHaveText("e2e.example.test");
			// No bucket or region yet: flagged.
			await expect(row.locator(".setting-item-status.mod-warning")).toHaveCount(1);
		} finally {
			await removeTempProfile(obsidianPage);
		}
	});

	test("switching a profile to Local hides the AWS-only settings", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		await addTempProfile(obsidianPage, "E2E Mechanism");
		try {
			await openCpnSettings(obsidianPage, ["E2E Mechanism"]);
			const awsOnly = ["S3 bucket name", "AWS region", "Credential mode", "Infrastructure", "Site Customization", "Deploy hooks"];
			for (const name of awsOnly) await expect(settingRow(obsidianPage, name)).toBeVisible();

			await settingRow(obsidianPage, "Publish mechanism").locator("select:not(.is-measuring)").selectOption("Local");
			for (const name of awsOnly) await expect(settingRow(obsidianPage, name)).toBeHidden();
			// Attachments stay listed but are disabled on Local profiles.
			await expect(settingRow(obsidianPage, "Publish attachments").locator("select:not(.is-measuring)")).toBeDisabled();
			expect(await obsidianPage.evaluate((id) =>
				(window as any).app.plugins.plugins["commonplace-notes"].settings.publishingProfiles
					.find((p: any) => p.id === id).publishMechanism, TEMP_ID)).toBe("Local");

			await settingRow(obsidianPage, "Publish mechanism").locator("select:not(.is-measuring)").selectOption("AWS");
			for (const name of awsOnly) await expect(settingRow(obsidianPage, name)).toBeVisible();
		} finally {
			await removeTempProfile(obsidianPage);
		}
	});

	test("profile controls write through, with the S3 prefix codec", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		await addTempProfile(obsidianPage, "E2E Controls");
		try {
			await openCpnSettings(obsidianPage, ["E2E Controls"]);
			await settingRow(obsidianPage, "S3 prefix").locator("input").fill("site");
			await settingRow(obsidianPage, "Excluded directories").locator("textarea").fill("private/\n\n**/drafts/");
			await settingRow(obsidianPage, "Credential mode").locator("select:not(.is-measuring)").selectOption("custom-command");
			await expect(settingRow(obsidianPage, "Credential refresh commands")).toBeVisible();
			await expect(settingRow(obsidianPage, "AWS CLI path (optional)")).toBeHidden();
			await obsidianPage.waitForTimeout(600); // debounced save
			const saved = await obsidianPage.evaluate(async (id) => {
				const plugin = (window as any).app.plugins.plugins["commonplace-notes"];
				const onDisk = await plugin.loadData();
				const p = onDisk.publishingProfiles.find((x: any) => x.id === id);
				return { prefix: p.awsSettings.s3Prefix, excluded: p.excludedDirectories, mode: p.awsSettings.credentialMode };
			}, TEMP_ID);
			expect(saved).toEqual({ prefix: "site/", excluded: ["private/", "**/drafts/"], mode: "custom-command" });
		} finally {
			await removeTempProfile(obsidianPage);
		}
	});

	test("renaming a profile keeps its page open; the list updates on reopen", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		await addTempProfile(obsidianPage, "E2E Rename");
		try {
			await openCpnSettings(obsidianPage, ["E2E Rename"]);
			await settingRow(obsidianPage, "Profile name").locator("input").fill("E2E Renamed");
			// Force a rebuild while the page is open: it must not go blank.
			await obsidianPage.evaluate(() => (window as any).app.plugins.plugins["commonplace-notes"].settingTab.refresh());
			await obsidianPage.waitForTimeout(200);
			expect(await rowNames(obsidianPage)).toContain("Profile name");
			expect(await currentSettingsPageTitle(obsidianPage)).toBe("E2E Rename");

			await closeSettings(obsidianPage);
			await openCpnSettings(obsidianPage);
			expect(await profileRowNames(obsidianPage)).toContain("E2E Renamed");
		} finally {
			await removeTempProfile(obsidianPage);
		}
	});

	test("searching \"S3 bucket\" lists each profile's row and opens it", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		await addTempProfile(obsidianPage, "E2E Search");
		try {
			await openCpnSettings(obsidianPage);
			const search = obsidianPage.locator(".modal.mod-settings input[type=search]").first();
			await search.fill("S3 bucket");
			const group = obsidianPage.locator(".modal.mod-settings .setting-search-result-group")
				.filter({ has: obsidianPage.locator(".setting-search-result-tab-label", { hasText: /^E2E Search$/ }) });
			await expect(group).toHaveCount(1);
			await group.locator(".setting-search-result-item", { hasText: "S3 bucket name" }).click();
			await expect(obsidianPage.locator(`${SETTINGS_CONTENT} .setting-page-title`)).toHaveText("E2E Search");
			await expect(settingRow(obsidianPage, "S3 bucket name")).toHaveClass(/is-flashing/);
		} finally {
			await removeTempProfile(obsidianPage);
		}
	});

	test("Infrastructure is a group; Danger Zone and other heavy areas are sub-pages", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		await addTempProfile(obsidianPage, "E2E Layout");
		try {
			await openCpnSettings(obsidianPage, ["E2E Layout"]);
			const layout = await obsidianPage.evaluate((root) => ({
				headings: Array.from(document.querySelectorAll(`${root} .setting-item-heading .setting-item-name`)).map(e => e.textContent?.trim()),
				pages: Array.from(document.querySelectorAll(`${root} .setting-item.mod-navigable .setting-item-name`)).map(e => e.textContent?.trim()),
			}), SETTINGS_CONTENT);
			for (const heading of ["Profile Identity", "Content", "Destination", "Infrastructure", "Authentication & Delivery", "Site Customization"]) {
				expect(layout.headings).toContain(heading);
			}
			for (const sub of ["Danger Zone", "Access groups", "Deploy hooks", "Theme color overrides", "Named styles"]) {
				expect(layout.pages).toContain(sub);
				expect(layout.headings).not.toContain(sub);
			}
			// Not deployed: the Deploy button shows inline under Infrastructure.
			await expect(settingRow(obsidianPage, "Deploy infrastructure").locator("button")).toHaveText("Deploy Infrastructure");

			await openSettingsPage(obsidianPage, "Danger Zone");
			await expect(settingRow(obsidianPage, "Delete profile")).toBeVisible();
			await expect(settingRow(obsidianPage, "Destroy infrastructure")).toBeHidden();
		} finally {
			await removeTempProfile(obsidianPage);
		}
	});

	test("deleting a profile from its Danger Zone leaves a placeholder page", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		await addTempProfile(obsidianPage, "E2E Delete");
		try {
			await openCpnSettings(obsidianPage, ["E2E Delete", "Danger Zone"]);
			const button = settingRow(obsidianPage, "Delete profile").locator("button");
			await button.click();
			await expect(button).toHaveText("Click again to confirm deletion");
			await button.click();
			await expect(settingRow(obsidianPage, "Profile removed")).toBeVisible();
			const remaining = await obsidianPage.evaluate((id) =>
				(window as any).app.plugins.plugins["commonplace-notes"].settings.publishingProfiles.some((p: any) => p.id === id), TEMP_ID);
			expect(remaining).toBe(false);
			// The list no longer offers it.
			await openCpnSettings(obsidianPage);
			expect(await profileRowNames(obsidianPage)).not.toContain("E2E Delete");
		} finally {
			await removeTempProfile(obsidianPage);
		}
	});

	test("a theme color override saves, and Restore default drops it", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		await addTempProfile(obsidianPage, "E2E Theme");
		const linkColor = () => obsidianPage.evaluate((id) =>
			(window as any).app.plugins.plugins["commonplace-notes"].settings.publishingProfiles
				.find((p: any) => p.id === id)?.siteCustomization?.themeOverrides?.light?.linkColor ?? null, TEMP_ID);
		try {
			await openCpnSettings(obsidianPage, ["E2E Theme", "Theme color overrides"]);
			const row = settingRow(obsidianPage, "Link color");
			await row.locator("input[type=color]").fill("#123456");
			await expect.poll(linkColor).toBe("#123456");
			await row.locator('[aria-label="Restore default"]').click();
			await expect.poll(linkColor).toBe(null);
		} finally {
			await removeTempProfile(obsidianPage);
		}
	});

	test("access groups: add a group, rename it on its page", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		await addTempProfile(obsidianPage, "E2E Groups");
		const groups = () => obsidianPage.evaluate((id) =>
			Object.keys((window as any).app.plugins.plugins["commonplace-notes"].settings.publishingProfiles
				.find((p: any) => p.id === id)?.accessGroups ?? {}), TEMP_ID);
		try {
			await openCpnSettings(obsidianPage, ["E2E Groups", "Access groups"]);
			await obsidianPage.locator(`${SETTINGS_CONTENT} [aria-label="Add group"]`).click();
			await expect.poll(groups).toEqual(["group"]);
			await openSettingsPage(obsidianPage, "group");
			const name = settingRow(obsidianPage, "Group name").locator("input");
			await name.fill("family");
			await name.press("Enter");
			await expect.poll(groups).toEqual(["family"]);
			// Still on the group's page (its name updates when Settings reopens).
			expect(await currentSettingsPageTitle(obsidianPage)).toBe("group");
			await expect(settingRow(obsidianPage, "Members")).toBeVisible();
			await settingRow(obsidianPage, "Members").locator("textarea").fill("Alice@Example.com\nnot-an-email");
			await expect(settingRow(obsidianPage, "Members")).toContainText("Not an email address: not-an-email");
		} finally {
			await removeTempProfile(obsidianPage);
		}
	});

	test("header links: add a link and edit it", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		await addTempProfile(obsidianPage, "E2E Links");
		const links = () => obsidianPage.evaluate((id) =>
			(window as any).app.plugins.plugins["commonplace-notes"].settings.publishingProfiles
				.find((p: any) => p.id === id)?.siteCustomization?.headerLinks ?? [], TEMP_ID);
		try {
			await openCpnSettings(obsidianPage, ["E2E Links"]);
			await obsidianPage.locator(`${SETTINGS_CONTENT} [aria-label="Add link"]`).click();
			await expect.poll(async () => (await links()).length).toBe(1);
			const input = obsidianPage.locator(`${SETTINGS_CONTENT} input[placeholder="Label"]`).first();
			await input.fill("About");
			await expect.poll(links).toEqual([{ label: "About", url: "" }]);
		} finally {
			await removeTempProfile(obsidianPage);
		}
	});

	test("loading settings strips the retired tab-bar UI state", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);
		const result = await obsidianPage.evaluate(async () => {
			const plugin = (window as any).app.plugins.plugins["commonplace-notes"];
			const reload = async (uiState: unknown) => {
				plugin.settings.settingsUiState = uiState;
				await plugin.saveSettings();
				await plugin.loadSettings();
				return (await plugin.loadData()).settingsUiState ?? null;
			};
			const onlyLegacy = await reload({ activeTab: "profiles", collapsedSections: { "Danger Zone": true } });
			const withOther = await reload({ activeTab: "general", keep: 1 });
			delete plugin.settings.settingsUiState;
			await plugin.saveSettings();
			plugin.settingTab.refresh();
			return { onlyLegacy, withOther };
		});
		expect(result).toEqual({ onlyLegacy: null, withOther: { keep: 1 } });
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
