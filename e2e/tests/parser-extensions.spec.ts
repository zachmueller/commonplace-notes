/**
 * In-Obsidian test for the user-extensible parser.
 *
 * Unlike the Node-based e2e/scripts/test-parser-pipeline.ts (which stubs the
 * vault/app), this drives the REAL ParserExtensionManager through the live
 * plugin instance inside Obsidian — exercising actual vault IO, the real `app`,
 * scaffold materialization, override-by-name, and runtime math rendering (the
 * Electron-vs-Node path most likely to differ).
 *
 * Run with: npx playwright test --config=e2e/playwright.config.ts
 */

import { test, expect } from "../lib/obsidian-fixture";

const PLUGIN_ID = "commonplace-notes";

test.describe("Parser extensions (in-Obsidian)", () => {
	test("built-in pipeline, override + reset, and math rendering", async ({ obsidianPage }) => {
		await obsidianPage.waitForTimeout(5000);

		const result = await obsidianPage.evaluate(async (pluginId) => {
			const app = (window as any).app;
			const plugin = app?.plugins?.plugins?.[pluginId];
			if (!plugin) return { error: "plugin not found" };
			const mgr = plugin.parserExtensionManager;
			if (!mgr) return { error: "parserExtensionManager not found" };

			const out: Record<string, unknown> = {};
			const profileId =
				plugin.settings?.publishingProfiles?.[0]?.id ?? "default";

			// A per-note context like NoteManager.markdownToHtml builds. The
			// resolver returns null (nothing published in the test vault), so
			// wikilinks render as unpublished spans — fine for these assertions.
			const makeCtx = () => ({
				file: { path: "probe.md", extension: "md" },
				profileId,
				frontmatterManager: plugin.frontmatterManager,
				urlScheme: "current",
				resolveInternalLinks: async () => null,
			});

			const render = async (md: string) => {
				const proc = await mgr.assemblePipeline(profileId, makeCtx());
				return (await proc.process(md)).toString();
			};

			// 1. Built-in pipeline (in-memory scaffold fallbacks).
			await mgr.loadExtensions(profileId);
			const baseHtml = await render("## Hello\n\nA paragraph with **bold**.");
			out.builtinHasSlugId = /id="hello"/.test(baseHtml);
			out.builtinHasLineAttr = /data-line="1"/.test(baseHtml);
			out.builtinErrorsBefore = mgr.getLoadErrors().length;

			// 2. Materialize a built-in (real vault write) then override it.
			const gfmPath = await mgr.ensureBuiltinParserVaultFile("remark-gfm");
			out.materializedPath = gfmPath;
			out.materializedExists = !!app.vault.getAbstractFileByPath(gfmPath);

			// Overwrite remark-gfm with a no-op so GFM tables stop rendering.
			const noop = [
				"---",
				"cpn-type: parser",
				"cpn-parser-name: remark-gfm",
				"cpn-parser-stage: remark",
				"cpn-parser-order: 20",
				"---",
				"",
				"```ts",
				"return function () {};",
				"```",
				"",
			].join("\n");
			const gfmFile = app.vault.getAbstractFileByPath(gfmPath);
			await app.vault.modify(gfmFile, noop);

			const table = "| a | b |\n| - | - |\n| 1 | 2 |";
			await mgr.loadExtensions(profileId); // reload picks up the override
			const overriddenHtml = await render(table);
			out.overrideDisablesTables = !/<table[ >]/.test(overriddenHtml);

			// 3. Reset → built-in GFM resumes.
			await mgr.resetBuiltinParserToDefault("remark-gfm");
			out.resetRemovedFile = !app.vault.getAbstractFileByPath(gfmPath);
			await mgr.loadExtensions(profileId);
			const restoredHtml = await render(table);
			out.resetRestoresTables = /<table[ >]/.test(restoredHtml);

			// 4. Heavy lib works in the Electron runtime: add a math stage that
			//    awaits the lazy katex thunk, then render inline math.
			const mathStage = [
				"---",
				"cpn-type: parser",
				"cpn-parser-name: math-remark",
				"cpn-parser-stage: remark",
				"cpn-parser-order: 22",
				"---",
				"",
				"```ts",
				"return libs.remarkMath;",
				"```",
				"",
			].join("\n");
			const katexStage = [
				"---",
				"cpn-type: parser",
				"cpn-parser-name: math-rehype",
				"cpn-parser-stage: rehype",
				"cpn-parser-order: 56",
				"---",
				"",
				"```ts",
				"return await libs.rehypeKatex();",
				"```",
				"",
			].join("\n");
			const parsersDir = `${plugin.settings.cpnDirectory ?? "cpn"}/parsers`;
			if (!app.vault.getAbstractFileByPath(parsersDir)) {
				await app.vault.createFolder(parsersDir);
			}
			for (const [name, body] of [
				["math-remark", mathStage],
				["math-rehype", katexStage],
			] as const) {
				const p = `${parsersDir}/${name}.md`;
				const existing = app.vault.getAbstractFileByPath(p);
				if (existing) await app.vault.modify(existing, body);
				else await app.vault.create(p, body);
			}
			await mgr.loadExtensions(profileId);
			const mathHtml = await render("Euler: $e^{i\\pi}+1=0$");
			out.katexRendered = /katex/.test(mathHtml);
			out.katexMathErrors = mgr.getLoadErrors().length;

			// 4b. MathJax via the browser adaptor (no jsdom). This is the path that
			//     requires a real DOM — verifies the esbuild browser-adaptor remap
			//     works in Obsidian's Electron renderer. Swap the rehype stage to
			//     mathjax and re-render.
			const mathjaxStage = [
				"---",
				"cpn-type: parser",
				"cpn-parser-name: math-rehype",
				"cpn-parser-stage: rehype",
				"cpn-parser-order: 56",
				"---",
				"",
				"```ts",
				"return await libs.rehypeMathjax();",
				"```",
				"",
			].join("\n");
			const mjxFile = app.vault.getAbstractFileByPath(`${parsersDir}/math-rehype.md`);
			if (mjxFile) await app.vault.modify(mjxFile, mathjaxStage);
			await mgr.loadExtensions(profileId);
			const mathjaxHtml = await render("Euler: $e^{i\\pi}+1=0$");
			// MathJax SVG output emits <mjx-container> wrapping an <svg>.
			out.mathjaxRendered = /<mjx-container|<svg/.test(mathjaxHtml);
			out.mathjaxErrors = mgr.getLoadErrors().length;

			// cleanup the math stages so reruns start clean
			for (const name of ["math-remark", "math-rehype"]) {
				const f = app.vault.getAbstractFileByPath(`${parsersDir}/${name}.md`);
				if (f) await app.vault.delete(f);
			}

			return out;
		}, PLUGIN_ID);

		console.log("parser-extensions probe:", JSON.stringify(result, null, 2));

		expect((result as any).error).toBeUndefined();
		expect((result as any).builtinHasSlugId).toBe(true);
		expect((result as any).builtinHasLineAttr).toBe(true);
		expect((result as any).builtinErrorsBefore).toBe(0);
		expect((result as any).materializedExists).toBe(true);
		expect((result as any).overrideDisablesTables).toBe(true);
		expect((result as any).resetRemovedFile).toBe(true);
		expect((result as any).resetRestoresTables).toBe(true);
		expect((result as any).katexRendered).toBe(true);
		expect((result as any).katexMathErrors).toBe(0);
		expect((result as any).mathjaxRendered).toBe(true);
		expect((result as any).mathjaxErrors).toBe(0);
	});
});
