#!/usr/bin/env npx tsx
/**
 * Deployment-Variants E2E Test
 *
 * Drives the real deployment wizard (in a live Obsidian) across the many
 * read-gate × commenting variants, with a fully mocked AWS layer, and verifies
 * two things per variant: (a) exactly which CloudFormation sub-stacks the wizard
 * deploys, and (b) the infrastructure state it persists. This exercises the
 * variant-routing logic (cognitoPoolNeeded / needsAuthStep / runCommentDeploy)
 * that decides whether the Cognito pool, password sub-stack, and comment backend
 * are provisioned — the "many variants of the deployment process".
 *
 * Two variants are driven through the actual wizard DOM (proving the UI controls
 * + the post-deploy Google-OAuth-URL and "Publish all notes" surfaces work); the
 * rest are profile-seeded so the real wizard still runs end-to-end without the
 * fragility of clicking every dropdown/toggle.
 *
 * NO real AWS calls: plugin.cloudFormationManager methods and
 * plugin.awsSdkManager clients are monkey-patched in-page (the sanctioned seam —
 * the managers construct their own SDK clients internally).
 *
 * Scenarios:
 *   1. Canonical public (full DOM): no auth, no comments → only the full stack.
 *   2. Canonical Cognito + comments (full DOM): drives read-access dropdown +
 *      both comment toggles + Google fields; asserts all sub-stacks deploy and
 *      the completion screen surfaces the /oauth2/idpresponse URL + publish hint.
 *   3. Variant matrix (profile-seeded): 7 read-gate × commenting combinations,
 *      asserting deployed sub-stack set + persisted state per variant.
 *   4. No plugin errors logged across the whole run.
 *
 * Run: npx tsx e2e/scripts/deployment-variants-e2e.ts
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { waitForSelector } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_REGION = "us-west-2";
const MOCK_AWS_PROFILE = "cpn-dev";
const AUTH_DOMAIN_PREFIX = "my-notes-auth";
const HOSTED_UI_DOMAIN = `https://${AUTH_DOMAIN_PREFIX}.auth.${MOCK_REGION}.amazoncognito.com`;
const EXPECTED_REDIRECT_URI = `${HOSTED_UI_DOMAIN}/oauth2/idpresponse`;

const MOCK_STACK_OUTPUTS = {
	bucketName: "published-notes-999888777666-cpn-variants",
	distributionId: "EVARIANTDISTID",
	distributionDomainName: "dvariants.cloudfront.net",
	siteUrl: "dvariants.cloudfront.net",
	originAccessIdentityId: "",
};

const MOCK_COGNITO_OUTPUTS = {
	edgeFunctionVersionArn: "arn:aws:lambda:us-east-1:999888777666:function:cpn-auth-edge:1",
	userPoolId: `${MOCK_REGION}_variantpool`,
	userPoolClientId: "variant-client-id",
	hostedUiDomain: HOSTED_UI_DOMAIN,
	jwksUri: "https://cognito-idp.us-west-2.amazonaws.com/pool/.well-known/jwks.json",
	issuer: "https://cognito-idp.us-west-2.amazonaws.com/pool",
	callbackApiDomain: "abc123.execute-api.us-west-2.amazonaws.com",
};

const MOCK_COMMENT_OUTPUTS = {
	bucketName: "cpn-comments-999888777666-variants",
	bucketDomainName: "cpn-comments-999888777666-variants.s3.us-west-2.amazonaws.com",
	apiDomain: "def456.execute-api.us-west-2.amazonaws.com",
	tableName: "cpn-comments-variants",
};

// ---------------------------------------------------------------------------
// Helpers — settings tab + screenshots
// ---------------------------------------------------------------------------

/** Screenshot that tolerates the Electron `__name is not defined` bug. */
async function safeShot(ctx: TestContext, name: string): Promise<string | undefined> {
	try {
		return await ctx.screenshot(name);
	} catch {
		return undefined;
	}
}

