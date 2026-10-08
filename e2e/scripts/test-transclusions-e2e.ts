#!/usr/bin/env npx tsx
/**
 * Transclusions E2E Test
 *
 * Verifies, inside the REAL Obsidian runtime, how `![[embeds]]` are published:
 * the real NoteManager.markdownToHtml pipeline (scaffolds, metadataCache link
 * resolution, access rules) turns embeds of published notes into UID-only
 * `.cpn-transclusion` placeholders that the site fills at view time, and never
 * leaks unpublished or gated targets.
 *
 * Like test-obscure-wikilinks-e2e.ts it drives NoteManager.queueNote and reads
 * the queued NoteState (content / currentHash) — no AWS upload.
 *
 * Scenarios:
 *   1. Published target: whole-note, heading, block and inline embeds become
 *      placeholders carrying the target's UID; no stray "!".
 *   2. Target block id (`^blk`) renders as data-block-id, marker stripped.
 *   3. Unpublished target → unpublished-link span, no placeholder.
 *   4. Gated target embedded in a public note → unpublished-link span; the
 *      gated target's UID never appears in the parent's HTML (with a profile
 *      on which the target itself is publishable, so this is the visibility
 *      rule rather than a fail-closed config).
 *   5. Editing and re-queuing the target changes the target's hash but leaves
 *      the parent's hash and HTML unchanged (embeds are resolved at view time).
 *   6. No plugin errors captured during the run.
 *
 * Run: npx tsx e2e/scripts/test-transclusions-e2e.ts
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { createTestNote } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants — fixture notes (vault-relative)
// ---------------------------------------------------------------------------

const PARENT_NOTE = "Trans-Parent.md";
const TARGET_NOTE = "Trans-Target.md";
const UNPUBLISHED_NOTE = "Trans-Unpublished.md";
const GATED_NOTE = "Trans-Gated.md";
const PROFILE_ID = "public";
const GROUP = "members";

const PUBLISH_FM = `---\ncpn-publish-contexts:\n  - ${PROFILE_ID}\n---\n`;
const GATED_FM = `---\ncpn-publish-contexts:\n  - ${PROFILE_ID}\ncpn-access-groups:\n  - ${GROUP}\n---\n`;

const PARENT_BODY = [
	"Intro paragraph.",
	"",
	"![[Trans-Target]]",
	"",
	"![[Trans-Target#Details]]",
	"",
	"![[Trans-Target#^blk]]",
	"",
	"Inline ![[Trans-Target]] here.",
	"",
	"![[Trans-Unpublished]]",
	"",
	"![[Trans-Gated]]",
	"",
].join("\n");

const TARGET_BODY = "# Target\n\nA block worth embedding. ^blk\n\n## Details\n\nDetail text.\n";
const TARGET_BODY_EDITED = "# Target\n\nA block worth embedding, now edited. ^blk\n\n## Details\n\nNew detail text.\n";

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

interface QueueProbe {
	error?: string;
	content?: string;
	hash?: string;
	uid?: string | null;
}

// Screenshots can throw `__name is not defined` on some Obsidian builds (see
// test-obscure-wikilinks-e2e.ts); never let that abort the real assertions.
async function safeShot(ctx: TestContext, name: string): Promise<string | undefined> {
	try {
		return await ctx.screenshot(name);
	} catch (e: any) {
		console.log(`  (screenshot "${name}" skipped: ${e?.message ?? String(e)})`);
		return undefined;
	}
}

/** queueNote(note) and read back its NoteState (content + hash + uid). */
async function queueAndRead(ctx: TestContext, noteName: string): Promise<QueueProbe> {
	return ctx.page.evaluate(
		async ({ noteName, profileId }) => {
			const app = (window as any).app;
			const plugin = app?.plugins?.plugins?.["commonplace-notes"];
			if (!plugin) return { error: "plugin not found" };
			const file = app.vault.getAbstractFileByPath(noteName);
			if (!file) return { error: `note not found: ${noteName}` };
			try {
				await plugin.noteManager.queueNote(file, profileId);
			} catch (e: any) {
				return { error: `queueNote threw: ${e?.message ?? String(e)}` };
			}
			const uid = plugin.frontmatterManager.getNoteUID(file);
			const state = plugin.noteManager.pendingNotes?.get(`${profileId}:${uid}`);
			if (!state) return { error: `no NoteState queued for ${noteName}` };
			return { content: state.content as string, hash: state.currentHash as string, uid };
		},
		{ noteName, profileId: PROFILE_ID },
	);
}

