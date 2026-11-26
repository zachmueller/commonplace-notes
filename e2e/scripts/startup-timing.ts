#!/usr/bin/env npx tsx
/**
 * Startup timing harness: launches Obsidian repeatedly on a synthetic vault and
 * reports how long each CPN startup step takes.
 *
 * Sources:
 *   - CPN's own marks (`plugin.startupTimings`, src/utils/startupTiming.ts).
 *     These cover top-level bundle eval, each onload step and each
 *     onLayoutReady step.
 *   - Obsidian's own per-plugin figure from Settings → About → "Check now"
 *     (best-effort). It also covers fetching and compiling main.js, which CPN's
 *     marks can't see.
 *
 * Vault: e2e/results/perf-vault (gitignored), reused across runs. Obsidian
 * keys plugin trust to the vault's ID, and the launcher keeps that ID only
 * while the path stays the same. For each profile count:
 *   - data.json is rewritten with N synthetic profiles. Profile 0 is
 *     "deployed" with comments enabled; nothing calls AWS because the Comments
 *     panel isn't open.
 *   - Profile folders are seeded the way publishing leaves them.
 *   - 300 notes are generated, a third of them with publish contexts.
 * Each profile count gets one warm-up launch (discarded). The warm-up trusts
 * the vault on first use, opens three notes so later launches restore real
 * tabs, and lets the OS file cache settle. Then come `--runs` measured
 * launches.
 *
 * Nothing outside e2e/results is touched. Uses its own Electron user-data dir
 * (e2e/results/perf-user-data).
 *
 * Output: a table per profile count on stdout, plus
 * e2e/results/perf/startup-latest.json.
 *
 * Run: npx tsx e2e/scripts/startup-timing.ts [--profiles 1,7,30] [--runs 5] [--skip-build] [--no-obsidian-modal]
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { launchObsidian, closeObsidian, type ObsidianProcess } from "../lib/obsidian-launcher";
import { CDP_PORT, PLUGIN_ID, PROJECT_ROOT, RESULTS_DIR, ensureAppConfig, findVaultPage } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
	const i = args.indexOf(`--${name}`);
	return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const PROFILE_COUNTS = getArg("profiles", "1,7,30")
	.split(",")
	.map((n) => parseInt(n, 10))
	.filter((n) => n > 0);
const RUNS = Math.max(1, parseInt(getArg("runs", "5"), 10) || 5);
const SKIP_BUILD = args.includes("--skip-build");
const OBSIDIAN_MODAL = !args.includes("--no-obsidian-modal");
const PORT = parseInt(getArg("port", String(CDP_PORT)), 10);

const VAULT = path.join(RESULTS_DIR, "perf-vault");
const USER_DATA = path.join(RESULTS_DIR, "perf-user-data");
const OUT_DIR = path.join(RESULTS_DIR, "perf");
const PLUGIN_DIR = path.join(VAULT, ".obsidian", "plugins", PLUGIN_ID);
const NOTE_COUNT = 300;
const OPEN_NOTES = 3;
/** Last mark CPN records; its presence means startup finished. */
const FINAL_MARK = "layout.edgeSweep";

// ---------------------------------------------------------------------------
// Vault fixtures
// ---------------------------------------------------------------------------

function profileId(i: number): string {
	return `perf-${i}`;
}

function syntheticProfile(i: number): Record<string, unknown> {
	const profile: Record<string, unknown> = {
		name: `Perf profile ${i}`,
		id: profileId(i),
		lastFullPublishTimestamp: 0,
		excludedDirectories: ["private/", "**/drafts/"],
		excludedDirsRulesVersion: 2,
		baseUrl: `https://perf-${i}.example.com/`,
		homeNotePath: "",
		isPublic: i % 2 === 0,
		publishContentIndex: true,
		obscureRawWikilinks: true,
		obscureRawAttachments: true,
		publishMechanism: "AWS",
		indicator: { style: "color", color: "#3366cc" },
		awsSettings: {
			awsAccountId: "123456789012",
			awsProfile: "perf",
			bucketName: `perf-bucket-${i}`,
			region: "us-east-1",
			cloudFrontInvalidationScheme: "individual",
			credentialMode: "sdk",
			credentialRefreshCommands: "",
			awsCliPath: "",
		},
	};
	if (i === 0) {
		profile.commenting = { enabled: true };
		profile.infrastructureState = {
			status: "deployed",
			useRoute53: false,
			originAccessMethod: "oac",
			region: "us-east-1",
			fullStackName: "perf-0-stack",
			comment: {
				stackName: "perf-0-comments",
				enabled: true,
				bucketName: "perf-0-comments",
				bucketDomainName: "perf-0-comments.s3.amazonaws.com",
				apiDomain: "comments.perf-0.example.com",
				tableName: "perf-0-comments",
			},
		};
	}
	return profile;
}

