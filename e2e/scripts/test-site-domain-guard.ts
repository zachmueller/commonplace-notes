#!/usr/bin/env npx tsx
/**
 * Site Domain Guard E2E Test
 *
 * Proves the real plugin bundle keeps a distribution's live custom domains
 * through a site-stack update. Fake CloudFormation and CloudFront clients are
 * placed in the CloudFormationManager's client caches (the managers build
 * their own SDK clients, so the caches are the seam), then the real update
 * methods run and the UpdateStack parameters they send are inspected.
 *
 * NO real AWS calls.
 *
 * Scenarios:
 *   1. The production incident: domains attached by hand, then the
 *      access-groups edge re-point. The update must carry both aliases, the
 *      certificate, and the TLS policy, and persist the domain in settings.
 *   2. In sync, no custom domain: domain params inherit; new params get valid
 *      defaults (MinimumProtocolVersion is never '').
 *   3. Drift plus a deliberate domain change: refused, nothing sent.
 *   4. The distribution can't be read: refused, nothing sent.
 *   5. No unexpected plugin errors logged.
 */

import { runTest, type TestContext } from "../lib/test-harness";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const AWS_PROFILE = "cpn-guard-test";
const STACK = "cpn-guardtest";
const CERT = "arn:aws:acm:us-east-1:111122223333:certificate/abc";

interface Scenario {
	deployedParams: Record<string, string>;
	live: { aliases: string[]; acmArn?: string; minTls?: string } | "error";
	call: "authLambda" | "origins";
	overrides?: Record<string, string>;
}

