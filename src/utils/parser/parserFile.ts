/**
 * Parser for user-defined parser-stage `.md` files.
 *
 * Validates the `cpn-*` frontmatter and extracts the single TS/JS code fence.
 * Unlike Notor's extension parser, there is no YAML settings fence: parser
 * stages read all configuration from the runtime `context`, so frontmatter +
 * one code fence is the entire format.
 */

import type {
	ParserExtensionDefinition,
	ParserExtensionError,
	ParserSource,
	ParserStage,
} from './types';

// ---------------------------------------------------------------------------
// Fence extraction
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

// ---------------------------------------------------------------------------
// Frontmatter helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Coerce a frontmatter value to a finite number (accepts numeric strings). */
function asNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim() !== '') {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export type ParseParserResult = ParserExtensionDefinition | ParserExtensionError;

function isError(r: ParseParserResult): r is ParserExtensionError {
	return 'message' in r;
}

export { isError as isParserError };

/**
 * Parse a parser-stage Markdown file into a typed definition.
 *
 * @param content     - Raw Markdown file content.
 * @param frontmatter - Parsed frontmatter (from metadataCache or manual YAML).
 * @param filePath    - Vault-relative path (for error messages + filename tiebreak).
 * @param source      - Where the file came from (built-in scaffold vs vault dir).
 */
export function parseParserExtensionFile(
	content: string,
	frontmatter: Record<string, unknown>,
	filePath: string,
	source: ParserSource,
): ParseParserResult {
	// -- cpn-type --
	const cpnType = frontmatter['cpn-type'];
	if (!cpnType) {
		return { filePath, message: "Missing required frontmatter field 'cpn-type'" };
	}
	if (cpnType !== 'parser') {
		return { filePath, message: `Invalid 'cpn-type': '${String(cpnType)}'. Must be 'parser'` };
	}

	// -- cpn-parser-name --
	const name = asString(frontmatter['cpn-parser-name']);
	if (!name) {
		return { filePath, message: "Missing or empty 'cpn-parser-name'" };
	}

	// -- cpn-parser-stage --
	const stageRaw = asString(frontmatter['cpn-parser-stage']);
	if (stageRaw !== 'remark' && stageRaw !== 'rehype') {
		return {
			filePath,
			message: `Invalid 'cpn-parser-stage': '${String(frontmatter['cpn-parser-stage'])}'. Must be 'remark' or 'rehype'`,
		};
	}
	const stage = stageRaw as ParserStage;

	// -- cpn-parser-order --
	const order = asNumber(frontmatter['cpn-parser-order']);
	if (order === null) {
		return { filePath, message: "Missing or non-numeric 'cpn-parser-order'" };
	}

	// -- code fence --
	const rawCode = extractCodeFence(content);
	if (!rawCode) {
		return { filePath, message: "No TS/JS code fence found (expected a ```ts block)" };
	}

	const filename = filePath.split('/').pop() ?? filePath;

	return {
		name,
		stage,
		order,
		description: asString(frontmatter['cpn-description']) ?? undefined,
		filePath,
		filename,
		source,
		isScaffold: source === 'built-in',
		rawCode,
		compiledFn: null,
	};
}
