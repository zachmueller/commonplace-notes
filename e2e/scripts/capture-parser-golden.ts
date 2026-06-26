#!/usr/bin/env npx tsx
/**
 * Capture the GOLDEN output of the legacy (pre-refactor) Markdown→HTML pipeline.
 *
 * Run this against `main` (or any commit BEFORE the parser-extension cutover) to
 * snapshot the exact 7-stage pipeline output for a fixture corpus. The companion
 * test `test-parser-pipeline.ts` then asserts the NEW manager-assembled pipeline
 * reproduces this byte-for-byte — the primary regression guard that "the
 * scaffolds == the old hardcoded pipeline".
 *
 * This inlines the legacy pipeline directly (independent of the new scaffolds),
 * so it's a genuine cross-check rather than a tautology. It does NOT require a
 * running Obsidian instance — the plugin's obsidian/FrontmatterManager imports
 * are type-only and we stub the resolver.
 *
 * Run: npx tsx e2e/scripts/capture-parser-golden.ts > e2e/fixtures/parser-golden.json
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import * as obsidianLinksModule from '../../src/utils/remarkObsidianLinks';
import { type ResolvedNoteInfo } from '../../src/utils/remarkObsidianLinks';
import remarkLineNumbersModule from '../../src/utils/remarkLineNumbers';
import { PARSER_FIXTURES, PUBLISHED, type Fixture } from './parser-fixtures';

// tsx's ESM loader can double-wrap a default export; unwrap defensively so the
// real attacher (not an object) reaches unified().use().
const remarkObsidianLinks: any =
	(obsidianLinksModule as any).default?.default ??
	(obsidianLinksModule as any).default ??
	obsidianLinksModule;
const remarkLineNumbers: any =
	(remarkLineNumbersModule as any)?.default ?? remarkLineNumbersModule;

// EXACT replica of NoteManager.markdownToHtml's legacy 7-stage pipeline
// (notes.ts as of the pre-cutover commit). Keep in lockstep with that method.
async function renderLegacy(markdown: string): Promise<string> {
	const processor = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkLineNumbers)
		.use(remarkObsidianLinks, {
			frontmatterManager: {} as any,
			urlScheme: 'current',
			resolveInternalLinks: async (notePath: string): Promise<ResolvedNoteInfo | null> => {
				if (PUBLISHED.has(notePath)) {
					return { uid: `UID-${notePath}`, title: notePath, published: true };
				}
				return null;
			},
		})
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeSlug)
		.use(rehypeStringify, { allowDangerousHtml: true });

	const result = await processor.process(markdown);
	return result.toString();
}

async function main() {
	const golden: Record<string, string> = {};
	for (const f of PARSER_FIXTURES as Fixture[]) {
		golden[f.name] = await renderLegacy(f.input);
	}
	process.stdout.write(JSON.stringify(golden, null, 2) + '\n');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
