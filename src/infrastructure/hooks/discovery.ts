/**
 * Deploy-hook file discovery.
 *
 * Scans the configured per-profile hooks directory for `.md` files with
 * `cpn-type: pre-deploy-hook` / `post-deploy-hook` and parses each into a typed
 * definition. Modeled on `src/utils/parser/discovery.ts`; reuses the shared
 * `collectMarkdownFiles` + `extractFrontmatter` vault-scan primitives.
 *
 * Missing directories are skipped silently (empty results, no error). Malformed
 * files are collected into `errors` and skipped, so a bad file never breaks the
 * batch. De-dupe is keyed by `${phase}::${name}` — a pre and a post hook may
 * legitimately share a `cpn-hook-name` (it is unique only WITHIN a phase).
 */

import type { MetadataCache, TFile, Vault } from 'obsidian';
import { collectMarkdownFiles, extractFrontmatter } from '../../utils/vaultScan';
import { parseDeployHookFile, isDeployHookError } from './hookFile';
import type {
	DeployHookDefinition,
	DeployHookError,
	DeployHookSource,
} from './types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DeployHookDiscoveryResult {
	definitions: DeployHookDefinition[];
	errors: DeployHookError[];
}

/** A directory to scan, tagged with the source tier its files belong to. */
export interface DeployHookSearchDir {
	path: string;
	source: DeployHookSource;
}

/**
 * Scan the given directories for deploy-hook files and parse them.
 *
 * @param vault         - Obsidian Vault.
 * @param metadataCache - For frontmatter access (with manual-YAML fallback).
 * @param dirs          - Ordered search dirs; later entries override earlier.
 * @param parseYAML     - Obsidian's `parseYaml`, for the uncached-file fallback.
 */
export async function discoverDeployHooks(
	vault: Vault,
	metadataCache: MetadataCache,
	dirs: DeployHookSearchDir[],
	parseYAML: (yaml: string) => unknown,
): Promise<DeployHookDiscoveryResult> {
	const byKey = new Map<string, DeployHookDefinition>();
	const errors: DeployHookError[] = [];

	for (const dir of dirs) {
		const files = collectMarkdownFiles(vault, dir.path);
		for (const file of files) {
			const result = await parseOneFile(vault, metadataCache, file, dir.source, parseYAML);
			if (isDeployHookError(result)) {
				errors.push(result);
			} else {
				// Later dir tiers override earlier ones. Key by phase+name so a
				// pre/post pair sharing a `cpn-hook-name` both survive.
				byKey.set(`${result.phase}::${result.name}`, result);
			}
		}
	}

	return { definitions: Array.from(byKey.values()), errors };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function parseOneFile(
	vault: Vault,
	metadataCache: MetadataCache,
	file: TFile,
	source: DeployHookSource,
	parseYAML: (yaml: string) => unknown,
): Promise<ParseDeployHookResultLike> {
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

	return parseDeployHookFile(content, frontmatter, file.path, source);
}

type ParseDeployHookResultLike = ReturnType<typeof parseDeployHookFile>;
