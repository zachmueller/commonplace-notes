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

import * as fs from "node:fs";
import * as path from "node:path";
import { runTest, type TestContext } from "../lib/test-harness";
import { createTestNote } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants — fixture note names (vault-relative)
// ---------------------------------------------------------------------------

const PUBLIC_NOTE = "Routing-Public.md";
const PRIVATE_NOTE = "Routing-Private.md";

// insert-template fixtures. Templater is NOT installed in the e2e vault, so the
// action exercises its resolve-then-skip path (real template found, but Templater
// absent → skip with a Notice, no abort) and its unresolved-template abort path.
const INSERT_SKIP_NOTE = "Routing-InsertSkip.md";
const INSERT_TEMPLATE_FILE = "E2E-Insert-Template.md";
const INSERT_SKIP_OPTION = "E2E Insert-Template Skip";
const INSERT_MISSING_OPTION = "E2E Insert-Template Missing";
const CPN_OPTIONS_DIR = "cpn/routes/options";

// ensure-uid fixtures — a bare note routed through an option whose only step is
// the built-in ensure-uid action. Exercises mint-on-create then skip-on-update.
const ENSURE_UID_NOTE = "Routing-EnsureUid.md";
const ENSURE_UID_OPTION = "E2E Ensure-UID";

// Crockford Base32 alphabet (excludes I, L, O, U) — validates a generated UID.
const CROCKFORD_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/;

// Bare notes with no frontmatter — routing seeds everything.
const BARE_BODY = "# Heading\n\nSome body text for the routed note.\n";

// A plain note used as a Templater template source (its body would be appended
// if Templater were installed; here resolution just needs it to exist).
const INSERT_TEMPLATE_BODY = "---\ntemplate-added: true\n---\n\nInserted by the E2E template.\n";

// Option that runs the built-in insert-template action against a REAL template.
// With Templater absent this skips (run stays ok, note unchanged).
const SKIP_OPTION_CONTENT = `---
cpn-type: routing-option
cpn-routing-option-name: "${INSERT_SKIP_OPTION}"
cpn-routing-on-error: abort
cpn-routing-steps:
  - { action: "[[insert-template]]", params: { template: "[[${INSERT_TEMPLATE_FILE.replace(/\.md$/, "")}]]" } }
---

Runs insert-template against a real template; skips cleanly when Templater is absent.
`;

// Option that points insert-template at a non-existent template — resolution
// throws, so the option aborts and returns { ok: false }.
const MISSING_OPTION_CONTENT = `---
cpn-type: routing-option
cpn-routing-option-name: "${INSERT_MISSING_OPTION}"
cpn-routing-on-error: abort
cpn-routing-steps:
  - { action: "[[insert-template]]", params: { template: "[[Definitely-Not-A-Template-ZZZ]]" } }
---

Points insert-template at a missing template; the option aborts (ok:false).
`;

// Option whose only step is the built-in ensure-uid action.
const ENSURE_UID_OPTION_CONTENT = `---
cpn-type: routing-option
cpn-routing-option-name: "${ENSURE_UID_OPTION}"
cpn-routing-on-error: abort
cpn-routing-steps:
  - "[[ensure-uid]]"
---

Runs ensure-uid against the note; mints a cpn-uid if absent, else leaves it.
`;

// Substring of the one [CPN Error] the missing-template test intentionally logs
// (via executeOption's abort path). testNoErrors excludes it.
const EXPECTED_ABORT_ERROR = "Routing action 'insert-template' failed";

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

	const expectedActions = ["move", "set-publish-contexts", "default-frontmatter", "insert-template", "ensure-uid", "code-example"];
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

