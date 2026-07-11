#!/usr/bin/env npx tsx
/**
 * Note Routing Engine E2E Test
 *
 * Verifies, inside the REAL Obsidian runtime, that the note-routing engine
 * discovers its built-in actions/options, and that running an option applies the
 * composed actions (move + set-frontmatter + publish-contexts + code) correctly —
 * including the create-vs-update capability semantics and the merge behavior of
 * `FrontmatterManager.mergeFrontmatter`.
 *
 * It drives `RoutingManager.runOptionByName(file, optionName, mode)` (the
 * non-interactive entry point the two commands share), so it exercises the real
 * discovery → compile → resolve → execute pipeline against the live vault +
 * metadataCache, without depending on the suggester modal.
 *
 * Scenarios:
 *   1. Plugin loaded; RoutingManager present; built-in actions + options load
 *      (move, set-publish-contexts, default-frontmatter, code-example; options
 *      Public (all), Private, Amazon-only) with no load errors.
 *   2. Route a NEW note via "Public (all)": the note moves to the vault root,
 *      gets cpn-publish-contexts [public, amazon], and a created-at seeded from
 *      the file ctime (default-frontmatter runs in create mode).
 *   3. Re-route the SAME note via "Amazon-only" in UPDATE mode: default-frontmatter
 *      is SKIPPED (created-at unchanged, not clobbered) and publish-contexts is
 *      UNIONED (public, amazon preserved; no duplicates).
 *   4. Route a note via "Private": moved into private/, and NO cpn-publish-contexts
 *      is written (so it is never published / no UID minted).
 *   5. Unknown option name returns a structured error (no throw).
 *   6. No plugin errors captured during the run.
 *
 * Run: npx tsx e2e/scripts/test-routing-engine-e2e.ts
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { createTestNote } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants — fixture note names (vault-relative)
// ---------------------------------------------------------------------------

const PUBLIC_NOTE = "Routing-Public.md";
const PRIVATE_NOTE = "Routing-Private.md";

// Bare notes with no frontmatter — routing seeds everything.
const BARE_BODY = "# Heading\n\nSome body text for the routed note.\n";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Screenshots can throw `__name is not defined` on some Obsidian/Electron
// builds (an Obsidian-internal issue). Capture best-effort.
async function safeShot(ctx: TestContext, name: string): Promise<string | undefined> {
	try {
		return await ctx.screenshot(name);
	} catch (e: any) {
		console.log(`  (screenshot "${name}" skipped: ${e?.message ?? String(e)})`);
		return undefined;
	}
}

/** Snapshot of a note's location + relevant frontmatter, read from the live cache. */
interface NoteProbe {
	error?: string;
	path?: string;
	contexts?: unknown;
	createdAt?: unknown;
	uid?: unknown;
}

/**
 * Run a named routing option on a fixture note and read back its resulting path
 * and frontmatter. Runs entirely inside the Obsidian page so it touches the real
 * RoutingManager, FrontmatterManager, and metadataCache. Resolves the file fresh
 * by its current path (routing may have moved it in a prior step).
 */