async function openPluginSettings(ctx: TestContext, opts: { fatal?: boolean } = {}): Promise<boolean> {
	const { page } = ctx;
	const fatal = opts.fatal !== false;

	await page.keyboard.press("Meta+,");
	await page.waitForTimeout(1500);

	const settingsModal = await waitForSelector(page, ".vertical-tab-header", 5000);
	if (!settingsModal) {
		if (fatal) ctx.fail("Open plugin settings", "Settings modal did not appear after Cmd+,");
		// Newer Obsidian opens settings in its own window, and new modals mount in
		// the active window's document; close it so the wizard opens here.
		await page.evaluate(() => {
			(window as any).app?.setting?.close?.();
			window.focus();
		});
		await page.waitForTimeout(800);
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

// ---------------------------------------------------------------------------
// Helpers — hermetic AWS mocking (recording)
// ---------------------------------------------------------------------------

/**
 * Replace every CloudFormationManager method that would hit AWS with an instant
 * stub, and record each deploy/update as a tag in window.__CPN_TEST_CFM_CALLS__
 * so a test can assert exactly which sub-stacks a variant provisions. Also stubs
 * the awsSdkManager SDK clients so the auto-applyOutputsToProfile tail (STS +
 * S3 asset push + CloudFront invalidation) stays fully offline.
 */
async function installMocks(ctx: TestContext): Promise<void> {
	const { page } = ctx;

	await page.evaluate((args) => {
		const { stackOutputs, cognitoOutputs, commentOutputs } = args;
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		if (!plugin) return;

		// IMPORTANT: use ONLY anonymous arrows assigned to member properties inside
		// this evaluate body. Under tsx the body is transpiled by esbuild with
		// keepNames, which wraps every *named* function (declaration or `const x =`)
		// in a `__name(...)` helper that doesn't exist in the page →
		// "ReferenceError: __name is not defined". Member-assignment arrows are safe,
		// so record() is inlined as a direct .push() in each mock.
		if (!(window as any).__CPN_TEST_CFM_CALLS__) (window as any).__CPN_TEST_CFM_CALLS__ = [];

		const cfm = plugin.cloudFormationManager;

		// --- deploys / updates: record a tag, return a stack name --------------
		// Push to the live window property (NOT a captured local) so resetting the
		// recorder between scenarios via `.length = 0` doesn't leave these closures
		// writing to a stale array.
		cfm.deployFullStack = async () => { (window as any).__CPN_TEST_CFM_CALLS__.push("full"); return "cpn-variants"; };
		cfm.updateFullStack = async () => { (window as any).__CPN_TEST_CFM_CALLS__.push("full-update"); return "cpn-variants"; };
		cfm.updateFullStackAuthLambda = async () => { (window as any).__CPN_TEST_CFM_CALLS__.push("full-auth-update"); return "cpn-variants"; };
		// The comment/chat attach steps carve their origins in with a targeted
		// update (recorded as "full-update", like the full rebuild it replaced).
		cfm.updateFullStackOrigins = async () => { (window as any).__CPN_TEST_CFM_CALLS__.push("full-update"); return "cpn-variants"; };
		cfm.deployCertificateStack = async () => { (window as any).__CPN_TEST_CFM_CALLS__.push("cert"); return "cpn-cert-variants"; };
		cfm.deployCognitoAuthStack = async () => { (window as any).__CPN_TEST_CFM_CALLS__.push("cognito"); return "cpn-cognito-variants"; };
		cfm.updateCognitoAuthStack = async () => { (window as any).__CPN_TEST_CFM_CALLS__.push("cognito-phase2"); return "cpn-cognito-variants"; };
		cfm.deployPasswordAuthStack = async () => { (window as any).__CPN_TEST_CFM_CALLS__.push("password"); return "cpn-password-variants"; };
		cfm.deployCommentStack = async () => { (window as any).__CPN_TEST_CFM_CALLS__.push("comment"); return "cpn-comment-variants"; };
		// Cognito read gate: the edge fn is its own S3-asset stack now, and the pool's
		// pre-token trigger is staged in the bootstrap bucket first.
		// A public site with access groups gets the public-reads build (5th arg).
		cfm.deployCognitoEdgeStack = async (_c: any, _p: any, _pool: any, _onEvent: any, opts: any) => {
			(window as any).__CPN_TEST_CFM_CALLS__.push("authedge");
			if (opts && opts.publicReads) (window as any).__CPN_TEST_CFM_CALLS__.push("authedge-public");
			return "cpn-authedge-variants";
		};
		cfm.prepareCognitoAssets = async (config: any) => {
			config.assetsBucket = "cpn-assets-999888777666-us-east-1";
			config.preTokenAssetsKey = "lambda/pre-token-groups/abc.zip";
		};

		// --- polling: emit one event and report success ------------------------
		cfm.pollStackUntilComplete = async (
			_stackName: string,
			_profile: any,
			onEvent: (event: any) => void,
		) => {
			if (onEvent) {
				onEvent({
					resourceType: "AWS::CloudFront::Distribution",
					logicalResourceId: "Distribution",
					status: "CREATE_COMPLETE",
					timestamp: new Date(),
				});
			}
			return "CREATE_COMPLETE";
		};

		// --- output getters ----------------------------------------------------
		cfm.getStackOutputs = async () => stackOutputs;
		cfm.getCognitoAuthOutputs = async () => cognitoOutputs;
		cfm.getCommentStackOutputs = async () => commentOutputs;
		cfm.getPasswordAuthOutputs = async () => ({ edgeFunctionVersionArn: "arn:aws:lambda:us-east-1:999888777666:function:cpn-password-edge:1" });
		cfm.getEdgeStackOutputs = async () => ({ edgeFunctionVersionArn: "arn:aws:lambda:us-east-1:999888777666:function:cpn-authedge:1" });

		// --- misc read paths (unused by these variants, stubbed for safety) ----
		cfm.listHostedZones = async () => [];
		cfm.getCertificateValidationRecords = async () => [];
		cfm.checkCertificateStatus = async () => "ISSUED";
		cfm.findMatchingCertificates = async () => [];
		cfm.listIssuedCertificatesForDomain = async () => [];

		// --- awsSdkManager clients: keep applyOutputsToProfile offline ---------
		// (anonymous arrows only — see the __name note above)
		if (plugin.awsSdkManager) {
			plugin.awsSdkManager.getSTSClient = () => ({ send: async () => ({ Account: "999888777666" }) });
			// The wizard's fail-open guard lists `restricted/` on re-runs; a scenario
			// sets __CPN_TEST_S3_RESTRICTED__ to simulate published gated notes.
			plugin.awsSdkManager.getS3Client = () => ({
				send: async (cmd: any) => ((window as any).__CPN_TEST_S3_RESTRICTED__
					&& String(cmd?.input?.Prefix || "").endsWith("restricted/")
					? { KeyCount: 1, Contents: [{ Key: "restricted/team/notes/h.json" }] }
					: {}),
			});
			plugin.awsSdkManager.getCloudFrontClient = () => ({ send: async () => ({}) });
		}
	}, {
		stackOutputs: MOCK_STACK_OUTPUTS,
		cognitoOutputs: MOCK_COGNITO_OUTPUTS,
		commentOutputs: MOCK_COMMENT_OUTPUTS,
	});
}

async function readRecordedCalls(ctx: TestContext): Promise<string[]> {
	return await ctx.page.evaluate(() => (window as any).__CPN_TEST_CFM_CALLS__ || []);
}

async function resetRecordedCalls(ctx: TestContext): Promise<void> {
	// Clear in place (length=0) rather than reassigning, so the mock closures —
	// which push to window.__CPN_TEST_CFM_CALLS__ — keep targeting this array.
	await ctx.page.evaluate(() => {
		const arr = (window as any).__CPN_TEST_CFM_CALLS__;
		if (Array.isArray(arr)) arr.length = 0;
		else (window as any).__CPN_TEST_CFM_CALLS__ = [];
	});
}

// ---------------------------------------------------------------------------
// Helpers — profile shaping + wizard driving
// ---------------------------------------------------------------------------

interface VariantShape {
	readGateMode: "none" | "cognito" | "password" | "byo";
	commentIdentity?: boolean;
	commentingEnabled?: boolean;
	/** For password mode: seed a persisted hash so no plaintext entry is needed. */
	passwordHash?: string;
	/** Public reads: opt in to per-note access groups (public-reads edge fn). */
	publicSiteAccessGroups?: boolean;
	/** Simulate a live site bucket that already holds gated notes (restricted/). */
	s3HasRestricted?: boolean;
}

/**
 * Reset profile[0] to a clean, undeployed state shaped for `shape` so the wizard
 * constructor seeds this.config to the target variant, then re-render settings so
 * the "Deploy Infrastructure" button is present (shown only when status==='none').
 */
async function resetAndSeedProfile(ctx: TestContext, shape: VariantShape): Promise<void> {
	await ctx.page.evaluate(async (s) => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		const profile = plugin?.settings?.publishingProfiles?.[0];
		if (!profile) return;

		delete profile.infrastructureState;
		profile.awsSettings.bucketName = "my-bucket";
		profile.awsSettings.cloudFrontDistributionId = "";
		profile.awsSettings.region = s.region;
		profile.awsSettings.awsProfile = s.awsProfile;
		profile.baseUrl = "";

		// Read-gate intent (mode + optional persisted password hash).
		if (s.readGateMode && s.readGateMode !== "none") {
			profile.readGate = { mode: s.readGateMode, passwordHash: s.passwordHash };
		} else {
			delete profile.readGate;
		}

		// Cognito author intent (drives commentIdentityEnabled + prefill). The
		// wizard constructor derives readGateMode as
		//   profile.readGate?.mode || infrastructureState?.readGateMode
		//     || (cognitoAuth?.enabled ? 'cognito' : 'none')
		// (infrastructureState is deleted above, so the last fallback applies)
		// so `enabled` must mirror whether READS are cognito-gated, else a
		// "public reads + comment identity" profile would seed readGateMode as
		// 'cognito' and deploy the wrong variant. For password/byo/cognito modes
		// readGate.mode wins, so `enabled` only actually matters for public reads.
		if (s.publicSiteAccessGroups) profile.publicSiteAccessGroups = true;
		else delete profile.publicSiteAccessGroups;
		(window as any).__CPN_TEST_S3_RESTRICTED__ = !!s.s3HasRestricted;

		if (s.readGateMode === "cognito" || s.commentIdentity || s.publicSiteAccessGroups) {
			profile.cognitoAuth = {
				enabled: s.readGateMode === "cognito",
				commentIdentity: !!s.commentIdentity,
				googleClientId: "seeded.apps.googleusercontent.com",
				authDomainPrefix: s.authDomainPrefix,
			};
		} else {
			delete profile.cognitoAuth;
		}

		// Commenting backend intent.
		if (s.commentingEnabled) {
			profile.commenting = { enabled: true };
		} else {
			delete profile.commenting;
		}

		await plugin.saveSettings();

		// Re-render the settings tab so the Deploy button reflects status==='none'.
		const setting = (window as any).app?.setting;
		if (setting?.activeTab?.display) setting.activeTab.display();
	}, {
		...shape,
		region: MOCK_REGION,
		awsProfile: MOCK_AWS_PROFILE,
		authDomainPrefix: AUTH_DOMAIN_PREFIX,
	});

	await ctx.page.waitForTimeout(400);
}

/** Open the wizard through its command instead of the settings button. */
let openWizardViaCommand = false;

/** Click the "Deploy Infrastructure" button and confirm the wizard modal opens. */
async function openWizard(ctx: TestContext, label: string): Promise<boolean> {
	const { page } = ctx;

	const clicked = !openWizardViaCommand && await page.evaluate(() => {
		const buttons = document.querySelectorAll("button");
		for (const btn of buttons) {
			if (btn.textContent?.includes("Deploy Infrastructure")) {
				(btn as HTMLButtonElement).click();
				return true;
			}
		}
		return false;
	});

	if (!clicked) {
		// Settings UI unavailable: the command opens the same wizard for the
		// (single) profile.
		const ran = await page.evaluate(() => {
			const commands = (window as any).app?.commands;
			return !!commands?.executeCommandById?.("commonplace-notes:deploy-infrastructure");
		});
		if (!ran) {
			ctx.fail(label, "Could not find 'Deploy Infrastructure' button or run the deploy command");
			return false;
		}
	}

	// The command path resolves the profile asynchronously, so poll.
	let exists = false;
	for (let i = 0; i < 15 && !exists; i++) {
		exists = await page.evaluate(() => !!document.querySelector(".cpn-wizard-modal"));
		if (!exists) await page.waitForTimeout(400);
	}
	if (!exists) {
		ctx.fail(label, "Wizard modal (.cpn-wizard-modal) did not appear");
		return false;
	}
	return true;
}

/** Fill a wizard text input identified by its .setting-item-name text. */
async function fillWizardText(ctx: TestContext, nameMatch: string, value: string): Promise<boolean> {
	return await ctx.page.evaluate((args) => {
		const { nameMatch, value } = args;
		const modal = document.querySelector(".cpn-wizard-modal");
		if (!modal) return false;
		const settings = modal.querySelectorAll(".setting-item");
		for (const setting of settings) {
			const name = setting.querySelector(".setting-item-name")?.textContent?.trim();
			if (name?.includes(nameMatch)) {
				const input = setting.querySelector<HTMLInputElement>("input[type='text'], input[type='password']");
				if (!input) return false;
				input.value = value;
				input.dispatchEvent(new Event("input", { bubbles: true }));
				input.dispatchEvent(new Event("change", { bubbles: true }));
				return true;
			}
		}
		return false;
	}, { nameMatch, value });
}

/** Fill the standard step-1 AWS fields (profile/region/variant). */
async function fillStep1Basics(ctx: TestContext, variant: string): Promise<void> {
	await ctx.page.evaluate((args) => {
		const { awsProfile, region, variant } = args;
		const modal = document.querySelector(".cpn-wizard-modal");
		if (!modal) return;
		const settings = modal.querySelectorAll(".setting-item");
		for (const setting of settings) {
			const name = setting.querySelector(".setting-item-name")?.textContent?.trim();
			const input = setting.querySelector<HTMLInputElement>("input[type='text']");
			if (!input) continue;
			if (name?.includes("AWS Profile")) {
				input.value = awsProfile;
			} else if (name === "Region") {
				input.value = region;
			} else if (name?.includes("Variant")) {
				input.value = variant;
			} else {
				continue;
			}
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
		}
	}, { awsProfile: MOCK_AWS_PROFILE, region: MOCK_REGION, variant });
	await ctx.page.waitForTimeout(200);
}

/** Click a wizard button by exact trimmed text. Returns whether it was found. */
async function clickWizardButton(ctx: TestContext, text: string): Promise<boolean> {
	const clicked = await ctx.page.evaluate((wanted) => {
		const modal = document.querySelector(".cpn-wizard-modal");
		if (!modal) return false;
		const buttons = modal.querySelectorAll("button");
		for (const btn of buttons) {
			if (btn.textContent?.trim() === wanted) {
				(btn as HTMLButtonElement).click();
				return true;
			}
		}
		return false;
	}, text);
	return clicked;
}

/** Wait until the wizard reaches the completion step (or timeout). */
async function reachCompletion(ctx: TestContext, label: string, timeoutMs = 6000): Promise<boolean> {
	const { page } = ctx;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const done = await page.evaluate(() => {
			const modal = document.querySelector(".cpn-wizard-modal");
			return !!modal && (modal.textContent || "").includes("Deployment Complete");
		});
		if (done) return true;
		await page.waitForTimeout(400);
	}
	const content = await page.evaluate(() => {
		const modal = document.querySelector(".cpn-wizard-modal");
		return modal ? (modal.textContent || "").substring(0, 300) : "modal gone";
	});
	ctx.fail(label, `Did not reach "Deployment Complete". Modal content: "${content}"`);
	return false;
}

