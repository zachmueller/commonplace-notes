/**
 * Vault-facing discovery for site-asset customization notes.
 *
 * Scans `{cpnDir}/profiles/{profileId}/assets/` for `.md` notes with
 * `cpn-type: asset` and parses each into an {@link AssetCustomization}. Mirrors
 * `parseOneFile` in `src/utils/parser/discovery.ts` and reuses that module's
 * already-exported `collectMarkdownFiles` + `extractFrontmatter` helpers.
 *
 * Missing directory → empty result (no error). Malformed notes are collected
 * into `errors` and skipped, so a bad note never breaks a push.
 */

import { normalizePath } from 'obsidian';
import type { MetadataCache, TFile, Vault } from 'obsidian';
import { collectMarkdownFiles, extractFrontmatter } from '../../utils/parser/discovery';
import { isAssetError, parseAssetCustomizationFile } from './parse';
import type { AssetCustomization, AssetCustomizationError } from './types';

const DEFAULT_CPN_DIR = 'cpn';

export interface AssetDiscoveryResult {
	customizations: AssetCustomization[];
	errors: AssetCustomizationError[];
}

/**
 * Vault-relative directory holding a profile's asset-customization notes.
 * Rooted at the user-visible `cpnDirectory` setting (NOT `ProfileManager`'s
 * hidden `manifest.dir` root, which Obsidian's metadata cache does not index).
 * Matches `ParserExtensionManager.cpnBaseDir()`.
 */
export function getAssetsDir(cpnDirectory: string | undefined, profileId: string): string {
	const base = (cpnDirectory || DEFAULT_CPN_DIR).replace(/\/+$/, '');
	return normalizePath(`${base}/profiles/${profileId}/assets`);
}

/**
 * Discover + parse every asset-customization note under `assetsDir`.
 *
 * @param vault         - Obsidian Vault.
 * @param metadataCache - For frontmatter access (with manual-YAML fallback).
 * @param assetsDir      - Vault-relative dir from {@link getAssetsDir}.
 * @param parseYAML     - Obsidian's `parseYaml`, for the uncached-file fallback.
 */
export async function discoverAssetCustomizations(
	vault: Vault,
	metadataCache: MetadataCache,
	assetsDir: string,
	parseYAML: (yaml: string) => unknown,
): Promise<AssetDiscoveryResult> {
	const customizations: AssetCustomization[] = [];
	const errors: AssetCustomizationError[] = [];

	const files = collectMarkdownFiles(vault, assetsDir);
	for (const file of files) {
		const result = await parseOneFile(vault, metadataCache, file, parseYAML);
		if (isAssetError(result)) {
			errors.push(result);
		} else {
			customizations.push(result);
		}
	}

	return { customizations, errors };
}

async function parseOneFile(
	vault: Vault,
	metadataCache: MetadataCache,
	file: TFile,
	parseYAML: (yaml: string) => unknown,
): Promise<ReturnType<typeof parseAssetCustomizationFile>> {
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

	return parseAssetCustomizationFile(content, frontmatter, file.path);
}
