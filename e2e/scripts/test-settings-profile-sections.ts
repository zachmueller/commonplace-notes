#!/usr/bin/env npx tsx
/**
 * Settings profile sections E2E Test
 *
 * Regression test: the profile page must render every section for a deployed
 * site with a Cognito pool, whatever state its Cognito gate is in. A throw
 * while rendering one section (it used to be `setClass('')` on the "Redeploy"
 * button once the gate was upgraded) is caught by the settings tab, and every
 * section after it silently disappears, including Access groups.
 *
 * Seeds a deployed public site (readGateMode 'none') with a Cognito pool, like
 * a real site with comments. Makes NO AWS calls.
 *
 * Scenarios:
 *   1. Gate up to date (accessGroupsKey set): all sections render; button is
 *      "Redeploy" without mod-cta.
 *   2. Gate needs upgrade (no accessGroupsKey): all sections render; button is
 *      "Upgrade Cognito gate" with mod-cta.
 *   3. Public-site gating opted in, edge fn not deployed: all sections render;
 *      button is "Deploy access-groups edge function" with mod-cta.
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { waitForSelector } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const EXPECTED_SECTIONS = [
	"Profile Identity",
	"Content",
	"Destination",
	"Infrastructure",
	"Authentication & Delivery",
	"Site Customization",
	"Deploy hooks",
	"Access groups",
	"Danger Zone",
];

type Variant = "up-to-date" | "needs-upgrade" | "public-gating";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Seed profile 0 as a deployed public site with a Cognito pool in `variant` state. */
async function seedProfile(ctx: TestContext, variant: Variant): Promise<boolean> {
	const ok = await ctx.page.evaluate(async (variant: Variant) => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		const profile = plugin?.settings?.publishingProfiles?.[0];
		if (!profile) return false;

		profile.publishMechanism = "AWS";
		profile.baseUrl = "https://notes.example.com/";
		profile.awsSettings = {
			awsProfile: "cpn-dev",
			region: "us-east-1",
			awsAccountId: "999888777666",
			bucketName: "published-notes-999888777666-cpn-public",
			cloudFrontDistributionId: "EPUBLICDIST",
		};
		const cognitoAuth: Record<string, unknown> = {
			stackName: "cpn-cognito-public",
			enabled: true,
			commentIdentity: true,
			userPoolId: "us-east-1_pool",
			userPoolClientId: "client",
			hostedUiDomain: "https://cpn-public-x.auth.us-east-1.amazoncognito.com",
			jwksUri: "x",
			issuer: "x",
			edgeFunctionVersionArn: "",
			callbackApiDomain: "x",
		};
		if (variant === "up-to-date") {
			cognitoAuth.accessGroupsBucket = "cpn-assets-999888777666-us-east-1";
			cognitoAuth.accessGroupsKey = "access-groups/cpn-public.json";
		}
		profile.infrastructureState = {
			status: "deployed",
			fullStackName: "cpn-public",
			region: "us-east-1",
			variantName: "public",
			useRoute53: false,
			originAccessMethod: "oac",
			readGateMode: "none",
			cognitoAuth,
		};
		profile.cognitoAuth = { enabled: true, commentIdentity: true };
		profile.commenting = { enabled: true };
		if (variant === "public-gating") profile.publicSiteAccessGroups = true;
		else delete profile.publicSiteAccessGroups;

		plugin.settings.settingsUiState = { ...(plugin.settings.settingsUiState ?? {}), activeTab: "profiles" };
		await plugin.saveSettings();
		return true;
	}, variant);
	if (!ok) ctx.fail(`Seed profile (${variant})`, "Plugin or profile 0 not available");
	return ok;
}