/** Close the completion screen via "Done". */
async function closeWizard(ctx: TestContext): Promise<void> {
	await clickWizardButton(ctx, "Done");
	await ctx.page.waitForTimeout(600);
	// Belt-and-suspenders: Escape any lingering modal so the next scenario is clean.
	const stillOpen = await ctx.page.evaluate(() => !!document.querySelector(".cpn-wizard-modal"));
	if (stillOpen) {
		await ctx.page.keyboard.press("Escape");
		await ctx.page.waitForTimeout(300);
	}
}

/** Read the persisted infrastructure state (in-memory + on-disk) for profile[0]. */
async function readPersistedState(ctx: TestContext): Promise<any> {
	// NOTE: no named/const-arrow helpers inside evaluate (tsx __name wrapper); the
	// projection is inlined per profile via an anonymous .map over [mem, disk].
	return await ctx.page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		const mem = plugin?.settings?.publishingProfiles?.[0];
		const raw = await plugin.loadData();
		const disk = raw?.publishingProfiles?.[0];
		const [memPick, diskPick] = [mem, disk].map((p: any) => ({
			status: p?.infrastructureState?.status,
			readGateMode: p?.infrastructureState?.readGateMode,
			hasCognito: !!p?.infrastructureState?.cognitoAuth,
			cognitoCommentIdentity: p?.infrastructureState?.cognitoAuth?.commentIdentity,
			hostedUiDomain: p?.infrastructureState?.cognitoAuth?.hostedUiDomain,
			hasPassword: !!p?.infrastructureState?.passwordAuth,
			hasComment: !!p?.infrastructureState?.comment,
			commentingEnabled: p?.commenting?.enabled,
			bucketName: p?.awsSettings?.bucketName,
			authLambdaEdgeArn: p?.infrastructureState?.authLambdaEdgeArn,
			edgePublicReads: p?.infrastructureState?.cognitoAuth?.edgePublicReads,
			publicSiteAccessGroups: p?.publicSiteAccessGroups,
		}));
		return { mem: memPick, disk: diskPick };
	});
}

