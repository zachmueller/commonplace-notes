/**
 * Shared vault-scanning primitives for the CPN extension subsystems (parser
 * stages, note-routing actions/options). These are `cpn-type`-agnostic: each
 * subsystem layers its own typed parser on top.
 *
 * Extracted from the parser subsystem so routing can reuse them verbatim rather
 * than re-implementing (and drifting from) the frontmatter/code-fence handling.
 */

import { TAbstractFile } from 'obsidian';
import type { TFile, TFolder, Vault } from 'obsidian';

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isFolder(file: TAbstractFile): file is TFolder {
	return 'children' in file;
}

export function isFile(file: TAbstractFile): file is TFile {
	return 'stat' in file && !('children' in file);
}

// ---------------------------------------------------------------------------
// Directory collection
// ---------------------------------------------------------------------------

/**
 * Collect all `.md` files directly under a vault directory (non-recursive —
 * extension files are flat in their configured dir). Empty array if absent.
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

// ---------------------------------------------------------------------------
// Frontmatter extraction (manual-YAML fallback)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Code-fence extraction
// ---------------------------------------------------------------------------

/**
 * Extract the content of the first ```ts / ```typescript / ```js / ```javascript
 * fenced code block. Returns the inner code, or null if none/empty.
 */
export function extractCodeFence(content: string): string | null {
	const regex = /^```(?:ts|typescript|js|javascript)\s*\n([\s\S]*?)^```\s*$/gm;
	const match = regex.exec(content);
	if (!match) return null;
	const code = match[1] ?? '';
	if (code.trim() === '') return null;
	return code;
}
