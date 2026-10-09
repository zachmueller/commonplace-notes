#!/usr/bin/env npx tsx
/**
 * UID Stability E2E Test
 *
 * Regression for notes ending up on the published site under two UIDs. Two
 * notes that link to each other, neither with a `cpn-uid`, are published
 * together through the real publisher.publishNotes() against a fake S3 client
 * (the AwsSdkManager client cache is the seam, as in test-publish-site-assets).
 * Before the fix, staging looked the just-minted note up again after its
 * frontmatter was written but before Obsidian re-indexed it, minted a second
 * UID, and published that one on the next run.
 *
 * NO real AWS calls.
 *
 * Scenarios:
 *   1. First publish: each note is minted exactly one UID, it is the UID on
 *      disk, the uploaded mappings/content index hold one UID per note, and
 *      each note's uploaded backlinks name the other note's on-disk UID.
 *   2. Second publish: no new UID is minted; still one UID per note.
 *   3. "Copy link to current note URL" on a never-published note mints nothing.
 *   4. A UID changed outside CPN leaves a stale UID: the audit flags it with
 *      its live twin, the delete picker lists it, and deleting it removes its
 *      revisions from S3 and it from the uploaded mappings and content index.
 *   5. No unexpected plugin errors logged.
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { createTestNote } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants
// ---------------------------------------------------------------------------

const PROFILE_ID = "public";
const NOTE_A = "UID Stability A.md";
const NOTE_B = "UID Stability B.md";
const NOTE_C = "UID Stability C.md";
const TITLE_A = "UID Stability A";
const TITLE_B = "UID Stability B";
const TITLE_C = "UID Stability C";
const SLUG_A = "UID-Stability-A";
const SLUG_B = "UID-Stability-B";
const PUBLISH_FM = `---\ncpn-publish-contexts:\n  - ${PROFILE_ID}\n---\n`;

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

interface Upload {
	kind: "put" | "delete" | "deleteMany";
	key: string;
	body?: string;
}

interface PublishResult {
	error: string | null;
	uidA: string | null;
	uidB: string | null;
	queued: boolean;
	slugToUid: Record<string, string> | null;
	uidToHash: Record<string, string> | null;
	contentIndex: Record<string, { title?: string }> | null;
	notes: Array<{ uid: string; title: string; backlinks: Array<{ uid: string; title: string }> }>;
}

/** Messages of every "Queuing ... add UID ... to <title>" debug log so far. */
function mintLogs(ctx: TestContext, title: string): string[] {
	return ctx.collector
		.getStructuredLogs()
		.map((e) => e.message)
		.filter((m) => m.includes("Queuing frontmatter update to add UID") && m.endsWith(` to ${title}`));
}

/** Install the fake S3 client and seed the profile (once per run). */
async function installFakeS3(ctx: TestContext): Promise<string> {
	return ctx.page.evaluate(async ({ profileId }) => {
		const w = window as any;
		const plugin = w.app.plugins.plugins["commonplace-notes"];
		w.__cpnUidSettings = JSON.stringify(plugin.settings);
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === profileId);
		if (!profile) return "no profile";
		profile.publishMechanism = "AWS";
		profile.publishContentIndex = true;
		profile.awsSettings = {
			...(profile.awsSettings || {}),
			awsProfile: "cpn-uid-test",
			region: "us-east-1",
			bucketName: "uid-stability-bucket",
			s3Prefix: "",
			cloudFrontDistributionId: "",
		};
		delete profile.chat;
		w.__cpnUidUploads = [] as any[];
		plugin.awsSdkManager.s3Clients.set(profile.id, {
			// The bundle is minified, so tell commands apart by their input shape.
			send: async (cmd: any) => {
				const input = cmd?.input ?? {};
				if (input.Delete?.Objects) {
					for (const o of input.Delete.Objects) w.__cpnUidUploads.push({ kind: "deleteMany", key: o.Key });
				} else if (input.Key && "Body" in input) {
					w.__cpnUidUploads.push({
						kind: "put",
						key: input.Key,
						body: typeof input.Body === "string" ? input.Body : undefined,
					});
				} else if (input.Key) {
					w.__cpnUidUploads.push({ kind: "delete", key: input.Key });
				}
				return {};
			},
			destroy: () => {},
		});

		// Drop ledger entries left by earlier runs of this test, so counts
		// below only see this run.
		await plugin.mappingManager.loadProfileMappings(profile.id);
		const index = await plugin.contentIndexManager.loadIndex(profile.id);
		const stale = new Set<string>();
		for (const [uid, entry] of Object.entries(index as Record<string, any>)) {
			if (String(entry?.title ?? "").startsWith("UID Stability")) stale.add(uid);
		}
		for (const [slug, uid] of Object.entries(plugin.mappingManager.getSlugToUidMap(profile.id) as Record<string, string>)) {
			if (slug.startsWith("UID-Stability")) stale.add(uid);
		}
		for (const uid of stale) {
			plugin.mappingManager.removeUidFromMappings(profile.id, uid);
			await plugin.contentIndexManager.removeEntry(profile.id, uid);
		}
		await plugin.mappingManager.saveMappings();
		return "ok";
	}, { profileId: PROFILE_ID });
}