// ---------------------------------------------------------------------------
// Scenario 1 — canonical public (full DOM)
// ---------------------------------------------------------------------------

async function testCanonicalPublic(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Canonical public site (full DOM) — deploys only the full stack");
	const label = "Canonical public";

	await resetAndSeedProfile(ctx, { readGateMode: "none" });
	await resetRecordedCalls(ctx);
	if (!(await openWizard(ctx, label))) return;

	await fillStep1Basics(ctx, "variants");
	if (!(await clickWizardButton(ctx, "Next"))) {
		ctx.fail(label, "Could not click 'Next' on step 1");
		return;
	}

	if (!(await reachCompletion(ctx, label))) return;

	// No Cognito → completion screen must NOT show the Google setup block.
	const hasGoogleBlock = await ctx.page.evaluate(() => {
		const modal = document.querySelector(".cpn-wizard-modal");
		return !!modal && (modal.textContent || "").includes("Finish Google sign-in setup");
	});
	if (hasGoogleBlock) {
		ctx.fail(label, "Completion screen showed 'Finish Google sign-in setup' for a public (no-auth) site");
		return;
	}

	const calls = await readRecordedCalls(ctx);
	const state = await readPersistedState(ctx);
	await closeWizard(ctx);

	if (calls.join(",") !== "full") {
		ctx.fail(label, `Expected only ['full'] deploy, got [${calls.join(", ")}]`);
		return;
	}
	if (state.disk.status !== "deployed" || state.disk.readGateMode !== "none" || state.disk.hasCognito || state.disk.hasComment) {
		ctx.fail(label, `Unexpected persisted state: ${JSON.stringify(state.disk)}`);
		return;
	}

	ctx.pass(label, `Deployed [${calls.join(", ")}]; persisted status=deployed, readGate=none, no cognito/comment`);
}

