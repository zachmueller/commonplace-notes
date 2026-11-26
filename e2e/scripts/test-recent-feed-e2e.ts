#!/usr/bin/env npx tsx
/**
 * Recent-comments feed note resolution (startup item 4d) E2E test.
 *
 * buildRecentFeed resolves each note's local file from one vault pass
 * (buildUidToFileMap) instead of a full scan per note.
 *
 * Setup (before launch):
 *   - A temporary commenting profile `e2e-feed` (restored at the end).
 *   - Three notes with cpn-uids.
 * The panel's DynamoDB client is a fake returning chosen items, and each
 * note's thread is pre-cached, so nothing calls AWS or the CDN.
 *
 * Scenarios:
 *   1. A refresh resolves every note in the feed to its local file,
 *      including a comment whose noteUid is lower-case (UIDs are normalized).
 *   2. A refresh with three notes scans the vault as often as one with a
 *      single note: the per-note scans are gone.
 *
 * Run: npx tsx e2e/scripts/test-recent-feed-e2e.ts
 */

import * as fs from "fs";
import * as path from "path";
import { runTest, type TestContext } from "../lib/test-harness";
import { createTestNote, PLUGIN_ID, RESULTS_DIR, VAULT_PATH } from "../lib/test-helpers";

const PROFILE_ID = "e2e-feed";
const DATA_JSON = path.join(VAULT_PATH, ".obsidian", "plugins", PLUGIN_ID, "data.json");
const DATA_BACKUP = path.join(RESULTS_DIR, "recent-feed-e2e.data.json.bak");
const NOTES: Record<string, string> = {
	"E2E-Feed-A.md": "E2EFEEDA",
	"E2E-Feed-B.md": "E2EFEEDB",
	"E2E-Feed-C.md": "E2EFEEDC",
};

function setupVault(vaultPath: string): void {
	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	const original = fs.readFileSync(DATA_JSON, "utf8");
	fs.writeFileSync(DATA_BACKUP, original);
	const data = JSON.parse(original);
	const base = data.publishingProfiles[0];
	data.publishingProfiles = data.publishingProfiles.filter((p: any) => p.id !== PROFILE_ID);
	data.publishingProfiles.unshift({
		...base,
		id: PROFILE_ID,
		name: "E2E Feed",
		commenting: { enabled: true },
		commentsLastRefreshed: Date.now(), // fresh: opening the panel doesn't auto-refresh
		cognitoAuth: undefined,
		infrastructureState: {
			status: "deployed",
			useRoute53: false,
			originAccessMethod: "oac",
			comment: {
				stackName: "e2e-feed-comments",
				enabled: true,
				bucketName: "e2e-feed-comments",
				bucketDomainName: "e2e-feed-comments.example.com",
				apiDomain: "comments.e2e-feed.example.com",
				tableName: "e2e-feed-comments",
			},
		},
	});
	data.commentsPanelMode = "recent";
	fs.writeFileSync(DATA_JSON, JSON.stringify(data, null, 2));
	for (const [note, uid] of Object.entries(NOTES)) createTestNote(vaultPath, note, `---\ncpn-uid: ${uid}\n---\n# ${note}\n`);
}

async function restoreSettings(ctx: TestContext): Promise<void> {
	const original = fs.readFileSync(DATA_BACKUP, "utf8");
	await ctx.page.evaluate(async ({ pluginId, original }) => {
		const app = (window as any).app;
		app.workspace.detachLeavesOfType("cpn-recent-comments");
		const plugin = app?.plugins?.plugins?.[pluginId];
		if (!plugin) return;
		plugin.settings = JSON.parse(original);
		await plugin.saveSettings();
	}, { pluginId: PLUGIN_ID, original });
	fs.writeFileSync(DATA_JSON, original);
}

/** Fake the DynamoDB client and thread cache, then open the panel. */
async function preparePanel(ctx: TestContext): Promise<void> {
	await ctx.page.evaluate(async ({ id, profileId, uids }) => {
		const w = window as any;
		const plugin = w.app.plugins.plugins[id];
		w.__cpnFeedItems = [];
		plugin.awsSdkManager.ddbClients.set(profileId, {
			send: async () => ({ Items: w.__cpnFeedItems }),
			destroy: () => {},
		});
		for (const uid of uids) {
			for (const key of [uid, uid.toLowerCase()]) {
				plugin.commentThreadCache.set(`${profileId}::${key}`, { items: [], fetchedAt: Date.now() });
			}
		}
		await plugin.activateRecentCommentsView();
	}, { id: PLUGIN_ID, profileId: PROFILE_ID, uids: Object.values(NOTES) });
	await ctx.page.waitForTimeout(500);
}

/** Refresh the panel with comments on `noteUids`; count vault scans during it. */
async function refreshWith(ctx: TestContext, noteUids: string[]) {
	return ctx.page.evaluate(async (noteUids) => {
		const w = window as any;
		const app = w.app;
		w.__cpnFeedItems = noteUids.map((noteUid: string, i: number) => ({
			commentUid: `c${i}`, noteUid, body: `comment ${i}`, createdAt: 1_800_000_000 - i, status: "active",
		}));
		const view = app.workspace.getLeavesOfType("cpn-recent-comments")[0]?.view;
		const vault = app.vault;
		const original = vault.getMarkdownFiles;
		let scans = 0;
		vault.getMarkdownFiles = function (...a: unknown[]) { scans++; return original.apply(this, a); };
		try {
			await view.refresh();
		} finally {
			vault.getMarkdownFiles = original;
		}
		const groups = (view.feed?.groups ?? []) as { noteUid: string; localPath?: string }[];
		return { scans, resolved: Object.fromEntries(groups.map((g) => [g.noteUid, g.localPath ?? null])) };
	}, noteUids);
}

async function tests(ctx: TestContext): Promise<void> {
	await ctx.page.waitForTimeout(6_500); // startup fully settled (delayed comments refresh)
	try {
		await preparePanel(ctx);
		const uids = Object.values(NOTES);
		const many = await refreshWith(ctx, [uids[0], uids[1].toLowerCase(), uids[2]]);
		const expected: Record<string, string> = {
			[uids[0]]: "E2E-Feed-A.md",
			[uids[1].toLowerCase()]: "E2E-Feed-B.md",
			[uids[2]]: "E2E-Feed-C.md",
		};
		if (JSON.stringify(many.resolved) === JSON.stringify(expected)) ctx.pass("feed resolves every note", JSON.stringify(many.resolved));
		else ctx.fail("feed resolves every note", JSON.stringify(many.resolved));

		const one = await refreshWith(ctx, [uids[0]]);
		if (many.scans === one.scans) ctx.pass("vault scans don't grow with notes in the feed", `1 note: ${one.scans}, 3 notes: ${many.scans}`);
		else ctx.fail("vault scans don't grow with notes in the feed", `1 note: ${one.scans}, 3 notes: ${many.scans}`);
	} finally {
		await restoreSettings(ctx);
	}
}

runTest({ name: "recent-feed-e2e", setupVault, cleanupFiles: Object.keys(NOTES) }, tests);