/** Open Settings → Commonplace Notes fresh, so the tab re-renders from settings. */
async function openPluginSettings(ctx: TestContext): Promise<boolean> {
	const { page } = ctx;

	// Close any settings modal left open by a previous scenario.
	if (await page.$(".vertical-tab-header")) {
		await page.keyboard.press("Escape");
		await page.waitForTimeout(500);
	}

	await page.keyboard.press("Meta+,");
	await page.waitForTimeout(1500);
	if (!await waitForSelector(page, ".vertical-tab-header", 5000)) {
		ctx.fail("Open plugin settings", "Settings modal did not appear after Cmd+,");
		return false;
	}

	const found = await page.evaluate(() => {
		for (const tab of document.querySelectorAll(".vertical-tab-nav-item")) {
			if (tab.textContent?.includes("Commonplace Notes")) {
				(tab as HTMLElement).click();
				return true;
			}
		}
		return false;
	});
	if (!found) {
		ctx.fail("Open plugin settings", "Could not find 'Commonplace Notes' tab in settings sidebar");
		return false;
	}
	await page.waitForTimeout(800);
	return true;
}

async function readProfilePage(ctx: TestContext) {
	return ctx.page.evaluate(() => {
		const container = document.querySelector(".cpn-profile-container")?.parentElement ?? document;
		const sections = Array.from(container.querySelectorAll(".cpn-settings-section-summary"))
			.map(s => s.textContent?.trim() ?? "");
		const gate = Array.from(container.querySelectorAll(".setting-item"))
			.find(el => el.querySelector(".setting-item-name")?.textContent?.trim() === "Cognito gate");
		const btn = gate?.querySelector("button");
		const renderError = container.querySelector(".cpn-profile-render-error")?.textContent ?? null;
		return {
			sections,
			gateButton: btn ? { text: btn.textContent?.trim() ?? "", cta: btn.classList.contains("mod-cta") } : null,
			renderError,
		};
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testVariant(
	ctx: TestContext,
	n: number,
	variant: Variant,
	expected: { text: string; cta: boolean },
): Promise<void> {
	console.log(`\nTest ${n}: Profile page renders fully (${variant})`);

	if (!await seedProfile(ctx, variant)) return;
	if (!await openPluginSettings(ctx)) return;

	const page = await readProfilePage(ctx);
	const shot = await ctx.screenshot(`profile-sections-${variant}`);
	console.log(`  Sections: [${page.sections.join(", ")}]`);

	if (page.renderError) {
		ctx.fail(`No render error (${variant})`, `Render error shown: ${page.renderError} (${shot})`);
	} else {
		ctx.pass(`No render error (${variant})`, "No profile render-error banner");
	}

	const missing = EXPECTED_SECTIONS.filter(s => !page.sections.includes(s));
	if (missing.length) {
		ctx.fail(`All sections render (${variant})`, `Missing: [${missing.join(", ")}]. Got: [${page.sections.join(", ")}] (${shot})`);
	} else {
		ctx.pass(`All sections render (${variant})`, `All ${EXPECTED_SECTIONS.length} sections present`);
	}

	if (!page.gateButton) {
		ctx.fail(`Cognito gate button (${variant})`, `No "Cognito gate" row with a button (${shot})`);
	} else if (page.gateButton.text !== expected.text || page.gateButton.cta !== expected.cta) {
		ctx.fail(`Cognito gate button (${variant})`,
			`Got "${page.gateButton.text}" cta=${page.gateButton.cta}; want "${expected.text}" cta=${expected.cta} (${shot})`);
	} else {
		ctx.pass(`Cognito gate button (${variant})`, `"${expected.text}" cta=${expected.cta}`);
	}
}

function testNoProfileRenderErrorsLogged(ctx: TestContext): void {
	console.log("\nTest 4: No profile render errors logged");
	const errors = ctx.collector.getLogsByLevel("error")
		.filter(l => l.message.includes("Error displaying profile"));
	if (errors.length) {
		ctx.fail("No profile render errors logged", errors.map(e => e.message).join(" | "));
	} else {
		ctx.pass("No profile render errors logged", "No 'Error displaying profile' entries");
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	await ctx.page.waitForTimeout(5_000);

	await testVariant(ctx, 1, "up-to-date", { text: "Redeploy", cta: false });
	await testVariant(ctx, 2, "needs-upgrade", { text: "Upgrade Cognito gate", cta: true });
	await testVariant(ctx, 3, "public-gating", { text: "Deploy access-groups edge function", cta: true });
	testNoProfileRenderErrorsLogged(ctx);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runTest({ name: "settings-profile-sections" }, tests);
