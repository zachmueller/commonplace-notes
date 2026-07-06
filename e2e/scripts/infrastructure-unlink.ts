#!/usr/bin/env npx tsx
/**
 * Infrastructure "Unlink from AWS backend" E2E verification
 *
 * Drives the REAL settings UI in Obsidian to verify the new Unlink button:
 *   1. Seeds a linked + IMPORTED profile plus on-disk mapping files.
 *   2. Confirms the "Unlink from AWS backend" button appears (even imported).
 *   3. Clicks it twice (two-click inline confirm) and lets it run.
 *   4. Asserts the backend-link fields are cleared and the AWS coordinates /
 *      pendingEdgeCleanup are preserved (memory AND disk).
 *   5. Asserts the on-disk profiles/<id>/ mapping tree is untouched.
 *   6. Asserts Deploy + Import buttons reappear (status back to 'none').
 *
 * Makes NO AWS calls — unlink never touches AWS — so no CloudFormation mocks.
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { waitForSelector } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openPluginSettings(ctx: TestContext): Promise<boolean> {
	const { page } = ctx;

	await page.keyboard.press("Meta+,");
	await page.waitForTimeout(1500);

	const settingsModal = await waitForSelector(page, ".vertical-tab-header", 5000);
	if (!settingsModal) {
		ctx.fail("Open plugin settings", "Settings modal did not appear after Cmd+,");
		return false;
	}

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

/** Seed a linked + imported profile and write mapping files to disk. */
async function seedLinkedImportedProfile(ctx: TestContext): Promise<{ profileId: string; mappingDir: string } | null> {
	const { page } = ctx;

	const result = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		if (!plugin) return null;
		const profile = plugin.settings.publishingProfiles[0];
		if (!profile) return null;

		// A fully-linked, IMPORTED profile — the exact stuck state the button targets.
		profile.awsSettings = profile.awsSettings || {};
		profile.awsSettings.awsProfile = "cpn-dev";
		profile.awsSettings.region = "us-west-2";
		profile.awsSettings.awsAccountId = "999888777666";
		profile.awsSettings.bucketName = "published-notes-999888777666-cpn-imported";
		profile.awsSettings.cloudFrontDistributionId = "EIMPORTEDDIST";
		profile.baseUrl = "https://d999888.cloudfront.net/";
		profile.infrastructureState = {
			status: "deployed",
			imported: true,
			fullStackName: "cpn-imported",
			certStackName: "cpn-cert-imported",
			region: "us-west-2",
			variantName: "imported",
			useRoute53: false,
			originAccessMethod: "oac",
			cognitoAuth: { stackName: "cpn-cognito-imported", enabled: true, commentIdentity: true, userPoolId: "pool", userPoolClientId: "client", hostedUiDomain: "x", jwksUri: "x", issuer: "x", edgeFunctionVersionArn: "arn:x", callbackApiDomain: "x" },
			comment: { stackName: "cpn-comment-imported", enabled: true, bucketName: "cb", bucketDomainName: "cbd", apiDomain: "api", tableName: "tbl" },
		};
		profile.readGate = { mode: "cognito" };
		profile.cognitoAuth = { enabled: true, commentIdentity: true };
		profile.commenting = { enabled: true };
		// Real orphaned resource awaiting deletion — must survive an unlink.
		profile.pendingEdgeCleanup = [{ stackName: "cpn-cognito-imported", region: "us-east-1", functionName: "edge-fn", roleName: "edge-role", orphanedAt: 1700000000000 }];
		await plugin.saveSettings();

		// Write the precious on-disk mapping files that must NOT be touched.
		const mappingDir = plugin.profileManager.getMappingDir(profile.id);
		await plugin.profileManager.initializeProfileDirectories(profile.id);
		await plugin.app.vault.adapter.write(mappingDir + "/slug-to-uid.json", JSON.stringify({ "my-note": "UID-ABC-123" }));
		await plugin.app.vault.adapter.write(mappingDir + "/uid-to-hash.json", JSON.stringify({ "UID-ABC-123": "hash-deadbeef" }));

		return { profileId: profile.id, mappingDir };
	});

	if (!result) {
		ctx.fail("Seed linked+imported profile", "Plugin or profile not available");
		return null;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testUnlinkButtonVisibleForImported(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Unlink button visible for a linked, IMPORTED profile");
	const { page } = ctx;

	const opened = await openPluginSettings(ctx);
	if (!opened) return;

	const buttons = await page.evaluate(() =>
		Array.from(document.querySelectorAll("button")).map(b => b.textContent?.trim()).filter(Boolean));
	console.log(`  Visible buttons: [${buttons.join(", ")}]`);

	const hasUnlink = buttons.some(b => b === "Unlink");
	if (!hasUnlink) {
		ctx.fail("Unlink button visible (imported)",
			`No 'Unlink' button found for an imported+linked profile. Buttons: [${buttons.join(", ")}]`);
		return;
	}
	// Sanity: Destroy is correctly disabled for imported; Unlink is the escape hatch.
	ctx.pass("Unlink button visible (imported)", "Found 'Unlink' button for imported+linked profile");
}

async function testTwoClickConfirm(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: First click swaps to confirm label (no state change yet)");
	const { page } = ctx;

	const firstClick = await page.evaluate(() => {
		const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.trim() === "Unlink");
		if (!btn) return { clicked: false };
		btn.click();
		return { clicked: true };
	});
	if (!firstClick.clicked) {
		ctx.fail("Two-click confirm", "Unlink button vanished before first click");
		return;
	}
	await page.waitForTimeout(200);

	const afterFirst = await page.evaluate(() => {
		const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.includes("confirm unlink"));
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		const profile = plugin?.settings?.publishingProfiles?.[0];
		return {
			label: btn?.textContent?.trim() ?? null,
			// State must be UNCHANGED after only the first (arming) click.
			status: profile?.infrastructureState?.status,
			bucketName: profile?.awsSettings?.bucketName,
		};
	});

	if (afterFirst.label !== "Click again to confirm unlink") {
		ctx.fail("Two-click confirm", `Confirm label wrong after first click: "${afterFirst.label}"`);
		return;
	}
	if (afterFirst.status !== "deployed" || !afterFirst.bucketName) {
		ctx.fail("Two-click confirm",
			`State changed on the FIRST click (should require two): status=${afterFirst.status}, bucket=${afterFirst.bucketName}`);
		return;
	}
	ctx.pass("Two-click confirm", "First click armed the confirm label without mutating state");
}