async function routeAndRead(
	ctx: TestContext,
	currentPath: string,
	optionName: string,
	mode: "create" | "update",
): Promise<NoteProbe & { runOk?: boolean; runError?: string }> {
	return ctx.page.evaluate(
		async ({ currentPath, optionName, mode }) => {
			const app = (window as any).app;
			const plugin = app?.plugins?.plugins?.["commonplace-notes"];
			if (!plugin) return { error: "plugin not found" };
			if (!plugin.routingManager) return { error: "routingManager not found" };

			const file = app.vault.getAbstractFileByPath(currentPath);
			if (!file) return { error: `note not found at ${currentPath}` };

			let run: { ok: boolean; error?: string; errors: string[] };
			try {
				run = await plugin.routingManager.runOptionByName(file, optionName, mode);
			} catch (e: any) {
				return { error: `runOptionByName threw: ${e?.message ?? String(e)}` };
			}

			// Give the metadata cache a beat to reflect the frontmatter writes.
			await new Promise((r) => setTimeout(r, 800));

			// `file` is the same TFile instance; its path updates in place on move.
			const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
			return {
				runOk: run.ok,
				runError: run.error,
				path: file.path,
				contexts: fm["cpn-publish-contexts"],
				createdAt: fm["created-at"],
				uid: fm["cpn-uid"],
			};
		},
		{ currentPath, optionName, mode },
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testDiscovery(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: RoutingManager loads built-in actions + options");
	const { page } = ctx;

	const probe = await page.evaluate(async () => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		if (!plugin) return { error: "plugin not found" };
		const rm = plugin.routingManager;
		if (!rm) return { error: "routingManager not found" };
		const profileId = plugin.settings.publishingProfiles[0]?.id ?? "default";
		try {
			await rm.loadRoutes(profileId);
		} catch (e: any) {
			return { error: `loadRoutes threw: ${e?.message ?? String(e)}` };
		}
		return {
			actions: rm.getBuiltinActionNames(),
			options: rm.getBuiltinOptionNames(),
			loadErrors: rm.getLoadErrors().map((e: any) => e.message),
		};
	});

	const shot = await safeShot(ctx, "01-discovery");

	if (probe.error) {
		ctx.fail("RoutingManager present", probe.error, shot);
		return;
	}

	const expectedActions = ["move", "set-publish-contexts", "default-frontmatter", "code-example"];
	const haveActions = expectedActions.every((a) => probe.actions.includes(a));
	if (haveActions) {
		ctx.pass("Built-in actions load", `actions: ${probe.actions.join(", ")}`, shot);
	} else {
		ctx.fail("Built-in actions load", `expected ${expectedActions.join(", ")}, got ${probe.actions.join(", ")}`, shot);
	}

	const expectedOptions = ["Public (all)", "Private", "Amazon-only"];
	const haveOptions = expectedOptions.every((o) => probe.options.includes(o));
	if (haveOptions) {
		ctx.pass("Built-in options load", `options: ${probe.options.join(", ")}`, shot);
	} else {
		ctx.fail("Built-in options load", `expected ${expectedOptions.join(", ")}, got ${probe.options.join(", ")}`, shot);
	}

	if (probe.loadErrors.length === 0) {
		ctx.pass("No routing load errors", "0 load errors after loadRoutes");
	} else {
		ctx.fail("No routing load errors", `${probe.loadErrors.length}: ${probe.loadErrors.join(" | ")}`, shot);
	}
}

// Carried across tests so the update run can assert created-at is unchanged.
let publicCreatedAt: unknown;

async function testRouteNewNote(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: Route a new note via 'Public (all)'");
	const probe = await routeAndRead(ctx, PUBLIC_NOTE, "Public (all)", "create");
	const shot = await safeShot(ctx, "02-public-create");

	if (probe.error) {
		ctx.fail("Public (all) route", probe.error, shot);
		return;
	}
	if (!probe.runOk) {
		ctx.fail("Public (all) route", `run failed: ${probe.runError}`, shot);
		return;
	}

	// Moved to the vault root ("/" target → basename at root).
	if (probe.path === PUBLIC_NOTE) {
		ctx.pass("Moved to vault root", `path = ${probe.path}`, shot);
	} else {
		ctx.fail("Moved to vault root", `expected ${PUBLIC_NOTE}, got ${probe.path}`, shot);
	}

	// Publish contexts set to [public, amazon].
	const ctx1 = Array.isArray(probe.contexts) ? (probe.contexts as string[]) : [];
	if (ctx1.includes("public") && ctx1.includes("amazon") && ctx1.length === 2) {
		ctx.pass("Publish contexts set", `cpn-publish-contexts = ${JSON.stringify(ctx1)}`, shot);
	} else {
		ctx.fail("Publish contexts set", `expected [public, amazon], got ${JSON.stringify(probe.contexts)}`, shot);
	}

	// created-at seeded (default-frontmatter ran in create mode).
	publicCreatedAt = probe.createdAt;
	if (typeof probe.createdAt === "string" && /\d{4}-\d{2}-\d{2}/.test(probe.createdAt)) {
		ctx.pass("created-at seeded", `created-at = ${probe.createdAt}`, shot);
	} else {
		ctx.fail("created-at seeded", `expected a date string, got ${JSON.stringify(probe.createdAt)}`, shot);
	}
}

async function testReRouteUpdateMode(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: Re-route the same note via 'Amazon-only' in update mode");
	// Note is at the root after Test 2.
	const probe = await routeAndRead(ctx, PUBLIC_NOTE, "Amazon-only", "update");
	const shot = await safeShot(ctx, "03-amazon-update");

	if (probe.error) {
		ctx.fail("Amazon-only update route", probe.error, shot);
		return;
	}
	if (!probe.runOk) {
		ctx.fail("Amazon-only update route", `run failed: ${probe.runError}`, shot);
		return;
	}

	// created-at must be UNCHANGED — default-frontmatter is new-note-only, skipped on update.
	if (probe.createdAt === publicCreatedAt) {
		ctx.pass("created-at preserved on update", `created-at still ${JSON.stringify(probe.createdAt)} (default-frontmatter skipped)`, shot);
	} else {
		ctx.fail("created-at preserved on update", `created-at changed: ${JSON.stringify(publicCreatedAt)} → ${JSON.stringify(probe.createdAt)}`, shot);
	}

	// publish-contexts UNIONED: public (from before) + amazon (already there) — no dupes.
	const ctx2 = Array.isArray(probe.contexts) ? (probe.contexts as string[]) : [];
	const unioned = ctx2.includes("public") && ctx2.includes("amazon");
	const noDupes = new Set(ctx2).size === ctx2.length;
	if (unioned && noDupes) {
		ctx.pass("Publish contexts unioned", `cpn-publish-contexts = ${JSON.stringify(ctx2)} (merged, de-duped)`, shot);
	} else {
		ctx.fail("Publish contexts unioned", `expected a de-duped union containing public+amazon, got ${JSON.stringify(probe.contexts)}`, shot);
	}
}

async function testPrivateOption(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: Route a note via 'Private' (moved, no publish contexts)");
	const probe = await routeAndRead(ctx, PRIVATE_NOTE, "Private", "create");
	const shot = await safeShot(ctx, "04-private");

	if (probe.error) {
		ctx.fail("Private route", probe.error, shot);
		return;
	}
	if (!probe.runOk) {
		ctx.fail("Private route", `run failed: ${probe.runError}`, shot);
		return;
	}

	// Moved into private/.
	if (probe.path === `private/${PRIVATE_NOTE}`) {
		ctx.pass("Moved to private/", `path = ${probe.path}`, shot);
	} else {
		ctx.fail("Moved to private/", `expected private/${PRIVATE_NOTE}, got ${probe.path}`, shot);
	}

	// No publish contexts written → no UID minted (never published).
	const noContexts = probe.contexts === undefined || (Array.isArray(probe.contexts) && probe.contexts.length === 0);
	if (noContexts) {
		ctx.pass("No publish contexts for private", `cpn-publish-contexts = ${JSON.stringify(probe.contexts)}`, shot);
	} else {
		ctx.fail("No publish contexts for private", `expected none, got ${JSON.stringify(probe.contexts)}`, shot);
	}
}

async function testUnknownOption(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: Unknown option returns a structured error (no throw)");
	const probe = await ctx.page.evaluate(async ({ notePath }) => {
		const app = (window as any).app;
		const plugin = app?.plugins?.plugins?.["commonplace-notes"];
		if (!plugin?.routingManager) return { error: "routingManager not found" };
		const file = app.vault.getAbstractFileByPath(notePath) ?? app.vault.getMarkdownFiles()[0];
		if (!file) return { error: "no file available" };
		try {
			const run = await plugin.routingManager.runOptionByName(file, "No Such Option", "update");
			return { ok: run.ok, err: run.error };
		} catch (e: any) {
			return { threw: e?.message ?? String(e) };
		}
	}, { notePath: `private/${PRIVATE_NOTE}` });

	if ((probe as any).threw) {
		ctx.fail("Unknown option handled", `threw instead of returning: ${(probe as any).threw}`);
		return;
	}
	if ((probe as any).ok === false && typeof (probe as any).err === "string") {
		ctx.pass("Unknown option handled", `returned { ok: false, error: "${(probe as any).err}" }`);
	} else {
		ctx.fail("Unknown option handled", `expected ok:false with an error, got ${JSON.stringify(probe)}`);
	}
}

async function testNoErrors(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: no plugin errors captured");
	const errors = ctx.collector.getLogsByLevel("error");
	if (errors.length === 0) {
		ctx.pass("No plugin errors", "0 error-level log entries");
	} else {
		const sample = errors.slice(-5).map((e) => e.message).join(" | ");
		ctx.fail("No plugin errors", `${errors.length} error(s): ${sample}`);
	}
}

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
	await ctx.page.waitForTimeout(5_000); // plugin init + metadata cache warm-up
	await testDiscovery(ctx);
	await testRouteNewNote(ctx);
	await testReRouteUpdateMode(ctx);
	await testPrivateOption(ctx);
	await testUnknownOption(ctx);
	await testNoErrors(ctx);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runTest(
	{
		name: "routing-engine-e2e",
		setupVault: (vaultPath) => {
			createTestNote(vaultPath, PUBLIC_NOTE, BARE_BODY);
			createTestNote(vaultPath, PRIVATE_NOTE, BARE_BODY);
		},
		// The run moves notes and writes frontmatter; clean up both original and
		// moved locations so the next run starts fresh.
		cleanupFiles: [PUBLIC_NOTE, PRIVATE_NOTE, `private/${PRIVATE_NOTE}`, "private"],
	},
	tests,
);
