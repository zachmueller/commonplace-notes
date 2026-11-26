#!/usr/bin/env npx tsx
/**
 * Bundle load-cost benchmark: how long main.js takes to compile and to run its
 * top-level code (everything before the plugin's onload), and which package
 * groups that time comes from.
 *
 * Builds the production bundle in memory with the real options
 * (esbuild.options.mjs), plus variants with a package group left external and
 * stubbed out. Each variant is timed in fresh Node processes so V8's in-process
 * compile cache doesn't flatter repeat runs. `obsidian` and the other runtime
 * externals are stubbed. Node's V8 is close to, but not the same as, Obsidian's
 * Electron renderer, so treat the numbers as relative.
 *
 * It also reports which AWS SDK modules the bundle evaluates at load: the
 * `aws-external` variant records every @aws-sdk / @smithy require made while
 * the top-level code runs. `--assert-no-aws-at-load` exits 1 if there are any.
 *
 * `--aws-probe-only` builds and runs just that probe once. With
 * `--assert-no-aws-at-load`, that's `npm run test:aws-lazy`.
 *
 * Output: a table on stdout and e2e/results/perf/bundle-eval-latest.json.
 *
 * Run: npx tsx e2e/scripts/bundle-eval-timing.ts [--runs 5] [--assert-no-aws-at-load] [--aws-probe-only]
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
// @ts-expect-error — plain .mjs module without type declarations.
import { bundleOptions } from "../../esbuild.options.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const RESULTS_DIR = path.join(PROJECT_ROOT, "e2e", "results", "perf");

const args = process.argv.slice(2);
const runsArg = args.indexOf("--runs");
const PROBE_ONLY = args.includes("--aws-probe-only");
const RUNS = PROBE_ONLY ? 1 : runsArg !== -1 ? Math.max(1, parseInt(args[runsArg + 1], 10) || 5) : 5;
const ASSERT_NO_AWS = args.includes("--assert-no-aws-at-load");

/** Package groups that can be left out of a variant. */
const GROUPS: Record<string, string[]> = {
	aws: ["@aws-sdk/", "@smithy/", "@aws-crypto/"],
	math: ["mathjax-full", "rehype-mathjax", "katex", "rehype-katex", "mhchemparser"],
	sucrase: ["sucrase"],
};
const AWS_PREFIXES = GROUPS.aws;

interface Variant {
	name: string;
	description: string;
	/** Module prefixes left external (and stubbed at runtime). */
	external: string[];
}

const VARIANTS: Variant[] = [
	{ name: "full", description: "the shipped bundle", external: [] },
	{ name: "aws-external", description: "AWS SDK stubbed (also the AWS-at-load probe)", external: GROUPS.aws },
	{ name: "math-external", description: "mathjax/katex stubbed", external: GROUPS.math },
	{ name: "sucrase-external", description: "sucrase stubbed", external: GROUPS.sucrase },
	{
		name: "all-external",
		description: "AWS SDK, math and sucrase stubbed",
		external: [...GROUPS.aws, ...GROUPS.math, ...GROUPS.sucrase],
	},
];

/**
 * Runs in a fresh `node` process: compile + evaluate the bundle once with the
 * runtime externals stubbed, then print one JSON line. argv: file, stub prefixes
 * (JSON).
 */
const RUNNER = String.raw`
const fs = require("fs"), vm = require("vm"), Module = require("module");
const [file, stubJson] = process.argv.slice(1);
const stubPrefixes = JSON.parse(stubJson);
const stub = new Proxy(function () {}, {
	get: (t, k) => (k === "__esModule" ? false : stub),
	construct: () => stub,
	apply: () => stub,
});
class Base {}
const obsidian = new Proxy({}, { get: (t, k) => (typeof k === "string" && /^[A-Z]/.test(k) ? Base : stub) });
const runtimeExternal = (r) => r === "obsidian" || r === "electron" || r.startsWith("@codemirror/") || r.startsWith("@lezer/");
const stubbedRequires = new Set();
const load = Module._load;
Module._load = function (request, ...rest) {
	if (runtimeExternal(request)) return obsidian;
	if (stubPrefixes.some((p) => request.startsWith(p))) { stubbedRequires.add(request); return stub; }
	return load.call(this, request, ...rest);
};
globalThis.window = globalThis;
globalThis.document = stub;
const source = fs.readFileSync(file, "utf8");
const wrapped = "(function (exports, require, module) {" + source + "\n})";
const t0 = performance.now();
const script = new vm.Script(wrapped, { filename: "main.js" });
const t1 = performance.now();
const fn = script.runInThisContext();
const mod = { exports: {} };
let error = null;
const t2 = performance.now();
try { fn(mod.exports, require, mod); } catch (e) { error = String(e && e.message || e).slice(0, 200); }
const t3 = performance.now();
process.stdout.write(JSON.stringify({ compileMs: t1 - t0, evalMs: t3 - t2, error, stubbedRequires: [...stubbedRequires].sort() }));
`;

