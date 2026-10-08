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
 *   6. context.noteStyle is readable from custom stages.
 *   7. Transclusion placeholders (![[…]]) and block ids (^id).
 *   8. remark-obsidian-links override with transclusions:false.
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
	noteStyle: 'ai',
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

	// 6. context.noteStyle: a stage reads the resolved cpn-style and stamps it
	//    onto the root element, proving custom stages can branch on the style group.
	{
		const stage = `---
cpn-type: parser
cpn-parser-name: stamp-note-style
cpn-parser-stage: rehype
cpn-parser-order: 58
---
\`\`\`ts
return libs.defineTransform((tree) => {
  libs.visit(tree, 'element', (node) => {
    if (!node.properties || !node.properties['dataNoteStyle']) {
      node.properties = node.properties || {};
      node.properties['dataNoteStyle'] = context.noteStyle || 'none';
    }
  });
});
\`\`\``;
		const { html, errors } = await assembleAndRender('hello', [stage]);
		const errs = [...errors];
		// context.noteStyle is 'ai' in the stub → serialized as data-note-style="ai".
		if (!/data-note-style="ai"/.test(html)) errs.push(`stage did not read context.noteStyle (html: ${html})`);
		check('context-noteStyle-readable', errs);
	}

	// 7. Transclusions + block ids. Each case: markdown → substrings that must
	//    (and must not) appear in the rendered HTML.
	{
		const cases: Array<{ name: string; md: string; has: string[]; not?: string[] }> = [
			{
				name: 'embed · whole note → block placeholder',
				md: '![[a]]',
				has: ['<div class="line cpn-transclusion" data-line="1" data-uid="UID-a" data-title="a"><a href="#/uUID-a">a</a></div>'],
				not: ['!', '<p'],
			},
			{
				name: 'embed · heading section',
				md: '![[a#My Section]]',
				has: ['data-uid="UID-a"', 'data-heading="my-section"><a href="#/uUID-a" data-heading="my-section">My Section</a>'],
			},
			{
				name: 'embed · block',
				md: '![[a#^abc]]',
				has: ['data-block="abc"><a href="#/uUID-a" data-heading="^abc">a</a>'],
			},
			{
				name: 'embed · several in one paragraph → group',
				md: '![[a]]\n![[b]]',
				has: [
					'<div class="line cpn-transclusion-group" data-line="1">',
					'<div class="cpn-transclusion" data-uid="UID-a"',
					'<div class="cpn-transclusion" data-uid="UID-b"',
				],
			},
			{
				name: 'embed · group with an unpublished member',
				md: '![[a]]\n![[missing]]',
				has: ['data-uid="UID-a"', '<p><span class="unpublished-link">missing</span></p>'],
				not: ['data-uid="UID-missing"'],
			},
			{
				name: 'embed · mid-paragraph → inline span',
				md: 'See ![[a]] here',
				has: ['<p class="line" data-line="1">See <span class="cpn-transclusion" data-uid="UID-a" data-title="a"><a href="#/uUID-a">a</a></span> here</p>'],
			},
			{
				name: 'embed · unpublished target → span, no ! or uid',
				md: '![[missing]]',
				has: ['<span class="unpublished-link">missing</span>'],
				not: ['!', 'data-uid', 'cpn-transclusion'],
			},
			{
				name: 'embed · attachment with size alias → path, no !',
				md: '![[pic.png|300]]',
				has: ['<span class="unpublished-link">pic.png</span>'],
				not: ['!', '300', 'data-uid'],
			},
			{
				name: 'embed · inside a heading → plain link',
				md: '## Title ![[a]]',
				has: ['<a href="#/uUID-a">a</a></h2>'],
				not: ['cpn-transclusion', '!'],
			},
			{
				name: 'embed · in a tight list item survives (div is not unwrapped)',
				md: '- ![[a]]\n- b',
				has: ['<li class="line" data-line="1">\n<div class="line cpn-transclusion"'],
			},
			{
				name: 'embed · in a table cell → inline span',
				md: '| x |\n|---|\n| ![[a]] |',
				has: ['<td class="line" data-line="3"><span class="cpn-transclusion" data-uid="UID-a"'],
			},
			{
				name: 'embed · followed by its own block id',
				md: '![[a]] ^abc',
				has: ['class="line cpn-transclusion" data-line="1" data-block-id="abc" data-uid="UID-a"'],
				not: ['^abc'],
			},
			{
				name: 'block id · trailing on paragraph (no id attribute)',
				md: 'Some intro. ^intro',
				has: ['<p class="line" data-line="1" data-block-id="intro">Some intro.</p>'],
				not: [' id="', '^intro'],
			},
			{
				name: 'block id · list item carries it (tight list)',
				md: '- First ^li1\n  - nested\n- Second',
				has: ['<li class="line" data-line="1" data-block-id="li1">First'],
				not: ['^li1'],
			},
			{
				name: 'block id · list item carries it (loose list)',
				md: '- First ^li1\n\n- Second',
				has: ['<li class="line" data-line="1" data-block-id="li1">\n<p class="line" data-line="1">First</p>'],
			},
			{
				name: 'block id · standalone after table',
				md: '| a |\n|---|\n| 1 |\n\n^tbl',
				has: ['<table class="line" data-line="1" data-block-id="tbl">'],
				not: ['^tbl'],
			},
			{
				name: 'block id · standalone after blockquote / callout',
				md: '> [!note] T\n> body\n\n^co\n\n> quote\n\n^bq',
				has: ['data-block-id="co" data-callout-type="note"', '<blockquote class="line" data-line="6" data-block-id="bq">'],
			},
			{
				name: 'block id · standalone after code fence (on <code>)',
				md: '```js\nx()\n```\n\n^code',
				has: ['<pre><code class="line" data-line="1" data-block-id="code">'],
			},
			{
				name: 'block id · headings and leading markers are left alone',
				md: '## Heading ^h\n\n^orphan',
				has: ['Heading ^h</h2>', '<p class="line" data-line="3">^orphan</p>'],
				not: ['data-block-id'],
			},
			{
				name: 'block id · first duplicate wins',
				md: 'one ^dup\n\ntwo ^dup',
				has: ['data-block-id="dup">one</p>', '<p class="line" data-line="3">two</p>'],
			},
			{
				name: 'block links · data-heading="^id", readable text',
				md: '[[a#^abc]] and [[#^abc]] and [[a#^abc|alias]]',
				has: [
					'<a href="#/uUID-a" data-heading="^abc">a</a>',
					'<a href="#" data-heading="^abc" data-same-note="true">',
					'<a href="#/uUID-a" data-heading="^abc">alias</a>',
				],
			},
		];
		for (const c of cases) {
			const { html, errors } = await assembleAndRender(c.md);
			const errs = [...errors];
			for (const h of c.has) if (!html.includes(h)) errs.push(`missing ${JSON.stringify(h)}`);
			for (const n of c.not ?? []) if (html.includes(n)) errs.push(`unexpected ${JSON.stringify(n)}`);
			if (errs.length > errors.length) errs.push(`html: ${JSON.stringify(html)}`);
			check(c.name, errs);
		}
	}

	// 8. Override with transclusions:false → embeds render as plain links.
	{
		const override = `---
cpn-type: parser
cpn-parser-name: remark-obsidian-links
cpn-parser-stage: remark
cpn-parser-order: 40
---
\`\`\`ts
return [libs.remarkObsidianLinks, {
  frontmatterManager: context.frontmatterManager,
  urlScheme: context.urlScheme,
  resolveInternalLinks: context.resolveInternalLinks,
  transclusions: false,
}];
\`\`\``;
		const { html, errors } = await assembleAndRender('![[a]]', [override]);
		const errs = [...errors];
		if (html.includes('cpn-transclusion')) errs.push('placeholder emitted despite transclusions:false');
		if (!html.includes('<p class="line" data-line="1"><a href="#/uUID-a">a</a></p>')) errs.push(`expected a plain link (html: ${html})`);
		check('override · transclusions:false → links', errs);
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
