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
import { SETTINGS_CONTENT, closeSettings, openCpnSettings, openSettingsPage } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

/**
 * What an AWS profile's page shows: its groups (headings) and the sub-pages it
 * links to. A section counts if it appears as either, so the check holds while
 * areas move between groups and sub-pages.
 */
const EXPECTED_SECTIONS = [
	"Profile Identity",
	"Content",
	"Attachments (Beta)",
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

		await plugin.saveSettings();
		return true;
	}, variant);
	if (!ok) ctx.fail(`Seed profile (${variant})`, "Plugin or profile 0 not available");
	return ok;
}

/**
 * Open Settings → Commonplace Notes fresh and walk into profile 0's page, so
 * the page re-renders from the seeded settings.
 */
async function openPluginSettings(ctx: TestContext): Promise<boolean> {
	const { page } = ctx;
	await closeSettings(page);
	const name = await page.evaluate(() =>
		(window as any).app?.plugins?.plugins?.["commonplace-notes"]?.settings?.publishingProfiles?.[0]?.name as string | undefined);
	if (!name) {
		ctx.fail("Open plugin settings", "Profile 0 has no name");
		return false;
	}
	try {
		await openCpnSettings(page, [name]);
	} catch (err) {
		ctx.fail("Open plugin settings", `Could not open the "${name}" profile page: ${String(err)}`);
		return false;
	}
	await page.waitForTimeout(500);
	return true;
}

/** Group headings, sub-page rows, the Cognito gate button and any render error on the page on screen. */
async function readSettingsPage(ctx: TestContext) {
	return ctx.page.evaluate((root) => {
		const container = document.querySelector(root) ?? document;
		// No named function expressions in page.evaluate: tsx wraps them in a
		// `__name` helper the page doesn't have.
		const headings = Array.from(container.querySelectorAll(".setting-item-heading .setting-item-name"))
			.filter(e => (e as HTMLElement).offsetParent !== null).map(s => s.textContent?.trim() ?? "");
		const pages = Array.from(container.querySelectorAll(".setting-item.mod-navigable .setting-item-name"))
			.filter(e => (e as HTMLElement).offsetParent !== null).map(s => s.textContent?.trim() ?? "");
		const gate = Array.from(container.querySelectorAll(".setting-item"))
			.find(el => el.querySelector(".setting-item-name")?.textContent?.trim() === "Cognito gate");
		const btn = gate?.querySelector("button");
		const renderError = container.querySelector(".cpn-profile-render-error")?.textContent ?? null;
		return {
			sections: [...headings, ...pages],
			gateButton: btn ? { text: btn.textContent?.trim() ?? "", cta: btn.classList.contains("mod-cta") } : null,
			renderError,
		};
	}, SETTINGS_CONTENT);
}

/** Read the profile page; the Cognito gate may sit on the Infrastructure sub-page. */
async function readProfilePage(ctx: TestContext) {
	const page = await readSettingsPage(ctx);
	if (!page.gateButton && page.sections.includes("Infrastructure")) {
		try {
			await openSettingsPage(ctx.page, "Infrastructure");
			const infra = await readSettingsPage(ctx);
			page.gateButton = infra.gateButton;
			page.renderError = page.renderError ?? infra.renderError;
		} catch {
			// Infrastructure is a group, not a page: nothing more to read.
		}
	}
	return page;
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
