#!/usr/bin/env npx tsx
/**
 * Infrastructure "Apply to Profile" E2E Test
 *
 * Tests the full UI flow of the deployment wizard's "Apply to Profile"
 * button by actually opening the settings tab, clicking through the wizard
 * modal, and verifying persistence. Uses mocked CloudFormation responses
 * to avoid real AWS calls.
 *
 * Scenarios:
 *   1. Plugin settings tab opens and shows Infrastructure section
 *   2. "Deploy Infrastructure" button opens wizard modal
 *   3. Wizard step 1 renders with expected form fields
 *   4. Mocked deployment completes and shows step 5 (completion)
 *   5. "Apply to Profile" persists settings to memory and disk
 *   6. After modal close, settings survive in memory
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { waitForSelector } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_OUTPUTS = {
	bucketName: "published-notes-999888777666-cpn-e2etest",
	distributionId: "E2ETESTDISTID",
	distributionDomainName: "d999888.cloudfront.net",
	siteUrl: "d999888.cloudfront.net",
};

const MOCK_VARIANT = "e2etest";
const MOCK_REGION = "us-west-2";
const MOCK_AWS_PROFILE = "cpn-dev";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openPluginSettings(ctx: TestContext): Promise<boolean> {
	const { page } = ctx;

	// Open settings via Cmd+,
	await page.keyboard.press("Meta+,");
	await page.waitForTimeout(1500);

	// Look for the settings modal
	const settingsModal = await waitForSelector(page, ".vertical-tab-header", 5000);
	if (!settingsModal) {
		ctx.fail("Open plugin settings", "Settings modal did not appear after Cmd+,");
		return false;
	}

	// Find and click the "Commonplace Notes" tab in the left sidebar
	const found = await page.evaluate(() => {
		const allTabs = document.querySelectorAll(".vertical-tab-nav-item");
		for (const tab of allTabs) {
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

async function mockCloudFormationManager(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	await page.evaluate((args) => {
		const { mockOutputs, mockVariant } = args;
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		if (!plugin?.cloudFormationManager) return;

		const cfm = plugin.cloudFormationManager;

		cfm.deployFullStack = async () => `cpn-${mockVariant}`;
		cfm.deployCertificateStack = async () => `cpn-cert-${mockVariant}`;

		cfm.pollStackUntilComplete = async (
			_stackName: string,
			_profile: any,
			onEvent: (event: any) => void,
		) => {
			onEvent({
				resourceType: "AWS::S3::Bucket",
				logicalResourceId: "PublishedNotesBucket",
				status: "CREATE_COMPLETE",
				timestamp: new Date(),
			});
			onEvent({
				resourceType: "AWS::CloudFront::Distribution",
				logicalResourceId: "Distribution",
				status: "CREATE_COMPLETE",
				timestamp: new Date(),
			});
			return "CREATE_COMPLETE";
		};

		cfm.getStackOutputs = async () => mockOutputs;
		cfm.listHostedZones = async () => [];
		cfm.getCertificateArn = async () => "arn:aws:acm:us-east-1:999888777666:certificate/fake";
		cfm.getCertificateValidationRecords = async () => [];
		cfm.checkCertificateStatus = async () => "ISSUED";

		// Certificate reuse: a wildcard cert that covers a subdomain site.
		const wildcardMatch = {
			arn: "arn:aws:acm:us-east-1:999888777666:certificate/reused-wildcard",
			domainName: "example.com",
			sans: ["*.example.com"],
			matchType: "wildcard",
			notAfter: 4102444800000, // 2100-01-01
			inUse: true,
		};
		cfm.findMatchingCertificates = async () => [wildcardMatch];
		cfm.listIssuedCertificatesForDomain = async () => [wildcardMatch];
		cfm.describeCertificateForReuse = async () => wildcardMatch;
	}, { mockOutputs: MOCK_OUTPUTS, mockVariant: MOCK_VARIANT });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testSettingsTabShowsInfraSection(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Settings tab shows Infrastructure section");
	const { page } = ctx;

	const opened = await openPluginSettings(ctx);
	if (!opened) return;

	// Look for the Infrastructure section heading
	const found = await page.evaluate(() => {
		const headings = document.querySelectorAll(".cpn-settings-section-heading");
		for (const h of headings) {
			if (h.textContent?.includes("Infrastructure")) return true;
		}
		// Fallback: check for any h4 containing "Infrastructure"
		const h4s = document.querySelectorAll("h4");
		for (const h of h4s) {
			if (h.textContent?.includes("Infrastructure")) return true;
		}
		return false;
	});

	if (!found) {
		// Dump what we can see for debugging
		const visibleSections = await page.evaluate(() => {
			const headings = document.querySelectorAll("h4");
			return Array.from(headings).map(h => h.textContent?.trim()).filter(Boolean);
		});
		ctx.fail("Infrastructure section visible",
			`Could not find 'Infrastructure' heading. Visible h4s: [${visibleSections.join(", ")}]`);
		return;
	}

	ctx.pass("Infrastructure section visible", "Found Infrastructure section in plugin settings");
}

async function testDeployButtonOpensWizard(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Deploy Infrastructure button opens wizard modal");
	const { page } = ctx;

	// Close and reopen settings to force re-render with clean state
	await page.keyboard.press("Escape");
	await page.waitForTimeout(500);
	const reopened = await openPluginSettings(ctx);
	if (!reopened) return;

	// Debug: list all visible buttons
	const allButtons = await page.evaluate(() => {
		const buttons = document.querySelectorAll("button");
		return Array.from(buttons).map(b => b.textContent?.trim()).filter(Boolean).slice(0, 20);
	});
	console.log(`  Visible buttons: [${allButtons.join(", ")}]`);

	const clickedDeploy = await page.evaluate(() => {
		const buttons = document.querySelectorAll("button");
		for (const btn of buttons) {
			if (btn.textContent?.includes("Deploy Infrastructure")) {
				btn.click();
				return true;
			}
		}
		return false;
	});

	if (!clickedDeploy) {
		ctx.fail("Deploy button opens wizard", "Could not find 'Deploy Infrastructure' button");
		return;
	}

	await page.waitForTimeout(800);

	const wizardExists = await page.evaluate(() => {
		return !!document.querySelector(".cpn-wizard-modal");
	});

	if (!wizardExists) {
		ctx.fail("Deploy button opens wizard", "Wizard modal (.cpn-wizard-modal) did not appear after click");
		return;
	}

	ctx.pass("Deploy button opens wizard", "Wizard modal opened successfully");
}

async function testWizardStep1HasFields(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Wizard step 1 has expected form fields");
	const { page } = ctx;

	const fields = await page.evaluate(() => {
		const modal = document.querySelector(".cpn-wizard-modal");
		if (!modal) return { error: "modal not found" };

		const settingNames = Array.from(modal.querySelectorAll(".setting-item-name"))
			.map(el => el.textContent?.trim())
			.filter(Boolean);

		return {
			names: settingNames,
			hasAwsProfile: settingNames.some(n => n?.includes("AWS Profile")),
			hasRegion: settingNames.some(n => n?.includes("Region")),
		};
	});

	if (fields.error) {
		ctx.fail("Wizard step 1 fields", fields.error);
		return;
	}

	if (!fields.hasAwsProfile || !fields.hasRegion) {
		ctx.fail("Wizard step 1 fields",
			`Missing required fields. Found: [${fields.names?.join(", ")}]`);
		return;
	}

	ctx.pass("Wizard step 1 fields", `Step 1 fields: [${fields.names?.join(", ")}]`);
}

async function testFillWizardAndDeploy(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Fill wizard, mock-deploy, reach completion step");
	const { page } = ctx;

	// Fill in fields by finding setting items and their inputs
	await page.evaluate((args) => {
		const { awsProfile, region, variant } = args;
		const modal = document.querySelector(".cpn-wizard-modal");
		if (!modal) return;

		const settings = modal.querySelectorAll(".setting-item");
		for (const setting of settings) {
			const name = setting.querySelector(".setting-item-name")?.textContent?.trim();
			const input = setting.querySelector<HTMLInputElement>("input[type='text']");
			if (!input) continue;

			if (name?.includes("AWS Profile")) {
				// Clear and set value
				input.value = awsProfile;
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.dispatchEvent(new Event("change", { bubbles: true }));
			} else if (name === "Region") {
				input.value = region;
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.dispatchEvent(new Event("change", { bubbles: true }));
			} else if (name?.includes("Variant")) {
				input.value = variant;
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.dispatchEvent(new Event("change", { bubbles: true }));
			}
		}
	}, { awsProfile: MOCK_AWS_PROFILE, region: MOCK_REGION, variant: MOCK_VARIANT });

	await page.waitForTimeout(300);

	// Click "Next"
	const clickedNext = await page.evaluate(() => {
		const modal = document.querySelector(".cpn-wizard-modal");
		if (!modal) return false;
		const buttons = modal.querySelectorAll("button");
		for (const btn of buttons) {
			if (btn.textContent?.trim() === "Next") {
				btn.click();
				return true;
			}
		}
		return false;
	});

	if (!clickedNext) {
		ctx.fail("Fill wizard and deploy", "Could not find 'Next' button in wizard");
		return;
	}

	// No custom domain → skips to step 4 (deploy). With mocks, it completes instantly.
	// Wait for completion step
	await page.waitForTimeout(3000);

	const reachedCompletion = await page.evaluate(() => {
		const modal = document.querySelector(".cpn-wizard-modal");
		if (!modal) return { reached: false, content: "modal gone" };
		const text = modal.textContent || "";
		return {
			reached: text.includes("Deployment Complete") || text.includes("Apply to Profile"),
			content: text.substring(0, 300),
		};
	});

	if (!reachedCompletion.reached) {
		ctx.fail("Fill wizard and deploy",
			`Did not reach completion. Modal content: "${reachedCompletion.content}"`);
		return;
	}

	ctx.pass("Fill wizard and deploy", "Reached completion step with Apply to Profile button");
}

async function testApplyToProfilePersists(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: 'Apply to Profile' persists settings to memory and disk");
	const { page } = ctx;

	// Click "Apply to Profile"
	const clicked = await page.evaluate(() => {
		const modal = document.querySelector(".cpn-wizard-modal");
		if (!modal) return false;
		const buttons = modal.querySelectorAll("button");
		for (const btn of buttons) {
			if (btn.textContent?.includes("Apply to Profile")) {
				btn.click();
				return true;
			}
		}
		return false;
	});

	if (!clicked) {
		ctx.fail("Apply to Profile persists", "Could not find 'Apply to Profile' button");
		return;
	}

	// Wait for async save
	await page.waitForTimeout(2000);

	// Verify in-memory
	const memoryState = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		const profile = plugin?.settings?.publishingProfiles?.[0];
		return {
			bucketName: profile?.awsSettings?.bucketName,
			distributionId: profile?.awsSettings?.cloudFrontDistributionId,
			region: profile?.awsSettings?.region,
			awsProfile: profile?.awsSettings?.awsProfile,
			baseUrl: profile?.baseUrl,
			infraStatus: profile?.infrastructureState?.status,
			fullStackName: profile?.infrastructureState?.fullStackName,
			originAccessMethod: profile?.infrastructureState?.originAccessMethod,
			variantName: profile?.infrastructureState?.variantName,
		};
	});

	if (memoryState.bucketName !== MOCK_OUTPUTS.bucketName) {
		ctx.fail("Apply to Profile persists",
			`In-memory bucketName wrong: "${memoryState.bucketName}" (expected "${MOCK_OUTPUTS.bucketName}")`);
		return;
	}

	if (memoryState.infraStatus !== "deployed") {
		ctx.fail("Apply to Profile persists",
			`In-memory infraStatus: "${memoryState.infraStatus}" (expected "deployed")`);
		return;
	}

	// Verify on disk via loadData()
	const diskState = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		const raw = await plugin.loadData();
		const profile = raw?.publishingProfiles?.[0];
		return {
			bucketName: profile?.awsSettings?.bucketName,
			distributionId: profile?.awsSettings?.cloudFrontDistributionId,
			infraStatus: profile?.infrastructureState?.status,
			fullStackName: profile?.infrastructureState?.fullStackName,
		};
	});

	if (diskState.bucketName !== MOCK_OUTPUTS.bucketName) {
		ctx.fail("Apply to Profile persists",
			`DISK bucketName: "${diskState.bucketName}" (expected "${MOCK_OUTPUTS.bucketName}"). Settings did NOT persist to disk!`);
		return;
	}

	if (diskState.infraStatus !== "deployed") {
		ctx.fail("Apply to Profile persists",
			`DISK infraStatus: "${diskState.infraStatus}" (expected "deployed"). InfrastructureState did NOT persist!`);
		return;
	}

	ctx.pass("Apply to Profile persists",
		`Memory AND disk both correct. bucket=${diskState.bucketName}, status=${diskState.infraStatus}, stack=${diskState.fullStackName}`);
}

async function testSettingsSurviveModalClose(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: Settings survive after modal close");
	const { page } = ctx;

	// Click "Done" to close wizard
	await page.evaluate(() => {
		const modal = document.querySelector(".cpn-wizard-modal");
		if (!modal) return;
		const buttons = modal.querySelectorAll("button");
		for (const btn of buttons) {
			if (btn.textContent?.trim() === "Done") {
				btn.click();
				return;
			}
		}
	});

	await page.waitForTimeout(1000);

	// Verify modal closed
	const modalClosed = await page.evaluate(() => !document.querySelector(".cpn-wizard-modal"));
	if (!modalClosed) {
		ctx.fail("Settings survive modal close", "Modal still open after clicking Done");
		return;
	}

	// Verify settings are still in memory after modal close
	const afterClose = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		const profile = plugin?.settings?.publishingProfiles?.[0];
		return {
			bucketName: profile?.awsSettings?.bucketName,
			infraStatus: profile?.infrastructureState?.status,
			fullStackName: profile?.infrastructureState?.fullStackName,
		};
	});

	if (afterClose.bucketName !== MOCK_OUTPUTS.bucketName) {
		ctx.fail("Settings survive modal close",
			`bucketName LOST after modal close: "${afterClose.bucketName}"`);
		return;
	}

	if (afterClose.infraStatus !== "deployed") {
		ctx.fail("Settings survive modal close",
			`infraStatus LOST after modal close: "${afterClose.infraStatus}"`);
		return;
	}

	// Also verify disk state one more time
	const diskAfterClose = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		const raw = await plugin.loadData();
		const profile = raw?.publishingProfiles?.[0];
		return {
			bucketName: profile?.awsSettings?.bucketName,
			infraStatus: profile?.infrastructureState?.status,
		};
	});

	if (diskAfterClose.bucketName !== MOCK_OUTPUTS.bucketName) {
		ctx.fail("Settings survive modal close",
			`DISK data lost after modal close! bucket="${diskAfterClose.bucketName}"`);
		return;
	}

	ctx.pass("Settings survive modal close",
		`All settings intact: memory bucket=${afterClose.bucketName}, disk bucket=${diskAfterClose.bucketName}, status=${afterClose.infraStatus}`);
}

async function testCertificateReuseFlow(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: Custom domain reuses an existing certificate (skips creation + DNS)");
	const { page } = ctx;

	// Reset to a clean, undeployed profile and reopen the wizard.
	await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		const profile = plugin?.settings?.publishingProfiles?.[0];
		if (profile) {
			delete profile.infrastructureState;
			profile.awsSettings.bucketName = "my-bucket";
			profile.awsSettings.cloudFrontDistributionId = "";
			profile.baseUrl = "";
		}
		await plugin.saveSettings();
	});

	await page.keyboard.press("Escape");
	await page.waitForTimeout(500);
	const reopened = await openPluginSettings(ctx);
	if (!reopened) return;

	const clickedDeploy = await page.evaluate(() => {
		const buttons = document.querySelectorAll("button");
		for (const btn of buttons) {
			if (btn.textContent?.includes("Deploy Infrastructure")) { btn.click(); return true; }
		}
		return false;
	});
	if (!clickedDeploy) {
		ctx.fail("Certificate reuse flow", "Could not find 'Deploy Infrastructure' button");
		return;
	}
	await page.waitForTimeout(800);

	// Fill step 1 including a custom subdomain, then click Next.
	await page.evaluate((args) => {
		const { awsProfile, region, variant, domain } = args;
		const modal = document.querySelector(".cpn-wizard-modal");
		if (!modal) return;
		const settings = modal.querySelectorAll(".setting-item");
		for (const setting of settings) {
			const name = setting.querySelector(".setting-item-name")?.textContent?.trim();
			const input = setting.querySelector<HTMLInputElement>("input[type='text']");
			if (!input) continue;
			let value: string | null = null;
			if (name?.includes("AWS Profile")) value = awsProfile;
			else if (name === "Region") value = region;
			else if (name?.includes("Variant")) value = variant;
			else if (name?.includes("Custom Domain")) value = domain;
			if (value === null) continue;
			input.value = value;
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
		}
	}, { awsProfile: MOCK_AWS_PROFILE, region: MOCK_REGION, variant: MOCK_VARIANT, domain: "notes.example.com" });
	await page.waitForTimeout(300);

	await page.evaluate(() => {
		const modal = document.querySelector(".cpn-wizard-modal");
		const buttons = modal?.querySelectorAll("button") || [];
		for (const btn of buttons) {
			if (btn.textContent?.trim() === "Next") { btn.click(); return; }
		}
	});

	// Step 2 (Certificate chooser) does an async lookup, then renders the dropdown.
	await page.waitForTimeout(1000);

	const chooserText = await page.evaluate(() => {
		const modal = document.querySelector(".cpn-wizard-modal");
		return modal?.textContent || "";
	});
	if (!chooserText.includes("existing certificate")) {
		ctx.fail("Certificate reuse flow",
			`Certificate chooser did not appear. Modal text: "${chooserText.substring(0, 300)}"`);
		return;
	}

	// The wildcard match is preselected — click "Continue" to reuse it.
	const clickedContinue = await page.evaluate(() => {
		const modal = document.querySelector(".cpn-wizard-modal");
		const buttons = modal?.querySelectorAll("button") || [];
		for (const btn of buttons) {
			if (btn.textContent?.trim() === "Continue") { btn.click(); return true; }
		}
		return false;
	});
	if (!clickedContinue) {
		ctx.fail("Certificate reuse flow", "Could not find 'Continue' button on the certificate chooser");
		return;
	}

	// Reuse skips cert creation + DNS and (no auth) deploys the full stack directly.
	await page.waitForTimeout(3000);

	const reachedCompletion = await page.evaluate(() => {
		const modal = document.querySelector(".cpn-wizard-modal");
		const text = modal?.textContent || "";
		return text.includes("Deployment Complete") || text.includes("Apply to Profile");
	});
	if (!reachedCompletion) {
		ctx.fail("Certificate reuse flow", "Did not reach completion after reusing the certificate");
		return;
	}

	// Apply to profile, then assert the reuse bookkeeping persisted correctly.
	await page.evaluate(() => {
		const modal = document.querySelector(".cpn-wizard-modal");
		const buttons = modal?.querySelectorAll("button") || [];
		for (const btn of buttons) {
			if (btn.textContent?.includes("Apply to Profile")) { btn.click(); return; }
		}
	});
	await page.waitForTimeout(2000);

	const state = await page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		const profile = plugin?.settings?.publishingProfiles?.[0];
		const s = profile?.infrastructureState;
		return {
			certificateArn: s?.certificateArn,
			certificateReused: s?.certificateReused,
			certStackName: s?.certStackName ?? null,
			customDomain: s?.customDomain,
		};
	});

	if (state.certificateReused !== true) {
		ctx.fail("Certificate reuse flow",
			`certificateReused should be true, got ${JSON.stringify(state.certificateReused)}`);
		return;
	}
	if (state.certStackName !== null) {
		ctx.fail("Certificate reuse flow",
			`certStackName should be unset for a reused cert, got "${state.certStackName}"`);
		return;
	}
	if (!state.certificateArn?.includes("reused-wildcard")) {
		ctx.fail("Certificate reuse flow",
			`certificateArn should be the reused ARN, got "${state.certificateArn}"`);
		return;
	}

	ctx.pass("Certificate reuse flow",
		`Reused cert persisted: arn=…${state.certificateArn.slice(-14)}, reused=${state.certificateReused}, no certStackName`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000);

	// Reset profile to clean state (remove any infrastructure state from prior runs)
	await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		if (!plugin) return;
		const profile = plugin.settings.publishingProfiles[0];
		if (profile) {
			delete profile.infrastructureState;
			profile.awsSettings.bucketName = "my-bucket";
			profile.awsSettings.cloudFrontDistributionId = "";
			profile.baseUrl = "";
		}
		await plugin.saveSettings();
	});

	// Install mocks before interacting with wizard
	await mockCloudFormationManager(ctx);

	await testSettingsTabShowsInfraSection(ctx);
	await testDeployButtonOpensWizard(ctx);
	await testWizardStep1HasFields(ctx);
	await testFillWizardAndDeploy(ctx);
	await testApplyToProfilePersists(ctx);
	await testSettingsSurviveModalClose(ctx);
	await testCertificateReuseFlow(ctx);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runTest({ name: "infrastructure-apply-profile" }, tests);
