/**
 * Parser-extension file discovery.
 *
 * Scans the configured CPN parser directories for `.md` files with
 * `cpn-type: parser` and parses each into a typed definition. Ported from
 * Notor's `shared/notor/src/extensions/discovery.ts`, trimmed to a single
 * extension type and an array of search dirs (forward-compatible with the v2
 * profile tier).
 */

import { TAbstractFile } from 'obsidian';
import type { MetadataCache, TFile, TFolder, Vault } from 'obsidian';
import { parseParserExtensionFile, isParserError } from './parserFile';
import type {
	ParserExtensionDefinition,
	ParserExtensionError,
	ParserSource,
} from './types';

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isFolder(file: TAbstractFile): file is TFolder {
	return 'children' in file;
}

function isFile(file: TAbstractFile): file is TFile {
	return 'stat' in file && !('children' in file);
}

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

/**
 * Collect all `.md` files directly under a vault directory (non-recursive —
 * parser stages are flat in `<cpnDir>/parsers/`). Empty array if absent.
 */
export function collectMarkdownFiles(vault: Vault, dirPath: string): TFile[] {
	const dir = vault.getAbstractFileByPath(dirPath);
	if (!dir || !isFolder(dir)) return [];

	const files: TFile[] = [];
	for (const child of dir.children) {
		if (isFile(child) && child.name.endsWith('.md')) {
			files.push(child);
		}
	}
	return files;
}

/**
 * Extract frontmatter from raw content via manual YAML parsing. Used when the
 * metadata cache hasn't indexed a freshly-created file yet.
 *
 * @throws If a YAML body exists but fails to parse.
 */
export function extractFrontmatter(
	content: string,
	parseYAML: (yaml: string) => unknown,
): Record<string, unknown> | null {
	if (!content.trimStart().startsWith('---')) return null;

	const afterOpener = content.indexOf('\n', content.indexOf('---'));
	if (afterOpener === -1) return null;

	const closerIdx = content.indexOf('\n---', afterOpener);
	if (closerIdx === -1) return null;

	const yamlBody = content.substring(afterOpener + 1, closerIdx);
	const parsed = parseYAML(yamlBody);
	if (parsed && typeof parsed === 'object') {
		return parsed as Record<string, unknown>;
	}
	return null;
}

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