async function testUnlinkClearsAndPreserves(ctx: TestContext, seed: { profileId: string; mappingDir: string }): Promise<void> {
	console.log("\nTest 3: Second click unlinks — clears link fields, preserves the rest");
	const { page } = ctx;

	const clicked = await page.evaluate(() => {
		const btn = Array.from(document.querySelectorAll("button")).find(b => b.textContent?.includes("confirm unlink"));
		if (!btn) return false;
		btn.click();
		return true;
	});
	if (!clicked) {
		ctx.fail("Unlink clears and preserves", "Confirm button gone before second click");
		return;
	}
	await page.waitForTimeout(2000);

	// Memory + disk assertions in one pass.
	const state = await page.evaluate(async (mappingDir: string) => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		const profile = plugin?.settings?.publishingProfiles?.[0];
		const raw = await plugin.loadData();
		const diskProfile = raw?.publishingProfiles?.[0];
		const slugExists = await plugin.app.vault.adapter.exists(mappingDir + "/slug-to-uid.json");
		const hashExists = await plugin.app.vault.adapter.exists(mappingDir + "/uid-to-hash.json");
		const slugContent = slugExists ? await plugin.app.vault.adapter.read(mappingDir + "/slug-to-uid.json") : null;
		return {
			mem: {
				status: profile?.infrastructureState?.status,
				fullStackName: profile?.infrastructureState?.fullStackName,
				cognitoAuth: profile?.infrastructureState?.cognitoAuth,
				bucketName: profile?.awsSettings?.bucketName,
				distributionId: profile?.awsSettings?.cloudFrontDistributionId,
				baseUrl: profile?.baseUrl,
				readGate: profile?.readGate,
				profileCognitoAuth: profile?.cognitoAuth,
				commenting: profile?.commenting,
				// preserved
				awsProfile: profile?.awsSettings?.awsProfile,
				region: profile?.awsSettings?.region,
				awsAccountId: profile?.awsSettings?.awsAccountId,
				pendingEdgeCleanup: profile?.pendingEdgeCleanup,
			},
			disk: {
				status: diskProfile?.infrastructureState?.status,
				bucketName: diskProfile?.awsSettings?.bucketName,
				baseUrl: diskProfile?.baseUrl,
				awsProfile: diskProfile?.awsSettings?.awsProfile,
				pendingEdgeCleanup: diskProfile?.pendingEdgeCleanup,
			},
			slugExists, hashExists, slugContent,
		};
	}, seed.mappingDir);

	// --- Cleared (memory) ---
	const clearedFail: string[] = [];
	if (state.mem.status !== "none") clearedFail.push(`status=${state.mem.status} (want none)`);
	if (state.mem.fullStackName !== undefined) clearedFail.push(`fullStackName=${state.mem.fullStackName} (want undefined)`);
	if (state.mem.cognitoAuth !== undefined) clearedFail.push(`infra.cognitoAuth still set`);
	if (state.mem.bucketName !== "") clearedFail.push(`bucketName="${state.mem.bucketName}" (want "")`);
	if (state.mem.distributionId !== undefined) clearedFail.push(`distributionId=${state.mem.distributionId} (want undefined)`);
	if (state.mem.baseUrl !== "") clearedFail.push(`baseUrl="${state.mem.baseUrl}" (want "")`);
	if (state.mem.readGate !== undefined) clearedFail.push(`readGate still set`);
	if (state.mem.profileCognitoAuth !== undefined) clearedFail.push(`profile.cognitoAuth still set`);
	if (state.mem.commenting !== undefined) clearedFail.push(`commenting still set`);
	if (clearedFail.length) {
		ctx.fail("Unlink clears link fields", `Not cleared: ${clearedFail.join("; ")}`);
		return;
	}
	ctx.pass("Unlink clears link fields",
		`status=none, bucket="", distId=undefined, baseUrl="", readGate/cognito/comment=undefined`);

	// --- Preserved (memory) ---
	const preservedFail: string[] = [];
	if (state.mem.awsProfile !== "cpn-dev") preservedFail.push(`awsProfile=${state.mem.awsProfile}`);
	if (state.mem.region !== "us-west-2") preservedFail.push(`region=${state.mem.region}`);
	if (state.mem.awsAccountId !== "999888777666") preservedFail.push(`awsAccountId=${state.mem.awsAccountId}`);
	if (!Array.isArray(state.mem.pendingEdgeCleanup) || state.mem.pendingEdgeCleanup.length !== 1) {
		preservedFail.push(`pendingEdgeCleanup=${JSON.stringify(state.mem.pendingEdgeCleanup)}`);
	}
	if (preservedFail.length) {
		ctx.fail("Unlink preserves AWS coords + pendingEdgeCleanup", `Lost: ${preservedFail.join("; ")}`);
		return;
	}
	ctx.pass("Unlink preserves AWS coords + pendingEdgeCleanup",
		`awsProfile=cpn-dev, region=us-west-2, account=999888777666, pendingEdgeCleanup(1) intact`);

	// --- Disk persisted correctly ---
	if (state.disk.status !== "none" || state.disk.bucketName !== "" || state.disk.baseUrl !== "" ||
		state.disk.awsProfile !== "cpn-dev" || !Array.isArray(state.disk.pendingEdgeCleanup) || state.disk.pendingEdgeCleanup.length !== 1) {
		ctx.fail("Unlink persists to disk",
			`Disk mismatch: ${JSON.stringify(state.disk)}`);
		return;
	}
	ctx.pass("Unlink persists to disk", `data.json: status=none, bucket="", awsProfile preserved, pendingEdgeCleanup intact`);

	// --- On-disk mapping tree untouched ---
	if (!state.slugExists || !state.hashExists) {
		ctx.fail("Unlink preserves on-disk mapping tree",
			`Mapping files missing after unlink: slug=${state.slugExists}, hash=${state.hashExists}`);
		return;
	}
	if (!state.slugContent?.includes("UID-ABC-123")) {
		ctx.fail("Unlink preserves on-disk mapping tree",
			`slug-to-uid.json content changed: ${state.slugContent}`);
		return;
	}
	ctx.pass("Unlink preserves on-disk mapping tree",
		`slug-to-uid.json + uid-to-hash.json intact with original content (UID-ABC-123)`);
}

