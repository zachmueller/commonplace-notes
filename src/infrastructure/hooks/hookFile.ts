/**
 * Parser for user-defined deploy-hook `.md` files.
 *
 * Validates the `cpn-*` frontmatter and extracts the single TS/JS code fence.
 * The phase is encoded in `cpn-type` itself (`pre-deploy-hook` /
 * `post-deploy-hook`) rather than a separate field. Frontmatter + one code
 * fence is the entire format. Modeled on `src/utils/parser/parserFile.ts`.
 */

import { extractCodeFence } from '../../utils/vaultScan';
import type {
	DeployHookDefinition,
	DeployHookError,
	DeployHookPhase,
	DeployHookSource,
} from './types';

// Re-export for convenience at call sites.
export { extractCodeFence };

// ---------------------------------------------------------------------------
// Frontmatter helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export type ParseDeployHookResult = DeployHookDefinition | DeployHookError;

function isError(r: ParseDeployHookResult): r is DeployHookError {
	return 'message' in r;
}

export { isError as isDeployHookError };

/**
 * Parse a deploy-hook Markdown file into a typed definition.
 *
 * @param content     - Raw Markdown file content.
 * @param frontmatter - Parsed frontmatter (from metadataCache or manual YAML).
 * @param filePath    - Vault-relative path (for error messages + filename tiebreak).
 * @param source      - Where the file came from.
 */
export function parseDeployHookFile(
	content: string,
	frontmatter: Record<string, unknown>,
	filePath: string,
	source: DeployHookSource,
): ParseDeployHookResult {
	// -- cpn-type (also carries the phase) --
	const cpnType = frontmatter['cpn-type'];
	if (!cpnType) {
		return { filePath, message: "Missing required frontmatter field 'cpn-type'" };
	}
	if (cpnType !== 'pre-deploy-hook' && cpnType !== 'post-deploy-hook') {
		return {
			filePath,
			message: `Invalid 'cpn-type': '${String(cpnType)}'. Must be 'pre-deploy-hook' or 'post-deploy-hook'`,
		};
	}
	const phase: DeployHookPhase = cpnType === 'pre-deploy-hook' ? 'pre' : 'post';

	// -- cpn-hook-name --
	const name = asString(frontmatter['cpn-hook-name']);
	if (!name) {
		return { filePath, message: "Missing or empty 'cpn-hook-name'" };
	}

	// -- code fence --
	const rawCode = extractCodeFence(content);
	if (!rawCode) {
		return { filePath, message: "No TS/JS code fence found (expected a ```ts block)" };
	}

	const filename = filePath.split('/').pop() ?? filePath;

	return {
		name,
		phase,
		description: asString(frontmatter['cpn-description']) ?? undefined,
		filePath,
		filename,
		source,
		rawCode,
		compiledFn: null,
	};
}