function writeDataJson(profiles: number): void {
	const data = {
		uidLength: 8,
		urlScheme: "current",
		urlStackWindowSeconds: 10,
		cpnDirectory: "cpn",
		commentsPanelMode: "recent",
		routingTitlePrompt: "only-if-Untitled",
		publishingProfiles: Array.from({ length: profiles }, (_, i) => syntheticProfile(i)),
		// The harness reads the marks over CDP; debugMode would add log noise.
		debugMode: false,
	};
	fs.writeFileSync(path.join(PLUGIN_DIR, "data.json"), JSON.stringify(data, null, 2));
}

/** Seed profile folders the way publishing leaves them. Idempotent. */
function seedProfileFolders(profiles: number): void {
	for (let i = 0; i < profiles; i++) {
		const dir = path.join(PLUGIN_DIR, "profiles", profileId(i));
		for (const sub of ["mapping", "staged-notes", "staged-error"]) {
			fs.mkdirSync(path.join(dir, sub), { recursive: true });
		}
		const history = path.join(dir, "publish-history.json");
		if (!fs.existsSync(history)) fs.writeFileSync(history, "{}");
		const mapping = path.join(dir, "mapping", "mappings.json");
		if (!fs.existsSync(mapping)) {
			const entries = Object.fromEntries(
				Array.from({ length: 100 }, (_, n) => [`note-${n}.md`, `UID${String(n).padStart(5, "0")}`]),
			);
			fs.writeFileSync(mapping, JSON.stringify(entries));
		}
	}
	fs.mkdirSync(path.join(PLUGIN_DIR, "templates"), { recursive: true });
}

function noteName(n: number): string {
	return `Perf note ${String(n).padStart(3, "0")}.md`;
}

function seedNotes(maxProfiles: number): void {
	for (let n = 0; n < NOTE_COUNT; n++) {
		const file = path.join(VAULT, noteName(n));
		if (fs.existsSync(file)) continue;
		const contexts = n % 3 === 0 ? [profileId(n % maxProfiles)] : [];
		const fm = contexts.length
			? `---\ncpn-uid: UID${String(n).padStart(5, "0")}\ncpn-publish-contexts:\n  - ${contexts[0]}\n---\n`
			: "";
		fs.writeFileSync(file, `${fm}# Perf note ${n}\n\nSee [[${noteName((n + 1) % NOTE_COUNT).replace(/\.md$/, "")}]].\n`);
	}
}

function prepareVault(): void {
	const obsidianDir = path.join(VAULT, ".obsidian");
	fs.mkdirSync(PLUGIN_DIR, { recursive: true });
	fs.writeFileSync(path.join(obsidianDir, "community-plugins.json"), JSON.stringify([PLUGIN_ID]));
	ensureAppConfig(VAULT);
	for (const file of ["main.js", "manifest.json", "styles.css"]) {
		const dest = path.join(PLUGIN_DIR, file);
		fs.rmSync(dest, { force: true });
		fs.symlinkSync(path.join(PROJECT_ROOT, file), dest);
	}
	seedNotes(Math.max(...PROFILE_COUNTS));
}

// ---------------------------------------------------------------------------
// One launch
// ---------------------------------------------------------------------------

interface CpnTimings {
	originIsEvalStart: boolean;
	marks: { label: string; at: number }[];
	steps: Record<string, number>;
}

interface ObsidianFigures {
	/** Obsidian's per-plugin figure: fetch + compile + eval + onload + CSS. */
	pluginMs?: number;
	/** Total app startup. */
	totalMs?: number;
	error?: string;
}

interface LaunchResult {
	cpn: CpnTimings;
	obsidian?: ObsidianFigures;
}