async function testDeployImportReappear(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Deploy + Import buttons reappear after unlink");
	const { page } = ctx;

	await page.waitForTimeout(500);
	const buttons = await page.evaluate(() =>
		Array.from(document.querySelectorAll("button")).map(b => b.textContent?.trim()).filter(Boolean));
	console.log(`  Visible buttons: [${buttons.join(", ")}]`);

	const hasDeploy = buttons.some(b => b?.includes("Deploy Infrastructure"));
	const hasImport = buttons.some(b => b === "Import");
	const stillHasUnlink = buttons.some(b => b === "Unlink" || b?.includes("confirm unlink"));

	if (!hasDeploy || !hasImport) {
		ctx.fail("Deploy + Import reappear",
			`Missing recovery buttons. Deploy=${hasDeploy}, Import=${hasImport}. Buttons: [${buttons.join(", ")}]`);
		return;
	}
	if (stillHasUnlink) {
		ctx.fail("Deploy + Import reappear", "Unlink button still visible (should be gone once status=none & unlinked)");
		return;
	}
	ctx.pass("Deploy + Import reappear", "Deploy Infrastructure + Import present; Unlink gone");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000);

	const seed = await seedLinkedImportedProfile(ctx);
	if (!seed) return;
	console.log(`  Seeded profile id=${seed.profileId}, mappingDir=${seed.mappingDir}`);

	await testUnlinkButtonVisibleForImported(ctx);
	await testTwoClickConfirm(ctx);
	await testUnlinkClearsAndPreserves(ctx, seed);
	await testDeployImportReappear(ctx);
}

runTest({ name: "infrastructure-unlink" }, tests);
