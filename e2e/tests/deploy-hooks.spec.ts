/**
 * In-Obsidian test for the per-profile deploy-hook subsystem.
 *
 * Unlike the Node-based e2e/scripts/test-deploy-hooks.ts (which stubs the
 * vault/app/aws), this drives the REAL DeployHookManager through the live plugin
 * instance inside Obsidian — exercising actual vault IO, example materialization,
 * per-profile discovery, load-error surfacing, and an end-to-end runDeployHooks
 * against a captured side effect (no real AWS: the hook body only reads context).
 *
 * Run with: npx playwright test --config=e2e/playwright.config.ts
 */

import { test, expect } from "../lib/obsidian-fixture";

const PLUGIN_ID = "commonplace-notes";

test.describe("Deploy hooks (in-Obsidian)", () => {
	test("materialize, validate, surface errors, and run a post hook", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);

		const result = await obsidianPage.evaluate(async (pluginId) => {
			const app = (window as any).app;
			const plugin = app?.plugins?.plugins?.[pluginId];
			if (!plugin) return { error: "plugin not found" };
			const mgr = plugin.deployHookManager;
			if (!mgr) return { error: "deployHookManager not found" };

			const out: Record<string, unknown> = {};
			const profileId = plugin.settings?.publishingProfiles?.[0]?.id ?? "default";
			const hooksDir = mgr.profileHooksDir(profileId);

			// Clean slate — remove the profile's hooks dir if a prior run left it.
			const existingDir = app.vault.getAbstractFileByPath(hooksDir);
			if (existingDir) await app.vault.delete(existingDir, true);

			// 1. Export the example hook into this profile's dir (real vault write).
			const paths = await mgr.exportExampleHooks(profileId);
			out.exportedCount = paths.length;
			out.exampleExists = !!app.vault.getAbstractFileByPath(paths[0]);

			// 2. Validate — the example is a valid post hook, no load errors.
			const v1 = await mgr.validateHooks(profileId);
			out.validCount = v1.definitions.length;
			out.validErrors = v1.errors.length;
			out.examplePhase = v1.definitions[0]?.phase;

			// 3. Materialize a deliberately-broken hook → surfaced as a load error.
			const brokenPath = `${hooksDir}/broken.md`;
			const brokenBody = [
				"---",
				"cpn-type: post-deploy-hook",
				"cpn-hook-name: broken",
				"---",
				"",
				"```ts",
				"this is not (((valid typescript",
				"```",
				"",
			].join("\n");
			const existingBroken = app.vault.getAbstractFileByPath(brokenPath);
			if (existingBroken) await app.vault.modify(existingBroken, brokenBody);
			else await app.vault.create(brokenPath, brokenBody);

			const v2 = await mgr.validateHooks(profileId);
			out.afterBrokenDefs = v2.definitions.length; // still just the example
			out.afterBrokenErrors = v2.errors.length;     // broken hook recorded
			await app.vault.delete(app.vault.getAbstractFileByPath(brokenPath));

			// 4. End-to-end run: a post hook that records a side effect via the
			//    injected context. No real AWS — the body only reads context.
			const capturePath = `${hooksDir}/capture.md`;
			const captureBody = [
				"---",
				"cpn-type: post-deploy-hook",
				"cpn-hook-name: capture",
				"---",
				"",
				"```ts",
				"(globalThis).__cpnHookRan = context.phase + ':' + context.outputs.distributionId;",
				"```",
				"",
			].join("\n");
			await app.vault.create(capturePath, captureBody);

			(globalThis as any).__cpnHookRan = undefined;
			const profile = plugin.settings.publishingProfiles[0];
			await mgr.runDeployHooks("post", {
				profile,
				outputs: {
					bucketName: "b",
					distributionDomainName: "d.cloudfront.net",
					distributionId: "DISTXYZ",
					siteUrl: "https://example.com",
				},
			});
			out.hookRanMarker = (globalThis as any).__cpnHookRan;

			// 5. A different profile's deploy does NOT see this profile's hook.
			//    Simulate by running against a synthetic profile id with an empty dir.
			(globalThis as any).__cpnHookRan = undefined;
			const otherProfile = { ...profile, id: `${profileId}-other` };
			await mgr.runDeployHooks("post", {
				profile: otherProfile,
				outputs: {
					bucketName: "b",
					distributionDomainName: "d.cloudfront.net",
					distributionId: "OTHER",
					siteUrl: "https://example.com",
				},
			});
			out.otherProfileMarker = (globalThis as any).__cpnHookRan ?? null;

			// cleanup
			const cleanupDir = app.vault.getAbstractFileByPath(hooksDir);
			if (cleanupDir) await app.vault.delete(cleanupDir, true);

			return out;
		}, PLUGIN_ID);

		console.log("deploy-hooks probe:", JSON.stringify(result, null, 2));

		expect((result as any).error).toBeUndefined();
		expect((result as any).exportedCount).toBe(1);
		expect((result as any).exampleExists).toBe(true);
		expect((result as any).validCount).toBe(1);
		expect((result as any).validErrors).toBe(0);
		expect((result as any).examplePhase).toBe("post");
		expect((result as any).afterBrokenDefs).toBe(1);
		expect((result as any).afterBrokenErrors).toBe(1);
		expect((result as any).hookRanMarker).toBe("post:DISTXYZ");
		expect((result as any).otherProfileMarker).toBeNull();
	});
});