// ---------------------------------------------------------------------------
// Scenario 2 — canonical Cognito + comments (full DOM)
// ---------------------------------------------------------------------------

async function testCanonicalCognitoComments(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Canonical Cognito login + commenting (full DOM) — all sub-stacks + auth-URL surface");
	const label = "Canonical cognito+comments";

	// Start from a clean profile with NO seeded auth intent, so we drive every
	// auth control through the real DOM.
	await resetAndSeedProfile(ctx, { readGateMode: "none" });
	await resetRecordedCalls(ctx);
	if (!(await openWizard(ctx, label))) return;

	await fillStep1Basics(ctx, "variants");

	// Set read-access dropdown → 'cognito' (onChange re-renders the step).
	const setReadAccess = await ctx.page.evaluate(() => {
		const modal = document.querySelector(".cpn-wizard-modal");
		if (!modal) return false;
		const selects = modal.querySelectorAll("select");
		for (const sel of selects) {
			const opts = Array.from(sel.options).map((o) => o.value);
			if (opts.includes("cognito") && opts.includes("password")) {
				(sel as HTMLSelectElement).value = "cognito";
				sel.dispatchEvent(new Event("change", { bubbles: true }));
				return true;
			}
		}
		return false;
	});
	if (!setReadAccess) {
		ctx.fail(label, "Could not find/set the read-access dropdown to 'cognito'");
		return;
	}
	await ctx.page.waitForTimeout(400);

	// Toggle "Enable commenting" (re-renders), then "Deploy commenting backend".
	const toggledIdentity = await clickToggleByName(ctx, "Enable commenting");
	if (!toggledIdentity) {
		ctx.fail(label, "Could not find 'Enable commenting' toggle");
		return;
	}
	await ctx.page.waitForTimeout(400);

	const toggledBackend = await clickToggleByName(ctx, "Deploy commenting backend");
	if (!toggledBackend) {
		ctx.fail(label, "Could not find 'Deploy commenting backend' toggle (should appear once commenting is on)");
		return;
	}
	await ctx.page.waitForTimeout(300);

	// Fill the Google fields + auth domain prefix (secret is never persisted).
	await fillWizardText(ctx, "Google Client ID", "variant.apps.googleusercontent.com");
	await fillWizardText(ctx, "Google Client Secret", "GOCSPX-variant-secret");
	await fillWizardText(ctx, "Auth domain prefix", AUTH_DOMAIN_PREFIX);
	await ctx.page.waitForTimeout(200);

	if (!(await clickWizardButton(ctx, "Next"))) {
		ctx.fail(label, "Could not click 'Next' on step 1 (validation may have blocked — check Google fields)");
		return;
	}

	if (!(await reachCompletion(ctx, label, 8000))) return;

	// Completion screen must surface the Google OAuth redirect URI + publish hint.
	const surfaces = await ctx.page.evaluate(() => {
		const modal = document.querySelector(".cpn-wizard-modal");
		const text = modal ? modal.textContent || "" : "";
		return {
			hasGoogleBlock: text.includes("Finish Google sign-in setup"),
			hasRedirectUri: text.includes("/oauth2/idpresponse"),
			hasPublishHint: text.includes("Publish all notes"),
		};
	});
	const shot = await safeShot(ctx, "cognito-comments-completion");

	if (!surfaces.hasGoogleBlock || !surfaces.hasRedirectUri) {
		ctx.fail(label, `Completion screen missing Google setup / redirect URI: ${JSON.stringify(surfaces)}`, shot);
		return;
	}
	if (!surfaces.hasPublishHint) {
		ctx.fail(label, `Completion screen missing the 'Publish all notes' comment guidance: ${JSON.stringify(surfaces)}`, shot);
		return;
	}

	const calls = await readRecordedCalls(ctx);
	const state = await readPersistedState(ctx);
	await closeWizard(ctx);

	// Cognito pool + comment backend + full stack + comment origin re-splice; plus
	// the phase-2 callback fix-up for the default CloudFront domain.
	for (const required of ["cognito", "comment", "full", "full-update", "cognito-phase2"]) {
		if (!calls.includes(required)) {
			ctx.fail(label, `Expected deploy '${required}' in recorded calls, got [${calls.join(", ")}]`, shot);
			return;
		}
	}
	if (!state.disk.hasCognito || state.disk.cognitoCommentIdentity !== true || !state.disk.hasComment || state.disk.commentingEnabled !== true) {
		ctx.fail(label, `Persisted state missing cognito/comment: ${JSON.stringify(state.disk)}`, shot);
		return;
	}
	if (state.disk.hostedUiDomain !== HOSTED_UI_DOMAIN) {
		ctx.fail(label, `Persisted hostedUiDomain="${state.disk.hostedUiDomain}", expected "${HOSTED_UI_DOMAIN}"`, shot);
		return;
	}

	ctx.pass(label,
		`Deployed [${calls.join(", ")}]; completion showed ${EXPECTED_REDIRECT_URI} + publish hint; persisted cognito+comment`,
		shot);
}