async function testInsertTemplateSkip(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: insert-template skips cleanly when Templater is absent");
	// The template resolves (it exists in the vault), but Templater isn't
	// installed here, so runInsertTemplate hits the skip-with-Notice branch.
	const probe = await ctx.page.evaluate(
		async ({ notePath, optionName }) => {
			const app = (window as any).app;
			const plugin = app?.plugins?.plugins?.["commonplace-notes"];
			if (!plugin?.routingManager) return { error: "routingManager not found" };
			const file = app.vault.getAbstractFileByPath(notePath);
			if (!file) return { error: `note not found at ${notePath}` };
			const before = await app.vault.read(file);
			let run: { ok: boolean; error?: string; errors: string[] };
			try {
				run = await plugin.routingManager.runOptionByName(file, optionName, "create");
			} catch (e: any) {
				return { error: `runOptionByName threw: ${e?.message ?? String(e)}` };
			}
			await new Promise((r) => setTimeout(r, 300));
			const after = await app.vault.read(file);
			return { runOk: run.ok, runError: run.error, errorCount: run.errors.length, unchanged: before === after };
		},
		{ notePath: INSERT_SKIP_NOTE, optionName: INSERT_SKIP_OPTION },
	);
	const shot = await safeShot(ctx, "05-insert-skip");

	if ((probe as any).error) {
		ctx.fail("insert-template skip (no Templater)", (probe as any).error, shot);
		return;
	}
	// Skip is not an error: the option completes ok with no collected errors.
	if ((probe as any).runOk === true && (probe as any).errorCount === 0) {
		ctx.pass("insert-template skip completes ok", `run ok, 0 errors (Templater absent → skipped)`, shot);
	} else {
		ctx.fail("insert-template skip completes ok", `expected ok:true/0 errors, got ${JSON.stringify(probe)}`, shot);
	}
	// The note must be untouched — the skip branch writes nothing.
	if ((probe as any).unchanged === true) {
		ctx.pass("insert-template skip leaves note unchanged", "note body identical before/after", shot);
	} else {
		ctx.fail("insert-template skip leaves note unchanged", "note body changed despite skip", shot);
	}
}

async function testInsertTemplateMissing(ctx: TestContext): Promise<void> {
	console.log("\nTest 6: insert-template with an unresolvable template aborts (ok:false)");
	const probe = await ctx.page.evaluate(
		async ({ notePath, optionName }) => {
			const app = (window as any).app;
			const plugin = app?.plugins?.plugins?.["commonplace-notes"];
			if (!plugin?.routingManager) return { error: "routingManager not found" };
			// Reuse the private note (already routed); the step throws before touching it.
			const file = app.vault.getAbstractFileByPath(notePath) ?? app.vault.getMarkdownFiles()[0];
			if (!file) return { error: "no file available" };
			try {
				const run = await plugin.routingManager.runOptionByName(file, optionName, "create");
				return { ok: run.ok, err: run.error };
			} catch (e: any) {
				return { threw: e?.message ?? String(e) };
			}
		},
		{ notePath: `private/${PRIVATE_NOTE}`, optionName: INSERT_MISSING_OPTION },
	);
	const shot = await safeShot(ctx, "06-insert-missing");

	if ((probe as any).error) {
		ctx.fail("insert-template missing aborts", (probe as any).error, shot);
		return;
	}
	if ((probe as any).threw) {
		ctx.fail("insert-template missing aborts", `threw instead of returning: ${(probe as any).threw}`, shot);
		return;
	}
	if ((probe as any).ok === false && typeof (probe as any).err === "string" && (probe as any).err.includes("template not found")) {
		ctx.pass("insert-template missing aborts", `returned { ok: false, error: "${(probe as any).err}" }`, shot);
	} else {
		ctx.fail("insert-template missing aborts", `expected ok:false with "template not found", got ${JSON.stringify(probe)}`, shot);
	}
}

// Carried from the create run so the update run can assert the UID is unchanged.
let ensureUidValue: unknown;

async function testEnsureUidCreate(ctx: TestContext): Promise<void> {
	console.log("\nTest 7: ensure-uid mints a cpn-uid on a note that lacks one");
	const probe = await routeAndRead(ctx, ENSURE_UID_NOTE, ENSURE_UID_OPTION, "create");
	const shot = await safeShot(ctx, "07-ensure-uid-create");

	if (probe.error) {
		ctx.fail("ensure-uid mints a UID", probe.error, shot);
		return;
	}
	if (!probe.runOk) {
		ctx.fail("ensure-uid mints a UID", `run failed: ${probe.runError}`, shot);
		return;
	}

	// Read the vault's configured UID length from the live plugin settings.
	const uidLength = await ctx.page.evaluate(() => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		return plugin?.settings?.uidLength ?? 8;
	});

	ensureUidValue = probe.uid;
	const uid = probe.uid;
	if (
		typeof uid === "string" &&
		uid.length === uidLength &&
		CROCKFORD_RE.test(uid)
	) {
		ctx.pass("ensure-uid mints a UID", `cpn-uid = ${uid} (length ${uidLength}, Crockford)`, shot);
	} else {
		ctx.fail(
			"ensure-uid mints a UID",
			`expected a ${uidLength}-char Crockford string, got ${JSON.stringify(uid)}`,
			shot,
		);
	}
}

