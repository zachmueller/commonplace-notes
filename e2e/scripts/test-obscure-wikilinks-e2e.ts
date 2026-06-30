#!/usr/bin/env npx tsx
/**
 * Obscure Raw Wikilinks E2E Test
 *
 * Verifies, inside the REAL Obsidian runtime, that the per-profile
 * `obscureRawWikilinks` setting rewrites wikilink note-paths to UIDs in the
 * published raw Markdown — while leaving the rendered HTML, same-note links,
 * and the author's Markdown structure intact.
 *
 * It drives NoteManager.queueNote('default') on a fixture note and reads the
 * resulting NoteState back out of the pendingNotes map, so it inspects exactly
 * the `raw`/`content`/`currentHash` that would be serialized into the staged
 * JSON — without depending on any AWS upload.
 *
 * Scenarios:
 *   1. Plugin loaded and the obscureRawWikilinks setting defaults to on.
 *   2. With obscuring ON: published target → [[UID|Title]]; the scrubbed UID
 *      matches the target note's actual cpn-uid (minted via getNoteUID).
 *   3. With obscuring ON: nonexistent target → [[null|Title]]; inline alias
 *      preserved; heading kept on the link side; same-note [[#Heading]] and a
 *      fenced-code wikilink left untouched.
 *   4. With obscuring ON: the rendered HTML `content` still contains a working
 *      UID anchor (proving HTML is built from the original path-form raw).
 *   5. With obscuring OFF: `raw` is the original path-form text and the content
 *      hash differs from the obscured run.
 *   6. No plugin errors captured during the run.
 *
 * Run: npx tsx e2e/scripts/test-obscure-wikilinks-e2e.ts
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { createTestNote } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants — fixture note names (vault-relative)
// ---------------------------------------------------------------------------

const SOURCE_NOTE = "Obscure-Source.md";
const TARGET_NOTE = "Obscure-Target.md";
const PROFILE_ID = "default";

// Frontmatter that opts a note into the `default` publish profile.
const PUBLISH_FM = `---\ncpn-publish-contexts:\n  - ${PROFILE_ID}\n---\n`;

// The source note exercises every branch of the scrubber in one body:
//   - published target with a real UID
//   - published target with an author-supplied inline alias
//   - published target with a heading
//   - a target that does not exist anywhere  → null sentinel
//   - a same-note section link               → untouched
//   - a wikilink inside fenced code          → untouched
const SOURCE_BODY = [
	"Link to [[Obscure-Target]] here.",
	"",
	"Aliased: [[Obscure-Target|the target note]].",
	"",
	"Heading: [[Obscure-Target#Details]].",
	"",
	"Ghost: [[No Such Note]].",
	"",
	"Same note: [[#Local Heading]].",
	"",
	"## Local Heading",
	"",
	"```",
	"code [[Obscure-Target]] stays literal",
	"```",
	"",
].join("\n");

const TARGET_BODY = "# Obscure Target\n\nSome target content.\n\n## Details\n\nDetail text.\n";

// ---------------------------------------------------------------------------
// In-runtime driver — queue a note under a given obscure flag and read back the
// NoteState (raw / content / hash) plus the target's minted UID. Runs entirely
// inside the Obsidian page so it touches the real metadataCache + managers.
// ---------------------------------------------------------------------------

interface QueueProbe {
	error?: string;
	raw?: string;
	content?: string;
	hash?: string;
	targetUid?: string | null;
}

// Screenshots are known to throw `__name is not defined` on some Obsidian/
// Electron builds (an Obsidian-internal issue, not a test problem). Capture
// best-effort so a screenshot failure never aborts the real assertions.
async function safeShot(ctx: TestContext, name: string): Promise<string | undefined> {
	try {
		return await ctx.screenshot(name);
	} catch (e: any) {
		console.log(`  (screenshot "${name}" skipped: ${e?.message ?? String(e)})`);
		return undefined;
	}
}

async function queueAndRead(
	ctx: TestContext,
	obscure: boolean,
): Promise<QueueProbe> {
	return ctx.page.evaluate(
		async ({ sourceName, targetName, profileId, obscure }) => {
			const app = (window as any).app;
			const plugin = app?.plugins?.plugins?.["commonplace-notes"];
			if (!plugin) return { error: "plugin not found" };

			const sourceFile = app.vault.getAbstractFileByPath(sourceName);
			const targetFile = app.vault.getAbstractFileByPath(targetName);
			if (!sourceFile) return { error: `source note not found: ${sourceName}` };
			if (!targetFile) return { error: `target note not found: ${targetName}` };

			// Set the per-profile flag for this run.
			const profile = plugin.settings.publishingProfiles.find(
				(p: any) => p.id === profileId,
			);
			if (!profile) return { error: `profile not found: ${profileId}` };
			profile.obscureRawWikilinks = obscure;

			try {
				await plugin.noteManager.queueNote(sourceFile, profileId);
			} catch (e: any) {
				return { error: `queueNote threw: ${e?.message ?? String(e)}` };
			}

			// Read the queued NoteState back out (key is `${profileId}:${uid}`).
			const sourceUid = plugin.frontmatterManager.getNoteUID(sourceFile);
			const state = plugin.noteManager.pendingNotes?.get(`${profileId}:${sourceUid}`);
			if (!state) return { error: "no NoteState queued for source note" };

			return {
				raw: state.raw as string,
				content: state.content as string,
				hash: state.currentHash as string,
				targetUid: plugin.frontmatterManager.getNoteUID(targetFile) as string | null,
			};
		},
		{ sourceName: SOURCE_NOTE, targetName: TARGET_NOTE, profileId: PROFILE_ID, obscure },
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testSettingDefault(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: obscureRawWikilinks setting is present and defaults on");
	const { page } = ctx;

	const probe = await page.evaluate(({ profileId }) => {
		const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];
		if (!plugin) return { error: "plugin not found" };
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === profileId);
		if (!profile) return { error: "profile not found" };
		return { value: profile.obscureRawWikilinks };
	}, { profileId: PROFILE_ID });

	if (probe.error) {
		ctx.fail("Setting present", probe.error);
		return;
	}
	if (probe.value !== true) {
		ctx.fail(
			"Setting defaults on",
			`expected obscureRawWikilinks === true after migration, got ${JSON.stringify(probe.value)}`,
		);
		return;
	}
	ctx.pass("Setting defaults on", "profile.obscureRawWikilinks === true");
}

// Captured across tests so the OFF run can compare hashes.
let obscuredProbe: QueueProbe | undefined;

async function testObscuredScrub(ctx: TestContext): Promise<void> {
	console.log("\nTest 2-4: obscuring ON rewrites raw, keeps HTML working");
	const probe = await queueAndRead(ctx, true);
	obscuredProbe = probe;

	if (probe.error) {
		ctx.fail("Obscured queueNote", probe.error);
		return;
	}

	const raw = probe.raw ?? "";
	const content = probe.content ?? "";
	const uid = probe.targetUid;
	const shot = await safeShot(ctx, "01-obscured-run");

	// 2a. The target must have a minted UID (uppercase Crockford, not 'null').
	if (!uid || uid === "null" || !/^[0-9A-Z]+$/.test(uid)) {
		ctx.fail("Target UID minted", `expected an uppercase UID, got ${JSON.stringify(uid)}`, shot);
		return;
	}
	ctx.pass("Target UID minted", `target cpn-uid = ${uid}`, shot);

	// 2b. Published target link rewritten to [[UID|Obscure-Target]].
	if (raw.includes(`[[${uid}|Obscure-Target]]`)) {
		ctx.pass("Published link → UID form", `raw contains [[${uid}|Obscure-Target]]`, shot);
	} else {
		ctx.fail("Published link → UID form", `raw missing [[${uid}|Obscure-Target]]\n--- raw ---\n${raw}`, shot);
	}

	// 2c. Author alias preserved, path swapped.
	if (raw.includes(`[[${uid}|the target note]]`)) {
		ctx.pass("Alias preserved", `raw contains [[${uid}|the target note]]`, shot);
	} else {
		ctx.fail("Alias preserved", `raw missing [[${uid}|the target note]]\n--- raw ---\n${raw}`, shot);
	}

	// 2d. Heading kept on link side, display = path.
	if (raw.includes(`[[${uid}#Details|Obscure-Target]]`)) {
		ctx.pass("Heading preserved on link side", `raw contains [[${uid}#Details|Obscure-Target]]`, shot);
	} else {
		ctx.fail("Heading preserved on link side", `raw missing [[${uid}#Details|Obscure-Target]]\n--- raw ---\n${raw}`, shot);
	}

	// 3a. Nonexistent target → null sentinel, original title kept.
	if (raw.includes("[[null|No Such Note]]")) {
		ctx.pass("Unresolved → null sentinel", "raw contains [[null|No Such Note]]", shot);
	} else {
		ctx.fail("Unresolved → null sentinel", `raw missing [[null|No Such Note]]\n--- raw ---\n${raw}`, shot);
	}

	// 3b. Same-note section link untouched.
	if (raw.includes("[[#Local Heading]]")) {
		ctx.pass("Same-note link untouched", "raw still contains [[#Local Heading]]", shot);
	} else {
		ctx.fail("Same-note link untouched", `raw no longer contains [[#Local Heading]]\n--- raw ---\n${raw}`, shot);
	}

	// 3c. Fenced-code wikilink untouched (still path-form inside the code block).
	if (raw.includes("code [[Obscure-Target]] stays literal")) {
		ctx.pass("Code-fence wikilink untouched", "raw preserves the literal [[Obscure-Target]] inside the code fence", shot);
	} else {
		ctx.fail("Code-fence wikilink untouched", `code-fence wikilink was rewritten\n--- raw ---\n${raw}`, shot);
	}

	// 4. HTML content still has a working UID anchor (built from original raw).
	if (content.includes(`#/u${uid}`) && content.includes("<a ")) {
		ctx.pass("HTML still resolves links", `content has an <a> with href #/u${uid}`, shot);
	} else {
		ctx.fail("HTML still resolves links", `content missing UID anchor for ${uid}\n--- content ---\n${content}`, shot);
	}
}

async function testUnobscuredAndHashDiff(ctx: TestContext): Promise<void> {
	console.log("\nTest 5: obscuring OFF leaves raw path-form and changes the hash");
	const probe = await queueAndRead(ctx, false);
	const shot = await safeShot(ctx, "02-unobscured-run");

	if (probe.error) {
		ctx.fail("Unobscured queueNote", probe.error, shot);
		return;
	}

	const raw = probe.raw ?? "";

	// 5a. Raw is the original path-form text — no UID/null link targets.
	const isPathForm =
		raw.includes("[[Obscure-Target]]") &&
		raw.includes("[[Obscure-Target|the target note]]") &&
		raw.includes("[[No Such Note]]") &&
		!raw.includes("[[null|");
	if (isPathForm) {
		ctx.pass("OFF → original path-form raw", "raw retains literal [[Obscure-Target]] / [[No Such Note]] and has no null sentinel", shot);
	} else {
		ctx.fail("OFF → original path-form raw", `raw was not left in original form\n--- raw ---\n${raw}`, shot);
	}

	// 5b. Hash differs from the obscured run (hash is computed over scrubbed raw).
	if (!obscuredProbe?.hash) {
		ctx.fail("Hash sensitive to scrub", "obscured-run hash was not captured (Test 2 likely failed)", shot);
		return;
	}
	if (obscuredProbe.hash !== probe.hash) {
		ctx.pass("Hash sensitive to scrub", `obscured hash ${obscuredProbe.hash.slice(0, 10)}… ≠ plain hash ${(probe.hash ?? "").slice(0, 10)}…`, shot);
	} else {
		ctx.fail("Hash sensitive to scrub", `hashes are identical (${probe.hash}) — scrub did not feed the hash`, shot);
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
	await testSettingDefault(ctx);
	await testObscuredScrub(ctx);
	await testUnobscuredAndHashDiff(ctx);
	await testNoErrors(ctx);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runTest(
	{
		name: "obscure-wikilinks-e2e",
		setupVault: (vaultPath) => {
			createTestNote(vaultPath, SOURCE_NOTE, PUBLISH_FM + SOURCE_BODY);
			createTestNote(vaultPath, TARGET_NOTE, PUBLISH_FM + TARGET_BODY);
		},
		// Notes pick up minted UIDs / queued frontmatter writes during the run;
		// remove them so the next run starts clean.
		cleanupFiles: [SOURCE_NOTE, TARGET_NOTE],
	},
	tests,
);
