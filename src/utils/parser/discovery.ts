/**
 * Parser-extension file discovery.
 *
 * Scans the configured CPN parser directories for `.md` files with
 * `cpn-type: parser` and parses each into a typed definition. Ported from
 * Notor's `shared/notor/src/extensions/discovery.ts`, trimmed to a single
 * extension type and an array of search dirs (forward-compatible with the v2
 * profile tier).
 */

import type { MetadataCache, TFile, Vault } from 'obsidian';
import { parseParserExtensionFile, isParserError } from './parserFile';
import { collectMarkdownFiles, extractFrontmatter } from '../vaultScan';
import type {
	ParserExtensionDefinition,
	ParserExtensionError,
	ParserSource,
} from './types';

// Re-export for existing importers (kept stable after the shared extraction).
export { collectMarkdownFiles, extractFrontmatter };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ParserDiscoveryResult {
	definitions: ParserExtensionDefinition[];
	errors: ParserExtensionError[];
}

/** A directory to scan, tagged with the source tier its files belong to. */
export interface ParserSearchDir {
	path: string;
	source: ParserSource;
}

/**
 * Scan the given directories for parser-stage files and parse them.
 *
 * Missing directories are skipped silently (empty results, no error).
 * Malformed files are collected into `errors` and skipped. Later dirs in the
 * list win on duplicate `cpn-parser-name` (so a profile dir can override a
 * global one in v2); within this v1 build only the global dir is passed.
 *
 * @param vault         - Obsidian Vault.
 * @param metadataCache - For frontmatter access (with manual-YAML fallback).
 * @param dirs          - Ordered search dirs; later entries override earlier.
 * @param parseYAML     - Obsidian's `parseYaml`, for the uncached-file fallback.
 */
export async function discoverParserExtensions(
	vault: Vault,
	metadataCache: MetadataCache,
	dirs: ParserSearchDir[],
	parseYAML: (yaml: string) => unknown,
): Promise<ParserDiscoveryResult> {
	const byName = new Map<string, ParserExtensionDefinition>();
	const errors: ParserExtensionError[] = [];

	for (const dir of dirs) {
		const files = collectMarkdownFiles(vault, dir.path);
		for (const file of files) {
			const result = await parseOneFile(vault, metadataCache, file, dir.source, parseYAML);
			if (isParserError(result)) {
				errors.push(result);
			} else {
				// Later dir tiers override earlier ones by name.
				byName.set(result.name, result);
			}
		}
	}

	return { definitions: Array.from(byName.values()), errors };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function parseOneFile(
	vault: Vault,
	metadataCache: MetadataCache,
	file: TFile,
	source: ParserSource,
	parseYAML: (yaml: string) => unknown,
): Promise<ParseParserResultLike> {
	const content = await vault.cachedRead(file);

	let frontmatter = metadataCache.getFileCache(file)?.frontmatter as
		| Record<string, unknown>
		| undefined;

	if (!frontmatter) {
		try {
			frontmatter = extractFrontmatter(content, parseYAML) ?? undefined;
		} catch {
			return { filePath: file.path, message: 'Failed to parse YAML frontmatter' };
		}
	}
	if (!frontmatter) {
		return { filePath: file.path, message: 'No frontmatter found' };
	}

	return parseParserExtensionFile(content, frontmatter, file.path, source);
}

type ParseParserResultLike = ReturnType<typeof parseParserExtensionFile>;