async function waitForTimings(page: Page, timeoutMs = 60_000): Promise<CpnTimings> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const t = await page
			.evaluate(({ id, finalMark }) => {
				const app = (window as any).app;
				// First launch of a new vault: trust it (the warm-up run is discarded).
				if (app?.plugins && !app.plugins.isEnabled()) void app.plugins.setEnable(true);
				const timings = app?.plugins?.plugins?.[id]?.startupTimings;
				return timings?.marks?.some((m: { label: string }) => m.label === finalMark) ? timings : null;
			}, { id: PLUGIN_ID, finalMark: FINAL_MARK })
			.catch(() => null);
		if (t) return t as CpnTimings;
		await page.waitForTimeout(250);
	}
	throw new Error(`CPN startup marks not complete after ${timeoutMs} ms`);
}

/**
 * Settings → About → "Check now": scrape Obsidian's startup breakdown.
 * Passed to the page as a string: tsx adds a `__name` helper to named inner
 * functions, and that helper doesn't exist in the page.
 */
const READ_OBSIDIAN_FIGURES = String.raw`(async (pluginName) => {
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const ms = (text) => {
		const n = parseFloat(String(text ?? "").replace(/[^0-9.]/g, ""));
		return Number.isFinite(n) ? n : undefined;
	};
	const app = window.app;
	try {
		app.setting.open();
		app.setting.openTabById("about");
		await sleep(500);
		const button = document.querySelector('.modal.mod-settings [aria-label="Check now"]');
		if (!button) return { error: 'no "Check now" button on the About tab' };
		button.click();
		await sleep(300);
		const modal = document.querySelector(".modal.mod-plugin-debug");
		if (!modal) return { error: "startup-time modal did not open" };
		for (let i = 0; i < 4; i++) {
			const collapsed = modal.querySelectorAll(".tree-item.is-collapsed > .tree-item-self");
			if (!collapsed.length) break;
			collapsed.forEach((el) => el.click());
			await sleep(100);
		}
		let pluginMs;
		for (const row of Array.from(modal.querySelectorAll(".tree-item-self"))) {
			if (row.querySelector(".startup-label")?.textContent === pluginName) {
				pluginMs = ms(row.querySelector(".tree-item-flair")?.textContent);
			}
		}
		let totalMs;
		for (const stat of Array.from(modal.querySelectorAll(".startup-stat"))) {
			if (/total/i.test(stat.textContent ?? "")) totalMs = ms(stat.querySelector(".startup-value")?.textContent);
		}
		return { pluginMs, totalMs };
	} catch (e) {
		return { error: String(e) };
	} finally {
		document.querySelectorAll(".modal.mod-plugin-debug .modal-close-button").forEach((b) => b.click());
		app.setting?.close?.();
	}
})`;

async function readObsidianFigures(page: Page): Promise<ObsidianFigures> {
	return (await page.evaluate(`${READ_OBSIDIAN_FIGURES}(${JSON.stringify("Commonplace Notes")})`)) as ObsidianFigures;
}

/** Warm-up only: open notes as tabs and save the layout, so measured runs restore them. */
async function openNotesForLayout(page: Page): Promise<void> {
	await page.evaluate(async ({ names }) => {
		const app = (window as any).app;
		for (const name of names) {
			const file = app.vault.getFileByPath(name);
			if (file) await app.workspace.getLeaf("tab").openFile(file);
		}
		await app.workspace.saveLayout();
	}, { names: Array.from({ length: OPEN_NOTES }, (_, n) => noteName(n * 3)) });
}

