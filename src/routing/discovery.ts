/**
 * Routing-file discovery.
 *
 * Scans the configured routing directories for `.md` files and parses each into
 * a typed definition using a caller-supplied parser (actions vs options). Built
 * on the shared `vaultScan` primitives — including `extractFrontmatter`, which
 * reads freshly-created, not-yet-indexed notes (routing acts on brand-new files).
 */

import type { MetadataCache, TFile, Vault } from 'obsidian';
import { collectMarkdownFiles, extractFrontmatter } from '../utils/vaultScan';
import type { RoutingError, RoutingSource } from './types';

/** A directory to scan, tagged with the source tier its files belong to. */
export interface RoutingSearchDir {
	path: string;
	source: RoutingSource;
}

export interface RoutingDiscoveryResult<T> {
	definitions: T[];
	errors: RoutingError[];
}

/** A parser turning file content + frontmatter into a typed definition or error. */
type RoutingFileParser<T> = (
	content: string,
	frontmatter: Record<string, unknown>,
	filePath: string,
	source: RoutingSource,
) => T | RoutingError;

function isRoutingError<T extends object>(r: T | RoutingError): r is RoutingError {
	return 'message' in r;
}

/**
 * Scan the given directories for routing files and parse them.
 *
 * Missing directories are skipped silently. Malformed files are collected into
 * `errors` and skipped. Later dirs win on duplicate `name` (so a profile dir can
 * override a global one in v2). The definition's unique key is read via `keyOf`.
 *
 * @param vault         - Obsidian Vault.
 * @param metadataCache - For frontmatter access (with manual-YAML fallback).
 * @param dirs          - Ordered search dirs; later entries override earlier.
 * @param parseYAML     - Obsidian's `parseYaml`, for the uncached-file fallback.
 * @param parse         - Typed parser for this file kind (action or option).
 * @param keyOf         - Extracts the unique override key from a definition.
 */
export async function discoverRoutingFiles<T extends object>(
	vault: Vault,
	metadataCache: MetadataCache,
	dirs: RoutingSearchDir[],
	parseYAML: (yaml: string) => unknown,
	parse: RoutingFileParser<T>,
	keyOf: (def: T) => string,
): Promise<RoutingDiscoveryResult<T>> {
	const byName = new Map<string, T>();
	const errors: RoutingError[] = [];

	for (const dir of dirs) {
		const files = collectMarkdownFiles(vault, dir.path);
		for (const file of files) {
			const result = await parseOneFile(vault, metadataCache, file, dir.source, parseYAML, parse);
			if (isRoutingError(result)) {
				errors.push(result);
			} else {
				byName.set(keyOf(result), result);
			}
		}
	}

	return { definitions: Array.from(byName.values()), errors };
}

async function parseOneFile<T extends object>(
	vault: Vault,
	metadataCache: MetadataCache,
	file: TFile,
	source: RoutingSource,
	parseYAML: (yaml: string) => unknown,
	parse: RoutingFileParser<T>,
): Promise<T | RoutingError> {
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

	return parse(content, frontmatter, file.path, source);
}