/** UID of a note (minting it if the note has a publish context). */
async function uidOf(ctx: TestContext, noteName: string): Promise<string | null> {
	return ctx.page.evaluate((noteName) => {
		const app = (window as any).app;
		const plugin = app?.plugins?.plugins?.["commonplace-notes"];
		const file = app.vault.getAbstractFileByPath(noteName);
		return file ? plugin.frontmatterManager.getNoteUID(file) : null;
	}, noteName);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Captured by test 1 for later comparisons.
let parentProbe: QueueProbe | undefined;
let targetUid: string | null = null;

async function testGatingProfile(ctx: TestContext): Promise<void> {
	console.log("\nSetup: in-memory profile that can publish the gated target");
	// In memory only (never saved): an AWS profile whose BYO edge function is
	// vouched to enforce /restricted/<group>/, with the group defined. That makes
	// the gated target itself publishable, so scenario 4 exercises the
	// "not visible from a public parent" rule rather than a fail-closed config.
	const probe = await ctx.page.evaluate(
		({ profileId, group, gatedName }) => {
			const app = (window as any).app;
			const plugin = app?.plugins?.plugins?.["commonplace-notes"];
			const profile = plugin?.settings.publishingProfiles.find((p: any) => p.id === profileId);
			if (!profile) return { error: "profile not found" };
			(window as any).__transProfileBackup = JSON.stringify(profile);
			profile.publishMechanism = "AWS";
			profile.infrastructureState = { ...(profile.infrastructureState || {}), readGateMode: "byo" };
			profile.byoEnforcesAccessGroups = true;
			profile.accessGroups = { ...(profile.accessGroups || {}), [group]: { members: [] } };
			const gated = app.vault.getAbstractFileByPath(gatedName);
			if (!gated) return { error: `note not found: ${gatedName}` };
			const access = plugin.noteManager.resolveNoteAccess(gated, profile);
			return { ok: access.ok, groups: access.groups, reason: access.reason };
		},
		{ profileId: PROFILE_ID, group: GROUP, gatedName: GATED_NOTE },
	);
	if (probe.error) {
		ctx.fail("Gated target publishable", probe.error);
	} else if (probe.ok && probe.groups?.includes(GROUP)) {
		ctx.pass("Gated target publishable", `resolveNoteAccess → ok, groups=${JSON.stringify(probe.groups)}`);
	} else {
		ctx.fail("Gated target publishable", `resolveNoteAccess → ${JSON.stringify(probe)}`);
	}
}

async function restoreProfile(ctx: TestContext): Promise<void> {
	await ctx.page.evaluate((profileId) => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		const backup = (window as any).__transProfileBackup;
		const profiles = plugin?.settings.publishingProfiles;
		const idx = profiles?.findIndex((p: any) => p.id === profileId);
		if (backup && idx >= 0) profiles[idx] = JSON.parse(backup);
	}, PROFILE_ID);
}

async function testPublishedEmbeds(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: embeds of a published target become UID placeholders");
	const probe = await queueAndRead(ctx, PARENT_NOTE);
	parentProbe = probe;
	const shot = await safeShot(ctx, "01-parent-queued");
	if (probe.error) {
		ctx.fail("Parent queued", probe.error, shot);
		return;
	}
	const content = probe.content ?? "";
	targetUid = await uidOf(ctx, TARGET_NOTE);
	if (!targetUid || !/^[0-9A-Z]+$/.test(targetUid)) {
		ctx.fail("Target UID minted", `got ${JSON.stringify(targetUid)}`, shot);
		return;
	}
	ctx.pass("Target UID minted", `target cpn-uid = ${targetUid}`, shot);

	const expectations: Array<[string, string]> = [
		["Whole-note embed → block placeholder", `class="line cpn-transclusion" data-line="3" data-uid="${targetUid}" data-title="Trans-Target">`],
		["Heading embed carries data-heading", `data-uid="${targetUid}" data-title="Trans-Target" data-heading="details">`],
		["Block embed carries data-block", `data-uid="${targetUid}" data-title="Trans-Target" data-block="blk">`],
		["Inline embed → span placeholder", `Inline <span class="cpn-transclusion" data-uid="${targetUid}"`],
		["Fallback link inside placeholder", `<a href="#/u${targetUid}" data-heading="^blk">Trans-Target</a>`],
	];
	for (const [name, needle] of expectations) {
		if (content.includes(needle)) ctx.pass(name, `content contains ${needle}`);
		else ctx.fail(name, `content missing ${needle}\n--- content ---\n${content}`);
	}
	if (!content.includes("!")) ctx.pass("No stray !", "embed markers consumed");
	else ctx.fail("No stray !", `content still contains "!"\n--- content ---\n${content}`);
}

async function testTargetBlockId(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: target block id renders as data-block-id");
	const probe = await queueAndRead(ctx, TARGET_NOTE);
	if (probe.error) {
		ctx.fail("Target queued", probe.error);
		return;
	}
	const content = probe.content ?? "";
	if (/data-block-id="blk">A block worth embedding\.<\/p>/.test(content) && !content.includes("^blk")) {
		ctx.pass("Block id on target", "paragraph carries data-block-id=\"blk\", marker stripped");
	} else {
		ctx.fail("Block id on target", `unexpected target HTML\n--- content ---\n${content}`);
	}
}