/** Publish the given notes and read back disk UIDs plus what was uploaded. */
async function publish(ctx: TestContext, paths: string[]): Promise<PublishResult> {
	return ctx.page.evaluate(async ({ profileId, paths, noteA, noteB }) => {
		const w = window as any;
		const plugin = w.app.plugins.plugins["commonplace-notes"];
		const app = w.app;
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === profileId);
		const start = w.__cpnUidUploads.length;
		let error: string | null = null;
		try {
			const files = paths.map((p: string) => app.vault.getAbstractFileByPath(p));
			if (files.some((f: any) => !f)) throw new Error("fixture note missing");
			await plugin.publisher.publishNotes(files, profile, false, false);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		const diskUid = async (p: string) => {
			const text: string = await app.vault.adapter.read(p);
			const m = text.match(/^cpn-uid:\s*["']?([^"'\s]+)["']?\s*$/m);
			return m ? m[1] : null;
		};
		const uploads = w.__cpnUidUploads.slice(start) as any[];
		const lastJson = (key: string) => {
			const put = uploads.filter((u) => u.kind === "put" && u.key === key && u.body).pop();
			return put ? JSON.parse(put.body) : null;
		};
		const notes = uploads
			.filter((u) => u.kind === "put" && /^notes\/[0-9a-f]+\.json$/.test(u.key) && u.body)
			.map((u) => JSON.parse(u.body))
			.map((n) => ({ uid: n.uid, title: n.title, backlinks: (n.backlinks || []).map((b: any) => ({ uid: b.uid, title: b.title })) }));
		return {
			error,
			uidA: await diskUid(noteA),
			uidB: await diskUid(noteB),
			queued: plugin.frontmatterManager.hasUpdates(),
			slugToUid: lastJson("static/mapping/slug-to-uid.json"),
			uidToHash: lastJson("static/mapping/uid-to-hash.json"),
			contentIndex: lastJson("static/content/contentIndex.json"),
			notes,
		};
	}, { profileId: PROFILE_ID, paths, noteA: NOTE_A, noteB: NOTE_B });
}

function uidsTitled(index: Record<string, { title?: string }> | null, title: string): string[] {
	return Object.entries(index ?? {}).filter(([, e]) => e?.title === title).map(([uid]) => uid);
}

