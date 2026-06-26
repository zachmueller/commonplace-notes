#!/usr/bin/env npx tsx
/**
 * Parser-pipeline regression + extensibility test.
 *
 * Exercises the REAL parser-extension building blocks — the built-in scaffolds,
 * the sucrase compile path, buildParserLibs(), and the same assemble logic the
 * manager uses — WITHOUT a running Obsidian instance. It does not instantiate
 * ParserExtensionManager (which needs a live vault/plugin); instead it replays
 * the manager's discover→compile→resolve→assemble pipeline against the actual
 * scaffold sources, so the scaffold code and compiler are genuinely under test.
 *
 * Guards:
 *   1. GOLDEN regression — the scaffold-assembled pipeline reproduces the legacy
 *      hardcoded pipeline's output byte-for-byte (e2e/fixtures/parser-golden.json).
 *   2. Custom remark stage — a user-added stage runs and built-ins still apply.
 *   3. Custom rehype stage — placement after rehype-slug works.
 *   4. Bad-return-shape stage — failure is isolated; the rest of the pipeline runs.
 *   5. Override-by-name — a vault stage with a built-in's name replaces it.
 *
 * Run: npx tsx e2e/scripts/test-parser-pipeline.ts
 */

// tsx's experimental ESM loader transpiles each file independently and can fail
// to detect named exports across barrel files (the same quirk test-wikilinks.ts
// works around). Use namespace imports for the local parser modules and read the
// members off the namespace object, which is robust.
import * as libsModule from '../../src/utils/parser/libs';
import * as compilerModule from '../../src/utils/parser/compiler';
import * as parserFileModule from '../../src/utils/parser/parserFile';
import * as scaffoldsModule from '../../src/utils/parser/scaffolds/index';
import type {
	ParserContext,
	ParserExtensionDefinition,
	ParserUtils,
} from '../../src/utils/parser/types';
import { PARSER_FIXTURES, PUBLISHED, type Fixture } from './parser-fixtures';
import golden from '../fixtures/parser-golden.json';

// tsx wraps CJS-transpiled module exports under `.default`; unwrap to the real
// exports object before reading members.
const unwrap = (m: any) => m?.default ?? m;
const buildParserLibs = unwrap(libsModule).buildParserLibs;
const compileParserExtension = unwrap(compilerModule).compileParserExtension;
const parseParserExtensionFile = unwrap(parserFileModule).parseParserExtensionFile;
const isParserError = unwrap(parserFileModule).isParserError;
const BUILTIN_PARSER_SCAFFOLDS = unwrap(scaffoldsModule).BUILTIN_PARSER_SCAFFOLDS;

const libs = buildParserLibs();

// A stubbed per-note context mirroring what NoteManager.markdownToHtml builds.
const context: ParserContext = {
	file: { path: 'note.md' } as any,
	profileId: 'default',
	frontmatterManager: {} as any,
	urlScheme: 'current',
	resolveInternalLinks: async (notePath: string) =>
		PUBLISHED.has(notePath)
			? { uid: `UID-${notePath}`, title: notePath, published: true }
			: null,
};

const utils: ParserUtils = { logger: console as any, slug: libs.githubSlugger.slug };

// ---------------------------------------------------------------------------
// Replay of the manager's discover→compile→resolve→assemble (extra vault stages
// passed as raw .md strings, exactly like discovered files).
// ---------------------------------------------------------------------------

function compileDef(def: ParserExtensionDefinition): ParserExtensionDefinition {
	const result = compileParserExtension(def.rawCode);
	if ('error' in result) throw new Error(`compile failed for ${def.name}: ${result.error}`);
	def.compiledFn = result.fn;
	return def;
}

function scaffoldDefs(): Map<string, ParserExtensionDefinition> {
	const map = new Map<string, ParserExtensionDefinition>();
	for (const [name, s] of BUILTIN_PARSER_SCAFFOLDS) {
		const parsed = parseParserExtensionFile(
			s.scaffoldContent,
			{
				'cpn-type': 'parser',
				'cpn-parser-name': s.name,
				'cpn-parser-stage': s.stage,
				'cpn-parser-order': s.order,
			},
			`(built-in scaffold: ${name})`,
			'built-in',
		);
		if (isParserError(parsed)) throw new Error(`scaffold parse failed: ${parsed.message}`);
		map.set(name, parsed);
	}
	return map;
}