/** Click an Obsidian toggle located by its sibling .setting-item-name text. */
async function clickToggleByName(ctx: TestContext, nameMatch: string): Promise<boolean> {
	return await ctx.page.evaluate((wanted) => {
		const modal = document.querySelector(".cpn-wizard-modal");
		if (!modal) return false;
		const settings = modal.querySelectorAll(".setting-item");
		for (const setting of settings) {
			const name = setting.querySelector(".setting-item-name")?.textContent?.trim();
			if (name?.includes(wanted)) {
				const toggle = setting.querySelector<HTMLElement>(".checkbox-container");
				if (!toggle) return false;
				toggle.click();
				return true;
			}
		}
		return false;
	}, nameMatch);
}

// ---------------------------------------------------------------------------
// Scenario 3 — variant matrix (profile-seeded, real wizard runs)
// ---------------------------------------------------------------------------

interface MatrixCase {
	name: string;
	shape: VariantShape;
	/** deploy tags that MUST appear */
	expectStacks: string[];
	/** deploy tags that must NOT appear */
	forbidStacks?: string[];
	/** typed-in step-1 field the variant needs (never-persisted values) */
	fill?: { name: string; value: string };
	expectReadGate: string;
	expectCognito: boolean;
	expectPassword: boolean;
	expectComment: boolean;
	/** Expected persisted authLambdaEdgeArn ('' = none); unchecked when absent. */
	expectEdgeArn?: string;
	/** Expected persisted cognitoAuth.edgePublicReads (public-site access groups). */
	expectEdgePublicReads?: boolean;
	/** The wizard must refuse the deploy with this text (fail-open guard). */
	expectBlocked?: string;
}

const AUTHEDGE_ARN = "arn:aws:lambda:us-east-1:999888777666:function:cpn-authedge:1";