interface RunResult {
	compileMs: number;
	evalMs: number;
	error: string | null;
	stubbedRequires: string[];
}

interface VariantResult {
	name: string;
	description: string;
	bytes: number;
	compileMs: { median: number; min: number; max: number };
	evalMs: { median: number; min: number; max: number };
	error: string | null;
	stubbedRequires: string[];
}

function stats(values: number[]): { median: number; min: number; max: number } {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	const r = (n: number) => Math.round(n * 10) / 10;
	return { median: r(median), min: r(sorted[0]), max: r(sorted[sorted.length - 1]) };
}

async function buildVariant(variant: Variant): Promise<string> {
	const base = bundleOptions(true) as esbuild.BuildOptions;
	const result = await esbuild.build({
		...base,
		absWorkingDir: PROJECT_ROOT,
		write: false,
		logLevel: "silent",
		// Prefix wildcards: "@aws-sdk/*", "mathjax-full*" (also matches deep imports).
		external: [...(base.external ?? []), ...variant.external.map((p) => `${p}*`)],
	});
	return result.outputFiles[0].text;
}

async function main(): Promise<void> {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cpn-bundle-timing-"));
	const results: VariantResult[] = [];
	try {
		for (const variant of PROBE_ONLY ? VARIANTS.filter((v) => v.name === "aws-external") : VARIANTS) {
			const code = await buildVariant(variant);
			const file = path.join(tmp, `${variant.name}.js`);
			fs.writeFileSync(file, code);
			const runs: RunResult[] = [];
			for (let i = 0; i < RUNS; i++) {
				const out = execFileSync(process.execPath, ["-e", RUNNER, file, JSON.stringify(variant.external)], {
					encoding: "utf8",
				});
				runs.push(JSON.parse(out) as RunResult);
			}
			results.push({
				name: variant.name,
				description: variant.description,
				bytes: Buffer.byteLength(code),
				compileMs: stats(runs.map((r) => r.compileMs)),
				evalMs: stats(runs.map((r) => r.evalMs)),
				error: runs.find((r) => r.error)?.error ?? null,
				stubbedRequires: runs[0].stubbedRequires,
			});
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}

	console.log(`Bundle load cost (median of ${RUNS} fresh Node ${process.version} processes)\n`);
	console.log(`${"variant".padEnd(18)}${"size".padStart(9)}${"compile ms".padStart(13)}${"eval ms".padStart(10)}  notes`);
	for (const r of results) {
		const size = `${(r.bytes / 1e6).toFixed(2)} MB`;
		const notes = [r.description, r.error ? `eval threw: ${r.error}` : ""].filter(Boolean).join("; ");
		console.log(
			`${r.name.padEnd(18)}${size.padStart(9)}${String(r.compileMs.median).padStart(13)}${String(r.evalMs.median).padStart(10)}  ${notes}`,
		);
	}

	const probe = results.find((r) => r.name === "aws-external");
	const awsAtLoad = (probe?.stubbedRequires ?? []).filter((m) => AWS_PREFIXES.some((p) => m.startsWith(p)));
	console.log(
		awsAtLoad.length
			? `\nAWS SDK modules evaluated at load (${awsAtLoad.length}): ${awsAtLoad.join(", ")}`
			: "\nAWS SDK modules evaluated at load: none",
	);

	fs.mkdirSync(RESULTS_DIR, { recursive: true });
	const report = { runs: RUNS, node: process.version, at: new Date().toISOString(), variants: results, awsAtLoad };
	const reportPath = path.join(RESULTS_DIR, PROBE_ONLY ? "bundle-aws-probe-latest.json" : "bundle-eval-latest.json");
	fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
	console.log(`\nWritten to ${path.relative(PROJECT_ROOT, reportPath)}`);

	if (ASSERT_NO_AWS) {
		if (awsAtLoad.length) {
			console.log("FAIL  AWS SDK modules are evaluated at load (--assert-no-aws-at-load)");
			process.exit(1);
		}
		console.log("PASS  no AWS SDK module is evaluated at load");
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