async function testEnsureUidUpdateStable(ctx: TestContext): Promise<void> {
	console.log("\nTest 8: ensure-uid leaves an existing cpn-uid unchanged (update mode)");
	// Same note as Test 7 — it already has a cpn-uid, so re-running must not clobber it.
	const probe = await routeAndRead(ctx, ENSURE_UID_NOTE, ENSURE_UID_OPTION, "update");
	const shot = await safeShot(ctx, "08-ensure-uid-update");

	if (probe.error) {
		ctx.fail("ensure-uid is stable on re-run", probe.error, shot);
		return;
	}
	if (!probe.runOk) {
		ctx.fail("ensure-uid is stable on re-run", `run failed: ${probe.runError}`, shot);
		return;
	}

	if (probe.uid === ensureUidValue && typeof probe.uid === "string") {
		ctx.pass("ensure-uid is stable on re-run", `cpn-uid still ${probe.uid} (not regenerated)`, shot);
	} else {
		ctx.fail(
			"ensure-uid is stable on re-run",
			`cpn-uid changed: ${JSON.stringify(ensureUidValue)} → ${JSON.stringify(probe.uid)}`,
			shot,
		);
	}
}

async function testUnknownOption(ctx: TestContext): Promise<void> {
	console.log("\nTest 9: Unknown option returns a structured error (no throw)");
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
	console.log("\nTest 10: no unexpected plugin errors captured");
	// Test 6 intentionally drives an abort, which logs one [CPN Error] via
	// executeOption's catch. Exclude that expected entry; everything else is a fail.
	const errors = ctx.collector
		.getLogsByLevel("error")
		.filter((e) => !e.message.includes(EXPECTED_ABORT_ERROR));
	if (errors.length === 0) {
		ctx.pass("No unexpected plugin errors", "0 unexpected error-level log entries");
	} else {
		const sample = errors.slice(-5).map((e) => e.message).join(" | ");
		ctx.fail("No unexpected plugin errors", `${errors.length} error(s): ${sample}`);
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
	await testInsertTemplateSkip(ctx);
	await testInsertTemplateMissing(ctx);
	await testEnsureUidCreate(ctx);
	await testEnsureUidUpdateStable(ctx);
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
			createTestNote(vaultPath, INSERT_SKIP_NOTE, BARE_BODY);
			createTestNote(vaultPath, ENSURE_UID_NOTE, BARE_BODY);
			// A real template file so insert-template resolution succeeds.
			createTestNote(vaultPath, INSERT_TEMPLATE_FILE, INSERT_TEMPLATE_BODY);
			// Author the insert-template + ensure-uid options into the discovered options dir.
			const optionsDir = path.join(vaultPath, CPN_OPTIONS_DIR);
			fs.mkdirSync(optionsDir, { recursive: true });
			fs.writeFileSync(path.join(optionsDir, `${INSERT_SKIP_OPTION}.md`), SKIP_OPTION_CONTENT);
			fs.writeFileSync(path.join(optionsDir, `${INSERT_MISSING_OPTION}.md`), MISSING_OPTION_CONTENT);
			fs.writeFileSync(path.join(optionsDir, `${ENSURE_UID_OPTION}.md`), ENSURE_UID_OPTION_CONTENT);
		},
		// The run moves notes and writes frontmatter; clean up both original and
		// moved locations so the next run starts fresh.
		cleanupFiles: [
			PUBLIC_NOTE,
			PRIVATE_NOTE,
			`private/${PRIVATE_NOTE}`,
			"private",
			INSERT_SKIP_NOTE,
			INSERT_TEMPLATE_FILE,
			ENSURE_UID_NOTE,
			`${CPN_OPTIONS_DIR}/${INSERT_SKIP_OPTION}.md`,
			`${CPN_OPTIONS_DIR}/${INSERT_MISSING_OPTION}.md`,
			`${CPN_OPTIONS_DIR}/${ENSURE_UID_OPTION}.md`,
		],
	},
	tests,
);