async function launchOnce(opts: { warmUp: boolean }): Promise<LaunchResult> {
	let obsidian: ObsidianProcess | undefined;
	let browser: Browser | undefined;
	try {
		obsidian = await launchObsidian({ vaultPath: VAULT, cdpPort: PORT, userDataDir: USER_DATA, timeout: 30_000 });
		browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
		const page = await findVaultPage(browser, 30_000);
		const cpn = await waitForTimings(page);
		if (opts.warmUp) {
			await openNotesForLayout(page);
			return { cpn };
		}
		const obsidianFigures = OBSIDIAN_MODAL ? await readObsidianFigures(page) : undefined;
		return { cpn, obsidian: obsidianFigures };
	} finally {
		if (browser) await browser.close().catch(() => {});
		if (obsidian) await closeObsidian(obsidian).catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Aggregation and output
// ---------------------------------------------------------------------------

interface Stat {
	median: number;
	p90: number;
	min: number;
	max: number;
}

function stat(values: number[]): Stat {
	const s = [...values].sort((a, b) => a - b);
	const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
	const mid = Math.floor(s.length / 2);
	const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
	const r = (n: number) => Math.round(n * 10) / 10;
	return { median: r(median), p90: r(at(0.9)), min: r(s[0]), max: r(s[s.length - 1]) };
}

/** onload's own steps: everything from `evaluate` through `registration`. */
const ONLOAD_STEPS = ["loadSettings", "managers", "events", "profileInit", "settingTab", "commands", "registration"];
// (profileInit: before item 2 moved profile-folder setup to onLayoutReady; absent now, counted as 0.)

interface ProfileCountReport {
	profiles: number;
	runs: number;
	steps: Record<string, Stat>;
	onloadMs: Stat;
	layoutReadyWorkMs: Stat;
	obsidianPluginMs?: Stat;
	obsidianTotalMs?: Stat;
	obsidianErrors: string[];
	raw: LaunchResult[];
}

function summarize(profiles: number, results: LaunchResult[]): ProfileCountReport {
	const labels = Object.keys(results[0].cpn.steps);
	const steps: Record<string, Stat> = {};
	for (const label of labels) steps[label] = stat(results.map((r) => r.cpn.steps[label] ?? 0));
	const sum = (r: LaunchResult, keys: string[]) => keys.reduce((a, k) => a + (r.cpn.steps[k] ?? 0), 0);
	const layoutKeys = labels.filter((l) => l.startsWith("layout."));
	const pluginMs = results.map((r) => r.obsidian?.pluginMs).filter((n): n is number => n !== undefined);
	const totalMs = results.map((r) => r.obsidian?.totalMs).filter((n): n is number => n !== undefined);
	return {
		profiles,
		runs: results.length,
		steps,
		onloadMs: stat(results.map((r) => sum(r, ONLOAD_STEPS))),
		layoutReadyWorkMs: stat(results.map((r) => sum(r, layoutKeys))),
		obsidianPluginMs: pluginMs.length ? stat(pluginMs) : undefined,
		obsidianTotalMs: totalMs.length ? stat(totalMs) : undefined,
		obsidianErrors: [...new Set(results.map((r) => r.obsidian?.error).filter((e): e is string => !!e))],
		raw: results,
	};
}

function printReport(r: ProfileCountReport): void {
	const row = (label: string, s: Stat) =>
		console.log(
			`  ${label.padEnd(30)}${String(s.median).padStart(9)}${String(s.p90).padStart(9)}${String(s.min).padStart(9)}${String(s.max).padStart(9)}`,
		);
	console.log(`\n${r.profiles} profile(s), ${r.runs} runs (ms)`);
	console.log(`  ${"step".padEnd(30)}${"median".padStart(9)}${"p90".padStart(9)}${"min".padStart(9)}${"max".padStart(9)}`);
	for (const [label, s] of Object.entries(r.steps)) row(label, s);
	row("= onload (after evaluate)", r.onloadMs);
	row("= layout-ready work", r.layoutReadyWorkMs);
	if (r.obsidianPluginMs) row("Obsidian: CPN plugin load", r.obsidianPluginMs);
	if (r.obsidianTotalMs) row("Obsidian: total app startup", r.obsidianTotalMs);
	for (const e of r.obsidianErrors) console.log(`  (Obsidian figures unavailable: ${e})`);
	if (!r.raw[0].cpn.originIsEvalStart) console.log("  (no bundle banner: `evaluate` is from plugin construction)");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	if (!SKIP_BUILD) {
		console.log("[setup] Building plugin (production)...");
		execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "inherit" });
	}
	prepareVault();
	fs.mkdirSync(OUT_DIR, { recursive: true });

	const reports: ProfileCountReport[] = [];
	for (const profiles of PROFILE_COUNTS) {
		seedProfileFolders(profiles);
		const results: LaunchResult[] = [];
		for (let run = 0; run <= RUNS; run++) {
			const warmUp = run === 0;
			writeDataJson(profiles);
			process.stdout.write(`[${profiles} profiles] ${warmUp ? "warm-up" : `run ${run}/${RUNS}`}... `);
			const result = await launchOnce({ warmUp });
			const total = result.cpn.marks[result.cpn.marks.length - 1]?.at ?? 0;
			console.log(`done (CPN marks span ${total.toFixed(0)} ms)`);
			if (!warmUp) results.push(result);
		}
		const report = summarize(profiles, results);
		reports.push(report);
		printReport(report);
	}

	const out = path.join(OUT_DIR, "startup-latest.json");
	fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), runs: RUNS, reports }, null, 2));
	console.log(`\nWritten to ${path.relative(PROJECT_ROOT, out)}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