const MATRIX: MatrixCase[] = [
	{
		name: "none / no comments",
		shape: { readGateMode: "none" },
		expectStacks: ["full"], forbidStacks: ["cognito", "password", "comment"],
		expectReadGate: "none", expectCognito: false, expectPassword: false, expectComment: false,
	},
	{
		name: "cognito reads / no comments",
		shape: { readGateMode: "cognito" },
		fill: { name: "Google Client Secret", value: "GOCSPX-matrix-cognito" },
		expectStacks: ["cognito", "authedge", "full", "cognito-phase2"], forbidStacks: ["password", "comment"],
		expectReadGate: "cognito", expectCognito: true, expectPassword: false, expectComment: false,
	},
	{
		name: "password reads / no comments",
		shape: { readGateMode: "password", passwordHash: "a".repeat(64) },
		expectStacks: ["password", "full"], forbidStacks: ["cognito", "comment"],
		expectReadGate: "password", expectCognito: false, expectPassword: true, expectComment: false,
	},
	{
		name: "byo reads / no comments",
		shape: { readGateMode: "byo" },
		fill: { name: "Auth Lambda@Edge ARN", value: "arn:aws:lambda:us-east-1:999888777666:function:byo-auth:3" },
		expectStacks: ["full"], forbidStacks: ["cognito", "password", "comment"],
		expectReadGate: "byo", expectCognito: false, expectPassword: false, expectComment: false,
	},
	{
		name: "public reads / comments on",
		shape: { readGateMode: "none", commentIdentity: true, commentingEnabled: true },
		fill: { name: "Google Client Secret", value: "GOCSPX-matrix-comments" },
		expectStacks: ["cognito", "comment", "full", "full-update", "cognito-phase2"], forbidStacks: ["password", "authedge"],
		expectReadGate: "none", expectCognito: true, expectPassword: false, expectComment: true,
		expectEdgeArn: "",
	},
	{
		name: "password reads / comments on",
		shape: { readGateMode: "password", passwordHash: "b".repeat(64), commentIdentity: true, commentingEnabled: true },
		fill: { name: "Google Client Secret", value: "GOCSPX-matrix-pw-comments" },
		expectStacks: ["password", "cognito", "comment", "full", "full-update"], forbidStacks: ["authedge"],
		expectReadGate: "password", expectCognito: true, expectPassword: true, expectComment: true,
	},
	{
		name: "cognito reads / comment-identity only (no backend)",
		shape: { readGateMode: "cognito", commentIdentity: true, commentingEnabled: false },
		fill: { name: "Google Client Secret", value: "GOCSPX-matrix-identity-only" },
		expectStacks: ["cognito", "authedge", "full"], forbidStacks: ["comment", "full-update", "password"],
		expectReadGate: "cognito", expectCognito: true, expectPassword: false, expectComment: false,
	},
	{
		name: "public reads / gated notes (no comments)",
		shape: { readGateMode: "none", publicSiteAccessGroups: true },
		fill: { name: "Google Client Secret", value: "GOCSPX-matrix-public-gated" },
		expectStacks: ["cognito", "authedge", "authedge-public", "full", "cognito-phase2"], forbidStacks: ["password", "comment"],
		expectReadGate: "none", expectCognito: true, expectPassword: false, expectComment: false,
		expectEdgeArn: AUTHEDGE_ARN, expectEdgePublicReads: true,
	},
	{
		// The shape of a typical public notes site: comments + a few gated notes.
		name: "public reads / comments + gated notes",
		shape: { readGateMode: "none", commentIdentity: true, commentingEnabled: true, publicSiteAccessGroups: true },
		fill: { name: "Google Client Secret", value: "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" },
		expectStacks: ["cognito", "authedge", "authedge-public", "comment", "full", "full-update", "cognito-phase2"], forbidStacks: ["password"],
		expectReadGate: "none", expectCognito: true, expectPassword: false, expectComment: true,
		expectEdgeArn: AUTHEDGE_ARN, expectEdgePublicReads: true,
	},
	{
		name: "cognito reads (whole-site build, not public-reads)",
		shape: { readGateMode: "cognito" },
		fill: { name: "Google Client Secret", value: "GOCSPX-matrix-cognito-build" },
		expectStacks: ["authedge", "full"], forbidStacks: ["authedge-public"],
		expectReadGate: "cognito", expectCognito: true, expectPassword: false, expectComment: false,
		expectEdgeArn: AUTHEDGE_ARN,
	},
	{
		// Fail-open guard: re-running with plain public reads over a bucket that
		// already holds gated notes would detach their protection.
		name: "public reads re-run while gated notes are published -> refused",
		shape: { readGateMode: "none", s3HasRestricted: true },
		expectStacks: [], forbidStacks: ["full", "authedge"],
		expectReadGate: "none", expectCognito: false, expectPassword: false, expectComment: false,
		expectBlocked: "already publishes gated notes",
	},
];