/** Shared checks after a publish of A and B. Returns false if any failed. */
function checkOneUidPerNote(ctx: TestContext, label: string, r: PublishResult): boolean {
	let ok = true;
	if (r.error || !r.uidA || !r.uidB) {
		ctx.fail(`${label}: publish`, `error=${r.error}, uidA=${r.uidA}, uidB=${r.uidB}`);
		return false;
	}
	const slugOk = r.slugToUid?.[SLUG_A] === r.uidA && r.slugToUid?.[SLUG_B] === r.uidB;
	const hashOk = !!r.uidToHash?.[r.uidA] && !!r.uidToHash?.[r.uidB];
	if (slugOk && hashOk) {
		ctx.pass(`${label}: mappings use the on-disk UIDs`, `A=${r.uidA}, B=${r.uidB}`);
	} else {
		ok = false;
		ctx.fail(`${label}: mappings use the on-disk UIDs`,
			`A=${r.uidA}, B=${r.uidB}, slug-to-uid A=${r.slugToUid?.[SLUG_A]} B=${r.slugToUid?.[SLUG_B]}, uid-to-hash has A=${hashOk}`);
	}
	const indexA = uidsTitled(r.contentIndex, TITLE_A);
	const indexB = uidsTitled(r.contentIndex, TITLE_B);
	if (indexA.length === 1 && indexA[0] === r.uidA && indexB.length === 1 && indexB[0] === r.uidB) {
		ctx.pass(`${label}: one content-index entry per note`, `A=[${indexA}], B=[${indexB}]`);
	} else {
		ok = false;
		ctx.fail(`${label}: one content-index entry per note`, `A=[${indexA}], B=[${indexB}]`);
	}
	const jsonA = r.notes.find((n) => n.title === TITLE_A);
	const jsonB = r.notes.find((n) => n.title === TITLE_B);
	const backlinkToB = jsonA?.backlinks.find((b) => b.title === TITLE_B)?.uid;
	const backlinkToA = jsonB?.backlinks.find((b) => b.title === TITLE_A)?.uid;
	if (jsonA?.uid === r.uidA && jsonB?.uid === r.uidB && backlinkToB === r.uidB && backlinkToA === r.uidA) {
		ctx.pass(`${label}: uploaded notes and backlinks use the on-disk UIDs`, `A backlinks B=${backlinkToB}, B backlinks A=${backlinkToA}`);
	} else {
		ok = false;
		ctx.fail(`${label}: uploaded notes and backlinks use the on-disk UIDs`,
			`A json uid=${jsonA?.uid} backlink B=${backlinkToB}; B json uid=${jsonB?.uid} backlink A=${backlinkToA}`);
	}
	if (r.queued) {
		ok = false;
		ctx.fail(`${label}: frontmatter queue empty`, "edits still queued after the publish");
	} else {
		ctx.pass(`${label}: frontmatter queue empty`, "nothing left queued");
	}
	return ok;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let firstA: string | null = null;
let firstB: string | null = null;

async function testFirstPublish(ctx: TestContext): Promise<void> {
	console.log("\nTest 1: first publish of two linked notes without UIDs");
	const r = await publish(ctx, [NOTE_A, NOTE_B]);
	await ctx.page.waitForTimeout(1_500); // let the metadata cache re-index
	const mintsA = mintLogs(ctx, TITLE_A);
	const mintsB = mintLogs(ctx, TITLE_B);
	if (mintsA.length === 1 && mintsB.length === 1) {
		ctx.pass("First publish: one UID minted per note", `${mintsA[0]} | ${mintsB[0]}`);
	} else {
		ctx.fail("First publish: one UID minted per note", `A mints=${JSON.stringify(mintsA)}, B mints=${JSON.stringify(mintsB)}`);
	}
	checkOneUidPerNote(ctx, "First publish", r);
	firstA = r.uidA;
	firstB = r.uidB;
}

async function testSecondPublish(ctx: TestContext): Promise<void> {
	console.log("\nTest 2: publishing again keeps the same UIDs");
	const before = mintLogs(ctx, TITLE_A).length + mintLogs(ctx, TITLE_B).length;
	const r = await publish(ctx, [NOTE_A, NOTE_B]);
	const after = mintLogs(ctx, TITLE_A).length + mintLogs(ctx, TITLE_B).length;
	if (after === before && r.uidA === firstA && r.uidB === firstB) {
		ctx.pass("Second publish: no new UID", `A=${r.uidA}, B=${r.uidB}`);
	} else {
		ctx.fail("Second publish: no new UID", `mints ${before}->${after}; A ${firstA}->${r.uidA}; B ${firstB}->${r.uidB}`);
	}
	checkOneUidPerNote(ctx, "Second publish", r);
}

async function testCopyUrlDoesNotMint(ctx: TestContext): Promise<void> {
	console.log("\nTest 3: copying a never-published note's URL mints nothing");
	const res = await ctx.page.evaluate(async ({ noteC }) => {
		const w = window as any;
		const app = w.app;
		const plugin = app.plugins.plugins["commonplace-notes"];
		const file = app.vault.getAbstractFileByPath(noteC);
		if (!file) return { error: "fixture note missing" };
		await app.workspace.getLeaf(true).openFile(file);
		await new Promise((r) => setTimeout(r, 300));
		app.commands.executeCommandById("commonplace-notes:copy-active-note-published-url");
		await new Promise((r) => setTimeout(r, 1_000));
		const text: string = await app.vault.adapter.read(noteC);
		return { error: null, hasUid: /^cpn-uid:/m.test(text), queued: plugin.frontmatterManager.hasUpdates() };
	}, { noteC: NOTE_C });
	const mints = mintLogs(ctx, TITLE_C);
	if (!res.error && !res.hasUid && !res.queued && mints.length === 0) {
		ctx.pass("Copy URL: no UID minted", "note unchanged, nothing queued");
	} else {
		ctx.fail("Copy URL: no UID minted", `error=${res.error}, hasUid=${res.hasUid}, queued=${res.queued}, mints=${mints.length}`);
	}
}

async function testAuditAndDeleteStaleUid(ctx: TestContext): Promise<void> {
	console.log("\nTest 4: a stale UID is found by the audit and can be deleted");
	const staleUid = firstB;
	if (!staleUid) {
		ctx.fail("Stale UID setup", "no UID from the first publish");
		return;
	}

	// Simulate a UID changed outside CPN (sync conflict, hand edit), then publish
	// B: the site now has B under both UIDs, the reported soft failure.
	const freshUid = await ctx.page.evaluate(async ({ noteB }) => {
		const app = (window as any).app;
		const file = app.vault.getAbstractFileByPath(noteB);
		const uid = "ZZ" + Math.random().toString(36).slice(2, 8).toUpperCase().replace(/[ILOU]/g, "X");
		await app.fileManager.processFrontMatter(file, (fm: any) => { fm["cpn-uid"] = uid; });
		await new Promise((r) => setTimeout(r, 1_500));
		return uid;
	}, { noteB: NOTE_B });
	const r = await publish(ctx, [NOTE_B]);
	const titledB = uidsTitled(r.contentIndex, TITLE_B).sort();
	if (r.error || r.uidB !== freshUid || titledB.length !== 2 || !titledB.includes(staleUid)) {
		ctx.fail("Stale UID setup", `error=${r.error}, disk B=${r.uidB} (wanted ${freshUid}), B entries=[${titledB}]`);
		return;
	}
	ctx.pass("Stale UID setup", `B published as ${freshUid}; stale ${staleUid} still live`);

	// Audit flags the stale UID and names the live twin.
	const audit = await ctx.page.evaluate(async ({ profileId }) => {
		const plugin = (window as any).app.plugins.plugins["commonplace-notes"];
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === profileId);
		const report = await plugin.publisher.auditUids(profile);
		return report.orphans.map((o: any) => ({ uid: o.uid, twins: o.twins }));
	}, { profileId: PROFILE_ID });
	const flagged = audit.find((o) => o.uid === staleUid);
	if (flagged && flagged.twins.includes(freshUid)) {
		ctx.pass("Audit flags the stale UID", `${staleUid} -> twin ${flagged.twins.join(", ")}`);
	} else {
		ctx.fail("Audit flags the stale UID", JSON.stringify(audit));
	}

	// The delete picker (flagged-only, as opened by the audit command) lists it.
	await ctx.page.evaluate(({ profileId }) => {
		const plugin = (window as any).app.plugins.plugins["commonplace-notes"];
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === profileId);
		void plugin.publisher.deletePublishedNote(profile, true);
	}, { profileId: PROFILE_ID });
	await ctx.page.waitForSelector(".prompt .suggestion-item", { timeout: 5_000 }).catch(() => null);
	const items: string[] = await ctx.page.$$eval(".prompt .suggestion-item",
		(els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s*\n\s*/g, " / ")));
	const shot = await ctx.screenshot("delete-picker-stale-uid").catch(() => undefined);
	await ctx.page.keyboard.press("Escape");
	if (items.some((t) => t.includes(staleUid) && t.includes("no vault note"))) {
		ctx.pass("Delete picker lists the stale UID", items.join(" | "), shot);
	} else {
		ctx.fail("Delete picker lists the stale UID", `items=${JSON.stringify(items)}`, shot);
	}

	// Delete it through the same steps the picker runs after confirmation.
	const del = await ctx.page.evaluate(async ({ profileId, staleUid }) => {
		const w = window as any;
		const plugin = w.app.plugins.plugins["commonplace-notes"];
		const profile = plugin.settings.publishingProfiles.find((p: any) => p.id === profileId);
		const history = await plugin.noteManager.loadPublishHistory(profile.id);
		const staleHashes: string[] = history[staleUid] || [];
		const start = w.__cpnUidUploads.length;
		const ok = await plugin.publisher.deletePublishedUid(profile, staleUid, "UID Stability B");
		const uploads = w.__cpnUidUploads.slice(start) as any[];
		const deleted = uploads.filter((u) => u.kind !== "put").map((u) => u.key);
		const lastJson = (key: string) => {
			const put = uploads.filter((u) => u.kind === "put" && u.key === key && u.body).pop();
			return put ? JSON.parse(put.body) : null;
		};
		return {
			ok,
			staleHashes,
			deleted,
			slugToUid: lastJson("static/mapping/slug-to-uid.json"),
			uidToHash: lastJson("static/mapping/uid-to-hash.json"),
			contentIndex: lastJson("static/content/contentIndex.json"),
		};
	}, { profileId: PROFILE_ID, staleUid });

	const revisionsGone = del.staleHashes.length > 0
		&& del.staleHashes.every((h) => del.deleted.includes(`notes/${h}.json`));
	if (del.ok && revisionsGone) {
		ctx.pass("Delete removes the stale revisions from S3", `${del.staleHashes.length} revision(s)`);
	} else {
		ctx.fail("Delete removes the stale revisions from S3", `ok=${del.ok}, hashes=${JSON.stringify(del.staleHashes)}, deleted=${JSON.stringify(del.deleted)}`);
	}
	const remaining = uidsTitled(del.contentIndex, TITLE_B);
	if (!del.uidToHash?.[staleUid] && del.uidToHash?.[freshUid]
		&& remaining.length === 1 && remaining[0] === freshUid
		&& del.slugToUid?.[SLUG_B] === freshUid) {
		ctx.pass("Delete leaves only the live UID in the uploaded ledger", `B=${freshUid}`);
	} else {
		ctx.fail("Delete leaves only the live UID in the uploaded ledger",
			`uid-to-hash stale=${!!del.uidToHash?.[staleUid]} fresh=${!!del.uidToHash?.[freshUid]}, index B=[${remaining}], slug B=${del.slugToUid?.[SLUG_B]}`);
	}
}