/** Parse a vault-style .md stage string into a def (uses manual frontmatter). */
function vaultDef(md: string): ParserExtensionDefinition {
	// minimal frontmatter extraction (the fixtures are well-formed)
	const fmMatch = /^---\n([\s\S]*?)\n---/.exec(md);
	const fm: Record<string, unknown> = {};
	if (fmMatch) {
		for (const line of fmMatch[1].split('\n')) {
			const m = /^([\w-]+):\s*(.*)$/.exec(line.trim());
			if (m) fm[m[1]] = m[2].replace(/^["']|["']$/g, '');
		}
	}
	const parsed = parseParserExtensionFile(md, fm, `cpn/parsers/${fm['cpn-parser-name']}.md`, 'global');
	if (isParserError(parsed)) throw new Error(`vault stage parse failed: ${parsed.message}`);
	return parsed;
}

interface AssembleResult {
	html: string;
	errors: string[];
}

async function assembleAndRender(
	markdown: string,
	extraVaultStages: string[] = [],
): Promise<AssembleResult> {
	const byName = scaffoldDefs();
	// vault stages override built-ins by name, or add new stages
	for (const md of extraVaultStages) {
		const def = vaultDef(md);
		byName.set(def.name, def);
	}

	const errors: string[] = [];
	const compiled: ParserExtensionDefinition[] = [];
	for (const def of byName.values()) {
		try {
			compiled.push(compileDef(def));
		} catch (e) {
			errors.push(String(e));
		}
	}
	compiled.sort((a, b) =>
		a.order !== b.order ? a.order - b.order : a.filename.localeCompare(b.filename),
	);

	let processor = libs.unified();
	for (const def of compiled) {
		let produced: unknown;
		try {
			produced = await def.compiledFn!(libs, context, {} as any, utils);
		} catch (e) {
			errors.push(`${def.name} runtime: ${String(e)}`);
			continue;
		}
		if (typeof produced === 'function') {
			processor = processor.use(produced as any);
		} else if (Array.isArray(produced) && typeof produced[0] === 'function') {
			processor = processor.use(produced[0] as any, produced[1]);
		} else {
			errors.push(`${def.name} bad-shape: got ${typeof produced}`);
		}
	}
	const html = (await processor.process(markdown)).toString();
	return { html, errors };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let failures = 0;
function check(name: string, errs: string[]) {
	if (errs.length === 0) {
		console.log(`PASS  ${name}`);
	} else {
		failures++;
		console.log(`FAIL  ${name}`);
		for (const e of errs) console.log(`        - ${e}`);
	}
}

async function main() {
	// 1. GOLDEN regression — scaffold pipeline == legacy pipeline, byte for byte.
	for (const f of PARSER_FIXTURES as Fixture[]) {
		const { html, errors } = await assembleAndRender(f.input);
		const expected = (golden as Record<string, string>)[f.name];
		const errs = [...errors];
		if (expected === undefined) errs.push('no golden entry — re-run capture-parser-golden.ts');
		else if (html !== expected) {
			errs.push('output differs from golden');
			errs.push(`  expected: ${JSON.stringify(expected)}`);
			errs.push(`  actual:   ${JSON.stringify(html)}`);
		}
		check(`golden · ${f.name}`, errs);
	}

	// 2. Custom remark stage (order 035): uppercase heading text. Built-ins still run.
	{
		const stage = `---
cpn-type: parser
cpn-parser-name: uppercase-headings
cpn-parser-stage: remark
cpn-parser-order: 35
---
\`\`\`ts
return libs.defineTransform((tree) => {
  libs.visit(tree, 'heading', (node) => {
    libs.visit(node, 'text', (t) => { t.value = t.value.toUpperCase(); });
  });
});
\`\`\``;
		const { html, errors } = await assembleAndRender('## hello world\n\nbody', [stage]);
		const errs = [...errors];
		if (!html.includes('>HELLO WORLD<')) errs.push('heading not uppercased by custom stage');
		// rehype-slug still ran → id from ORIGINAL (pre-uppercase) text order:
		if (!/id="hello-world"/.test(html)) errs.push('built-in rehype-slug did not run (no id)');
		if (!/data-line="1"/.test(html)) errs.push('built-in line-numbers did not run');
		check('custom-remark-stage', errs);
	}

	// 3. Custom rehype stage (order 058, after slug 055): add class to every link.
	{
		const stage = `---
cpn-type: parser
cpn-parser-name: tag-links
cpn-parser-stage: rehype
cpn-parser-order: 58
---
\`\`\`ts
return libs.defineTransform((tree) => {
  libs.visit(tree, 'element', (node) => {
    if (node.tagName === 'a') {
      node.properties = node.properties || {};
      node.properties.className = ['tagged'];
    }
  });
});
\`\`\``;
		const { html, errors } = await assembleAndRender('See [[a]].', [stage]);
		const errs = [...errors];
		if (!/class="tagged"/.test(html)) errs.push('custom rehype stage did not tag links');
		if (!/href="#\/uUID-a"/.test(html)) errs.push('built-in wikilink resolution did not run');
		check('custom-rehype-stage', errs);
	}

	// 4. Bad-return-shape stage: failure is isolated, rest of pipeline still runs.
	{
		const stage = `---
cpn-type: parser
cpn-parser-name: broken-stage
cpn-parser-stage: remark
cpn-parser-order: 36
---
\`\`\`ts
return 42;
\`\`\``;
		const { html, errors } = await assembleAndRender('## ok\n\nSee [[a]].', [stage]);
		const errs: string[] = [];
		if (!errors.some((e) => e.includes('broken-stage') && e.includes('bad-shape')))
			errs.push('bad-shape stage did not record an error');
		if (!/href="#\/uUID-a"/.test(html)) errs.push('pipeline broke instead of isolating the failure');
		if (!/id="ok"/.test(html)) errs.push('built-ins did not run after the bad stage');
		check('bad-return-shape-isolated', errs);
	}

	// 5. Override-by-name: replace remark-gfm with a no-op → GFM stops working.
	{
		const override = `---
cpn-type: parser
cpn-parser-name: remark-gfm
cpn-parser-stage: remark
cpn-parser-order: 20
---
\`\`\`ts
return function () {};
\`\`\``;
		const table = '| a | b |\n| - | - |\n| 1 | 2 |';
		const baseline = await assembleAndRender(table);
		const overridden = await assembleAndRender(table, [override]);
		const errs: string[] = [];
		// table renders with attributes (class/data-line), so match the open tag prefix
		if (!/<table[ >]/.test(baseline.html)) errs.push('baseline GFM table did not render');
		if (/<table[ >]/.test(overridden.html)) errs.push('no-op override did not disable GFM tables');
		check('override-by-name (remark-gfm no-op)', errs);
	}

	console.log('');
	if (failures === 0) {
		console.log('All parser-pipeline cases passed.');
		process.exit(0);
	} else {
		console.log(`${failures} parser-pipeline case(s) FAILED.`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