async function testVariantMatrix(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Variant matrix (profile-seeded, real wizard runs)");

	for (let i = 0; i < MATRIX.length; i++) {
		const c = MATRIX[i];
		const label = `Matrix ${i + 1}: ${c.name}`;
		console.log(`  - ${label}`);

		await resetAndSeedProfile(ctx, c.shape);
		await resetRecordedCalls(ctx);
		if (!(await openWizard(ctx, label))) return;

		await fillStep1Basics(ctx, "variants");
		if (c.fill) {
			const filled = await fillWizardText(ctx, c.fill.name, c.fill.value);
			if (!filled) {
				ctx.fail(label, `Could not fill required field "${c.fill.name}"`);
				await closeWizard(ctx);
				return;
			}
		}

		if (!(await clickWizardButton(ctx, "Next"))) {
			ctx.fail(label, "Could not click 'Next' (step-1 validation may have blocked)");
			await closeWizard(ctx);
			return;
		}

		if (c.expectBlocked) {
			const blockedText = c.expectBlocked;
			const deadline = Date.now() + 8000;
			let text = "";
			while (Date.now() < deadline) {
				text = await ctx.page.evaluate(() => document.querySelector(".cpn-wizard-modal")?.textContent || "");
				if (text.includes(blockedText) || text.includes("Deployment Complete")) break;
				await ctx.page.waitForTimeout(400);
			}
			const blockedCalls = await readRecordedCalls(ctx);
			await ctx.page.keyboard.press("Escape");
			await ctx.page.waitForTimeout(400);
			await ctx.page.evaluate(() => { (window as any).__CPN_TEST_S3_RESTRICTED__ = false; });
			if (!text.includes(blockedText)) {
				ctx.fail(label, `Expected the wizard to refuse ("${blockedText}"). Modal: "${text.substring(0, 300)}"`);
				return;
			}
			const leaked = (c.forbidStacks || []).filter((f) => blockedCalls.includes(f));
			if (leaked.length) {
				ctx.fail(label, `Refused, but still deployed [${leaked.join(", ")}]`);
				return;
			}
			ctx.pass(label, `refused before the site update; calls=[${blockedCalls.join(", ")}]`);
			continue;
		}

		if (!(await reachCompletion(ctx, label, 8000))) {
			await closeWizard(ctx);
			return;
		}

		const calls = await readRecordedCalls(ctx);
		const state = await readPersistedState(ctx);
		await closeWizard(ctx);

		// Assert the recorded deploy set.
		for (const req of c.expectStacks) {
			if (!calls.includes(req)) {
				ctx.fail(label, `Expected stack '${req}' to deploy, got [${calls.join(", ")}]`);
				return;
			}
		}
		for (const forbidden of c.forbidStacks || []) {
			if (calls.includes(forbidden)) {
				ctx.fail(label, `Stack '${forbidden}' should NOT have deployed, got [${calls.join(", ")}]`);
				return;
			}
		}

		// Assert persisted state (on-disk).
		const d = state.disk;
		if (d.status !== "deployed") {
			ctx.fail(label, `Persisted status="${d.status}", expected "deployed"`);
			return;
		}
		if (d.readGateMode !== c.expectReadGate) {
			ctx.fail(label, `Persisted readGateMode="${d.readGateMode}", expected "${c.expectReadGate}"`);
			return;
		}
		if (d.hasCognito !== c.expectCognito) {
			ctx.fail(label, `Persisted hasCognito=${d.hasCognito}, expected ${c.expectCognito}`);
			return;
		}
		if (d.hasPassword !== c.expectPassword) {
			ctx.fail(label, `Persisted hasPassword=${d.hasPassword}, expected ${c.expectPassword}`);
			return;
		}
		if (d.hasComment !== c.expectComment) {
			ctx.fail(label, `Persisted hasComment=${d.hasComment}, expected ${c.expectComment}`);
			return;
		}

		if (c.expectEdgeArn !== undefined && (d.authLambdaEdgeArn || "") !== c.expectEdgeArn) {
			ctx.fail(label, `Persisted authLambdaEdgeArn="${d.authLambdaEdgeArn}", expected "${c.expectEdgeArn}"`);
			return;
		}
		if (c.expectEdgePublicReads !== undefined && !!d.edgePublicReads !== c.expectEdgePublicReads) {
			ctx.fail(label, `Persisted edgePublicReads=${d.edgePublicReads}, expected ${c.expectEdgePublicReads}`);
			return;
		}
		if (c.shape.publicSiteAccessGroups && d.publicSiteAccessGroups !== true) {
			ctx.fail(label, `Persisted publicSiteAccessGroups=${d.publicSiteAccessGroups}, expected true`);
			return;
		}

		ctx.pass(label, `stacks=[${calls.join(", ")}]; readGate=${d.readGateMode}, cognito=${d.hasCognito}, password=${d.hasPassword}, comment=${d.hasComment}, edge=${d.authLambdaEdgeArn || "none"}`);
	}
}

// ---------------------------------------------------------------------------
// Scenario 4 — no plugin errors
// ---------------------------------------------------------------------------

async function testNoPluginErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: No plugin errors logged during the run");
	const pluginErrors = ctx.collector
		.getLogsByLevel("error")
		.filter((e) => e.source === "plugin");

	if (pluginErrors.length > 0) {
		const sample = pluginErrors.slice(0, 5).map((e) => e.message).join(" | ");
		ctx.fail("No plugin errors", `${pluginErrors.length} plugin error log(s): ${sample}`);
		return;
	}
	ctx.pass("No plugin errors", "No [CPN Error] entries captured during the deployment-variant run");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000); // let the plugin initialise

	// Obsidian 1.13.7 no longer opens settings in the vault page for Cmd+, (a
	// separate, known bug). The wizard is still reachable through the
	// "Deploy publishing infrastructure" command, which openWizard falls back to.
	const settingsOpen = await openPluginSettings(ctx, { fatal: false });
	openWizardViaCommand = !settingsOpen;
	if (!settingsOpen) console.log("  (settings UI unavailable; opening the wizard via its command)");
	await installMocks(ctx);

	await testCanonicalPublic(ctx);
	await testCanonicalCognitoComments(ctx);
	await testVariantMatrix(ctx);
	await testNoPluginErrors(ctx);
}

runTest({ name: "deployment-variants" }, tests);
