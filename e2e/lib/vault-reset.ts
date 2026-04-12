/**
 * Vault Reset — ensures clean state between e2e test runs.
 *
 * Uses a surgical approach: deletes known test-generated artifacts while
 * preserving the vault structure, Obsidian config, and base fixtures.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface VaultResetOptions {
	/** Additional vault-relative file/dir paths to delete. */
	extraDeletePaths?: string[];
	/** Additional vault-relative file/dir paths to preserve (skip deletion). */
	extraPreservePaths?: string[];
}

/** Known test-generated notes (vault-relative paths). */
const TEST_GENERATED_NOTES = [
	"E2E-Test-Note.md",
	"Publish-Test.md",
];

/** Known test-generated directories (vault-relative). */
const TEST_GENERATED_DIRS: string[] = [];

function rmSafe(targetPath: string): void {
	try {
		if (!fs.existsSync(targetPath)) return;
		const stat = fs.lstatSync(targetPath);
		if (stat.isDirectory()) {
			fs.rmSync(targetPath, { recursive: true, force: true });
		} else {
			fs.unlinkSync(targetPath);
		}
	} catch {
		// Best-effort cleanup
	}
}

/**
 * Reset the test vault to a clean state.
 *
 * Deletes:
 *   - Known test-generated notes and directories
 *   - Any extra paths specified in options
 *
 * Preserves:
 *   - .obsidian/ config and plugin symlinks
 *   - Test Note.md (base fixture)
 */
export function resetVault(vaultPath: string, options?: VaultResetOptions): void {
	// Build preserve set
	const preserveSet = new Set<string>([
		"Test Note.md",
		...(options?.extraPreservePaths ?? []),
	]);

	// Delete known test-generated notes
	for (const note of TEST_GENERATED_NOTES) {
		if (!preserveSet.has(note)) {
			rmSafe(path.join(vaultPath, note));
		}
	}

	// Delete known test-generated directories
	for (const dir of TEST_GENERATED_DIRS) {
		if (!preserveSet.has(dir)) {
			rmSafe(path.join(vaultPath, dir));
		}
	}

	// Delete extra paths
	for (const extra of options?.extraDeletePaths ?? []) {
		rmSafe(path.join(vaultPath, extra));
	}

	console.log(`  Vault reset complete: ${vaultPath}`);
}