async function testNoPluginErrors(ctx: TestContext, baseline: number): Promise<void> {
	console.log("\nTest 5: no plugin errors logged");
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
	// tsx (esbuild keepNames) wraps the named helpers inside the evaluate
	// callbacks below in __name(...), which the page doesn't define. A string
	// evaluate isn't transformed, so install a pass-through shim with one.
	await page.evaluate("window.__name = window.__name || ((fn) => fn)");
	const baseline = ctx.collector.getLogsByLevel("error").filter((e) => e.source === "plugin").length;

	const ready = await installFakeS3(ctx);
	if (ready !== "ok") {
		ctx.fail("Seed profile", ready);
		return;
	}

	try {
		await testFirstPublish(ctx);
		await testSecondPublish(ctx);
		await testCopyUrlDoesNotMint(ctx);
		await testAuditAndDeleteStaleUid(ctx);
	} finally {
		await page.evaluate(async ({ profileId }) => {
			const w = window as any;
			const plugin = w.app.plugins.plugins["commonplace-notes"];
			// Remove this run's ledger entries, then restore settings.
			await plugin.mappingManager.loadProfileMappings(profileId);
			const index = await plugin.contentIndexManager.loadIndex(profileId);
			for (const [uid, entry] of Object.entries(index as Record<string, any>)) {
				if (String(entry?.title ?? "").startsWith("UID Stability")) {
					plugin.mappingManager.removeUidFromMappings(profileId, uid);
					await plugin.contentIndexManager.removeEntry(profileId, uid);
				}
			}
			await plugin.mappingManager.saveMappings();
			plugin.awsSdkManager.s3Clients.clear();
			const settings = plugin.settings;
			for (const key of Object.keys(settings)) delete settings[key];
			Object.assign(settings, JSON.parse(w.__cpnUidSettings));
			await plugin.saveSettings();
		}, { profileId: PROFILE_ID });
	}
	await testNoPluginErrors(ctx, baseline);
}

runTest(
	{
		name: "uid-stability",
		setupVault: (vaultPath) => {
			createTestNote(vaultPath, NOTE_A, `${PUBLISH_FM}# A\n\nSee [[${TITLE_B}]].\n`);
			createTestNote(vaultPath, NOTE_B, `${PUBLISH_FM}# B\n\nSee [[${TITLE_A}]].\n`);
			createTestNote(vaultPath, NOTE_C, `${PUBLISH_FM}# C\n\nNever published.\n`);
		},
		// Notes pick up minted UIDs during the run; remove them so the next run
		// starts clean.
		cleanupFiles: [NOTE_A, NOTE_B, NOTE_C],
	},
	tests,
);