async function testHiddenTargets(ctx: TestContext): Promise<void> {
	console.log("\nTest 3-4: unpublished and gated targets never become placeholders");
	const content = parentProbe?.content ?? "";
	if (!parentProbe?.content) {
		ctx.fail("Hidden targets", "parent content was not captured (Test 1 failed)");
		return;
	}
	if (content.includes('<span class="unpublished-link">Trans-Unpublished</span>')) {
		ctx.pass("Unpublished target → span", "rendered as unpublished-link");
	} else {
		ctx.fail("Unpublished target → span", `missing unpublished span\n--- content ---\n${content}`);
	}
	if (content.includes('<span class="unpublished-link">Trans-Gated</span>')) {
		ctx.pass("Gated target → span", "rendered as unpublished-link");
	} else {
		ctx.fail("Gated target → span", `missing gated span\n--- content ---\n${content}`);
	}
	const placeholders = (content.match(/data-uid="/g) || []).length;
	if (placeholders === 4) ctx.pass("Only published embeds are placeholders", "4 placeholders (all for the published target)");
	else ctx.fail("Only published embeds are placeholders", `expected 4 data-uid placeholders, got ${placeholders}`);

	const gatedUid = await uidOf(ctx, GATED_NOTE);
	if (!gatedUid) {
		ctx.fail("Gated UID absent from parent", "gated target has no UID to check against");
	} else if (content.includes(gatedUid)) {
		ctx.fail("Gated UID absent from parent", `parent HTML leaks gated UID ${gatedUid}`);
	} else {
		ctx.pass("Gated UID absent from parent", `gated UID ${gatedUid} not in parent HTML`);
	}
}

async function testParentHashStable(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: editing the target leaves the parent's hash unchanged");
	const before = await queueAndRead(ctx, TARGET_NOTE);
	const edited = await ctx.page.evaluate(
		async ({ targetName, fm, body }) => {
			const app = (window as any).app;
			const file = app.vault.getAbstractFileByPath(targetName);
			if (!file) return { error: `note not found: ${targetName}` };
			// Keep the minted cpn-uid: rewrite only the body under the frontmatter.
			const current: string = await app.vault.read(file);
			const fmEnd = current.indexOf("\n---\n", 4);
			const head = fmEnd >= 0 ? current.slice(0, fmEnd + 5) : fm;
			await app.vault.modify(file, head + "\n" + body);
			return { ok: true };
		},
		{ targetName: TARGET_NOTE, fm: PUBLISH_FM, body: TARGET_BODY_EDITED },
	);
	if ((edited as any).error) {
		ctx.fail("Target edited", (edited as any).error);
		return;
	}
	await ctx.page.waitForTimeout(1_500); // metadataCache re-index

	const after = await queueAndRead(ctx, TARGET_NOTE);
	const parentAfter = await queueAndRead(ctx, PARENT_NOTE);
	const shot = await safeShot(ctx, "02-after-target-edit");

	if (before.hash && after.hash && before.hash !== after.hash && (after.content ?? "").includes("now edited")) {
		ctx.pass("Target hash changed", `${before.hash.slice(0, 10)}… → ${after.hash.slice(0, 10)}…`, shot);
	} else {
		ctx.fail("Target hash changed", `before=${before.hash} after=${after.hash} error=${after.error ?? before.error}`, shot);
	}
	if (after.uid !== targetUid) {
		ctx.fail("Target UID stable", `UID changed ${targetUid} → ${after.uid}`, shot);
	}
	if (parentProbe?.hash && parentAfter.hash === parentProbe.hash) {
		ctx.pass("Parent hash unchanged", `still ${parentProbe.hash.slice(0, 10)}…`, shot);
	} else {
		ctx.fail("Parent hash unchanged", `before=${parentProbe?.hash} after=${parentAfter.hash} error=${parentAfter.error}`, shot);
	}
	if (parentAfter.content === parentProbe?.content) {
		ctx.pass("Parent HTML unchanged", "placeholders hold no target content");
	} else {
		ctx.fail("Parent HTML unchanged", `parent content changed\n--- after ---\n${parentAfter.content}`);
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
	await testGatingProfile(ctx);
	try {
		await testPublishedEmbeds(ctx);
		await testTargetBlockId(ctx);
		await testHiddenTargets(ctx);
		await testParentHashStable(ctx);
	} finally {
		await restoreProfile(ctx);
	}
	await testNoErrors(ctx);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runTest(
	{
		name: "transclusions-e2e",
		setupVault: (vaultPath) => {
			createTestNote(vaultPath, PARENT_NOTE, PUBLISH_FM + PARENT_BODY);
			createTestNote(vaultPath, TARGET_NOTE, PUBLISH_FM + TARGET_BODY);
			createTestNote(vaultPath, UNPUBLISHED_NOTE, "# Unpublished\n\nNot opted in.\n");
			createTestNote(vaultPath, GATED_NOTE, GATED_FM + "# Gated\n\nMembers only.\n");
		},
		cleanupFiles: [PARENT_NOTE, TARGET_NOTE, UNPUBLISHED_NOTE, GATED_NOTE],
	},
	tests,
);
