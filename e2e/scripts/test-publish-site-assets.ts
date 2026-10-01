#!/usr/bin/env npx tsx
/**
 * Publish Re-pushes Changed Site Assets E2E Test
 *
 * Proves the real plugin bundle re-uploads the site code during a normal
 * publish when it changed since the last push (for example after a plugin
 * update), and skips it otherwise. A fixture note is published through the
 * real publisher.publishNotes(); a fake S3 client placed in the
 * AwsSdkManager's client cache (the managers build their own SDK clients, so
 * the cache is the seam) records every upload.
 *
 * Regression for the zach.nz access-groups failure: publishing never re-pushed
 * app.js, so the live site kept code with no access-group support.
 *
 * NO real AWS calls.
 *
 * Scenarios:
 *   1. First publish after an upgrade (no fingerprint): hashed scripts/styles,
 *      then index.html, are uploaded, and the fingerprint is saved.
 *   2. Next publish, nothing changed: only mappings + config.json.
 *   3. Profile pointed at a different bucket: the site code is pushed again.
 *   4. No unexpected plugin errors logged.
 */

import { runTest, type TestContext } from "../lib/test-harness";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const NOTE_PATH = "Site-Assets-Publish-Test.md";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

interface PublishRun {
	error: string | null;
	keys: string[];
	fingerprint: string | undefined;
}

/** Publish the fixture note once through the real publisher against the fake S3 client. */
async function publishOnce(ctx: TestContext, bucket: string): Promise<PublishRun> {
	return ctx.page.evaluate(async ({ bucketName, notePath }) => {
		const plugin = (window as any).app.plugins.plugins["commonplace-notes"];
		const profile = plugin.settings.publishingProfiles[0];
		profile.awsSettings.bucketName = bucketName;
		const keys: string[] = [];
		plugin.awsSdkManager.s3Clients.set(profile.id, {
			send: async (cmd: any) => {
				if (cmd.input?.Key && "Body" in cmd.input) keys.push(cmd.input.Key);
				return {};
			},
			destroy: () => {},
		});
		let error: string | null = null;
		try {
			const file = plugin.app.vault.getAbstractFileByPath(notePath);
			if (!file) throw new Error("fixture note missing");
			await plugin.publisher.publishNotes([file], profile, false, false);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		return { error, keys, fingerprint: profile.siteAssetsFingerprint };
	}, { bucketName: bucket, notePath: NOTE_PATH });
}

const isHashedApp = (k: string) => /^app\.[0-9a-f]{12}\.js$/.test(k);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testFirstPublishPushesSiteCode(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: First publish after an upgrade pushes the site code");
	const run = await publishOnce(ctx, "bucket-one");
	if (run.error) {
		ctx.fail("First publish: uploads", `error=${run.error}`);
		return;
	}
	console.log(`  Uploaded: ${run.keys.join(", ")}`);
	const appIdx = run.keys.findIndex(isHashedApp);
	const indexIdx = run.keys.indexOf("index.html");
	const missing = ["config.json", "static/mapping/uid-to-hash.json"].filter((k) => !run.keys.includes(k));
	if (appIdx === -1 || indexIdx === -1 || missing.length) {
		ctx.fail("First publish: uploads", `hashed app.js=${appIdx !== -1}, index.html=${indexIdx !== -1}, missing=[${missing.join(", ")}]`);
		return;
	}
	if (indexIdx < appIdx) {
		ctx.fail("First publish: index.html after scripts", `index.html at ${indexIdx}, app at ${appIdx}`);
		return;
	}
	ctx.pass("First publish: uploads", "hashed scripts/styles, then index.html, plus mappings + config.json");
	if (!run.fingerprint || !run.fingerprint.startsWith("bucket-one/:")) {
		ctx.fail("First publish: fingerprint saved", `siteAssetsFingerprint=${run.fingerprint}`);
		return;
	}
	ctx.pass("First publish: fingerprint saved", run.fingerprint);
}

async function testUnchangedPublishSkipsSiteCode(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Unchanged publish only refreshes config.json");
	const run = await publishOnce(ctx, "bucket-one");
	if (run.error) {
		ctx.fail("Unchanged publish", `error=${run.error}`);
		return;
	}
	const siteCode = run.keys.filter((k) => isHashedApp(k) || k === "index.html" || /^(styles|vendor|flexsearch)\./.test(k));
	if (siteCode.length || !run.keys.includes("config.json")) {
		ctx.fail("Unchanged publish", `site code re-uploaded: [${siteCode.join(", ")}], config.json=${run.keys.includes("config.json")}`);
		return;
	}
	ctx.pass("Unchanged publish", "no site code uploaded; config.json refreshed");
}

async function testNewBucketPushesAgain(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: A different bucket gets the site code");
	const run = await publishOnce(ctx, "bucket-two");
	if (run.error || !run.keys.some(isHashedApp) || !run.keys.includes("index.html")) {
		ctx.fail("New bucket publish", `error=${run.error}, keys=[${run.keys.join(", ")}]`);
		return;
	}
	ctx.pass("New bucket publish", "site code pushed to the new bucket");
}

async function testNoPluginErrors(ctx: TestContext, baseline: number): Promise<void> {
	console.log("\nTest 4: No plugin errors logged by the publishes");
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

	// Snapshot settings (the push saves the fingerprint), seed a minimal AWS
	// profile, and create a fixture note published to it.
	const ready = await page.evaluate(async (notePath) => {
		const plugin = (window as any).app.plugins.plugins["commonplace-notes"];
		(window as any).__cpnPublishSettings = JSON.stringify(plugin.settings);
		const profile = plugin.settings.publishingProfiles[0];
		if (!profile) return "no profile";
		profile.publishMechanism = "AWS";
		profile.publishContentIndex = false;
		profile.awsSettings = { ...(profile.awsSettings || {}), awsProfile: "cpn-publish-test", region: "us-east-1", bucketName: "bucket-one", s3Prefix: "" };
		delete profile.siteAssetsFingerprint;
		delete profile.chat;
		const existing = plugin.app.vault.getAbstractFileByPath(notePath);
		if (existing) await plugin.app.vault.delete(existing);
		await plugin.app.vault.create(notePath, `---\ncpn-publish-contexts:\n  - ${profile.id}\n---\nSite assets publish fixture.\n`);
		await new Promise((r) => setTimeout(r, 500)); // let the metadata cache index it
		return "ok";
	}, NOTE_PATH);
	if (ready !== "ok") {
		ctx.fail("Seed profile", ready);
		return;
	}

	try {
		await testFirstPublishPushesSiteCode(ctx);
		await testUnchangedPublishSkipsSiteCode(ctx);
		await testNewBucketPushesAgain(ctx);
	} finally {
		await page.evaluate(async () => {
			const plugin = (window as any).app.plugins.plugins["commonplace-notes"];
			plugin.awsSdkManager.s3Clients.clear();
			const settings = plugin.settings;
			for (const key of Object.keys(settings)) delete settings[key];
			Object.assign(settings, JSON.parse((window as any).__cpnPublishSettings));
			await plugin.saveSettings();
		});
	}
	await testNoPluginErrors(ctx, baseline);
}

runTest({ name: "publish-site-assets", cleanupFiles: [NOTE_PATH] }, tests);