interface Outcome {
	error: string | null;
	sent: Array<{ ParameterKey: string; ParameterValue?: string; UsePreviousValue?: boolean }> | null;
	persistedDomain: string | undefined;
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Install fakes for one scenario, run the real update method, report what it sent. */
async function runScenario(ctx: TestContext, scenario: Scenario): Promise<Outcome> {
	return ctx.page.evaluate(async ({ s, awsProfile, stack }) => {
		const plugin = (window as any).app.plugins.plugins["commonplace-notes"];
		const cfm = plugin.cloudFormationManager;
		const profile = plugin.settings.publishingProfiles[0];
		profile.publishMechanism = "AWS";
		profile.baseUrl = "https://zach.nz/";
		profile.awsSettings = { ...(profile.awsSettings || {}), awsProfile, region: "us-east-1" };
		profile.infrastructureState = { status: "deployed", fullStackName: stack, region: "us-east-1", originAccessMethod: "oac", useRoute53: false };

		let sent: any = null;
		const describe = {
			Stacks: [{
				StackName: stack,
				StackStatus: "UPDATE_COMPLETE",
				Parameters: Object.entries(s.deployedParams).map(([k, v]) => ({ ParameterKey: k, ParameterValue: v })),
				Outputs: [{ OutputKey: "DistributionID", OutputValue: "EFAKEDIST" }],
			}],
		};
		// Commands are told apart by input shape: class names are minified in the bundle.
		const fakeCf = {
			send: async (cmd: any) => {
				const input = cmd.input || {};
				if ("Parameters" in input || "TemplateBody" in input) { sent = input.Parameters; return {}; }
				if (input.StackName) return describe;
				throw new Error("unexpected CloudFormation command");
			},
			destroy: () => {},
		};
		const fakeCloudFront = {
			send: async (cmd: any) => {
				if (s.live === "error") throw new Error("AccessDenied: cloudfront:GetDistribution");
				if (cmd.input?.Id !== "EFAKEDIST") throw new Error("wrong distribution id");
				return {
					ETag: "E1",
					DistributionConfig: {
						Aliases: { Quantity: s.live.aliases.length, Items: s.live.aliases },
						ViewerCertificate: s.live.acmArn
							? { ACMCertificateArn: s.live.acmArn, SSLSupportMethod: "sni-only", MinimumProtocolVersion: s.live.minTls, CloudFrontDefaultCertificate: false }
							: { CloudFrontDefaultCertificate: true, MinimumProtocolVersion: "TLSv1" },
					},
				};
			},
			destroy: () => {},
		};
		cfm.cfClients.set(`${awsProfile}:us-east-1`, fakeCf);
		cfm.cloudFrontClients.set(awsProfile, fakeCloudFront);

		let error: string | null = null;
		try {
			if (s.call === "authLambda") {
				await cfm.updateFullStackAuthLambda(stack, "oac", "arn:aws:lambda:us-east-1:111122223333:function:edge:1", profile, "us-east-1",
					{ CallbackApiDomainName: "cb.example.com" });
			} else {
				await cfm.updateFullStackOrigins({ profileId: profile.id, variantName: "guardtest", awsProfile, region: "us-east-1", originAccessMethod: "oac" },
					s.overrides || {});
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		return { error, sent, persistedDomain: profile.infrastructureState.customDomain };
	}, { s: scenario, awsProfile: AWS_PROFILE, stack: STACK });
}

function param(outcome: Outcome, key: string) {
	return outcome.sent?.find((p) => p.ParameterKey === key);
}

// The pre-upgrade parameter set of a live site stack (no AdditionalAliases /
// MinimumProtocolVersion yet), matching the incident stack.
const LEGACY_PARAMS: Record<string, string> = {
	VariantName: "guardtest", S3Prefix: "", CustomDomain: "", CertificateArn: "", UseRoute53: "false",
	HostedZoneId: "", HostedZoneName: "", AuthLambdaEdgeArn: "",
	CallbackApiDomainName: "cb.example.com", CommentBucketDomainName: "cbd.example.com",
	CommentApiDomainName: "api.example.com", ChatFunctionUrlDomainName: "",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testIncidentAdopted(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: Hand-attached domains survive the access-groups edge re-point");
	const out = await runScenario(ctx, {
		deployedParams: LEGACY_PARAMS,
		live: { aliases: ["notes.zach.nz", "zach.nz"], acmArn: CERT, minTls: "TLSv1.3_2025" },
		call: "authLambda",
	});
	if (out.error || !out.sent) {
		ctx.fail("Incident: update sent", `error=${out.error}, sent=${JSON.stringify(out.sent)}`);
		return;
	}
	const want: Record<string, string> = {
		CustomDomain: "zach.nz",
		AdditionalAliases: "notes.zach.nz",
		CertificateArn: CERT,
		MinimumProtocolVersion: "TLSv1.3_2025",
		AuthLambdaEdgeArn: "arn:aws:lambda:us-east-1:111122223333:function:edge:1",
	};
	const wrong = Object.entries(want).filter(([k, v]) => param(out, k)?.ParameterValue !== v)
		.map(([k, v]) => `${k}=${JSON.stringify(param(out, k))} (want ${v})`);
	if (wrong.length) {
		ctx.fail("Incident: live domains carried into the update", wrong.join("; "));
	} else {
		ctx.pass("Incident: live domains carried into the update", "zach.nz + notes.zach.nz, ACM cert, TLSv1.3_2025, new edge ARN");
	}
	if (!param(out, "CommentApiDomainName")?.UsePreviousValue) {
		ctx.fail("Incident: unrelated params inherit", `CommentApiDomainName=${JSON.stringify(param(out, "CommentApiDomainName"))}`);
	} else {
		ctx.pass("Incident: unrelated params inherit", "CommentApiDomainName uses UsePreviousValue");
	}
	if (out.persistedDomain !== "zach.nz") {
		ctx.fail("Incident: domain persisted to settings", `infrastructureState.customDomain=${out.persistedDomain}`);
	} else {
		ctx.pass("Incident: domain persisted to settings", "infrastructureState.customDomain=zach.nz");
	}
}

async function testInSyncDefaults(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: In-sync site without a domain gets valid defaults");
	const out = await runScenario(ctx, { deployedParams: LEGACY_PARAMS, live: { aliases: [] }, call: "authLambda" });
	if (out.error || !out.sent) {
		ctx.fail("In sync: update sent", `error=${out.error}`);
		return;
	}
	const domain = param(out, "CustomDomain");
	const tls = param(out, "MinimumProtocolVersion");
	const extra = param(out, "AdditionalAliases");
	if (!domain?.UsePreviousValue || tls?.ParameterValue !== "TLSv1.2_2021" || extra?.ParameterValue !== "") {
		ctx.fail("In sync: domain inherits, new params defaulted",
			`CustomDomain=${JSON.stringify(domain)}, MinimumProtocolVersion=${JSON.stringify(tls)}, AdditionalAliases=${JSON.stringify(extra)}`);
		return;
	}
	ctx.pass("In sync: domain inherits, new params defaulted", "CustomDomain UsePreviousValue, MinimumProtocolVersion=TLSv1.2_2021, AdditionalAliases=''");
}

async function testConflictRefused(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Drift plus a deliberate domain change is refused");
	const out = await runScenario(ctx, {
		deployedParams: LEGACY_PARAMS,
		live: { aliases: ["zach.nz"], acmArn: CERT, minTls: "TLSv1.2_2021" },
		call: "origins",
		overrides: { CustomDomain: "new.example.com" },
	});
	if (!out.error || out.sent) {
		ctx.fail("Conflict refused", `error=${out.error}, sent=${JSON.stringify(out.sent)}`);
		return;
	}
	if (!/changed outside CloudFormation/.test(out.error)) {
		ctx.fail("Conflict refused", `Unexpected error: ${out.error}`);
		return;
	}
	ctx.pass("Conflict refused", "Threw before UpdateStack");
}

async function testUnreadableRefused(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Unreadable distribution is refused");
	const out = await runScenario(ctx, { deployedParams: LEGACY_PARAMS, live: "error", call: "authLambda" });
	if (!out.error || out.sent || !/Could not read CloudFront distribution EFAKEDIST/.test(out.error)) {
		ctx.fail("Unreadable distribution refused", `error=${out.error}, sent=${JSON.stringify(out.sent)}`);
		return;
	}
	ctx.pass("Unreadable distribution refused", "Threw before UpdateStack");
}

/** Errors logged by the scenarios themselves (startup noise is excluded). */
async function testNoPluginErrors(ctx: TestContext, baseline: number): Promise<void> {
	console.log("\nTest 5: No plugin errors logged by the guard");
	const errors = ctx.collector.getLogsByLevel("error").filter((e) => e.source === "plugin").slice(baseline);
	if (errors.length) {
		ctx.fail("No plugin errors", errors.map((e) => e.message).join(" | "));
		return;
	}
	ctx.pass("No plugin errors", "0 plugin errors");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	const { page } = ctx;
	await page.waitForTimeout(5_000);
	const baseline = ctx.collector.getLogsByLevel("error").filter((e) => e.source === "plugin").length;

	// The guard persists an adopted domain via saveSettings(); snapshot the
	// settings so the shared test vault is left as it was found.
	await page.evaluate(() => {
		const plugin = (window as any).app.plugins.plugins["commonplace-notes"];
		(window as any).__cpnGuardSettings = JSON.stringify(plugin.settings);
	});
	try {
		await testIncidentAdopted(ctx);
		await testInSyncDefaults(ctx);
		await testConflictRefused(ctx);
		await testUnreadableRefused(ctx);
	} finally {
		await page.evaluate(async () => {
			const plugin = (window as any).app.plugins.plugins["commonplace-notes"];
			const cfm = plugin.cloudFormationManager;
			cfm.cfClients.clear();
			cfm.cloudFrontClients.clear();
			// Restore in place: other managers hold a reference to plugin.settings.
			const settings = plugin.settings;
			for (const key of Object.keys(settings)) delete settings[key];
			Object.assign(settings, JSON.parse((window as any).__cpnGuardSettings));
			await plugin.saveSettings();
		});
	}
	await testNoPluginErrors(ctx, baseline);
}

runTest({ name: "site-domain-guard" }, tests);
