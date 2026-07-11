/**
 * Parser for routing ACTION `.md` files (`cpn-type: routing-action`).
 *
 * Validates the `cpn-*` frontmatter, reads kind-specific config, and — for the
 * `code` kind — extracts the single TS/JS code fence. Modeled on the parser
 * subsystem's `parserFile.ts`.
 */

import { extractCodeFence } from '../utils/vaultScan';
import { RK } from './frontmatterKeys';
import type {
	RoutingActionDefinition,
	RoutingActionKind,
	RoutingError,
	RoutingSource,
} from './types';

const ACTION_KINDS: readonly RoutingActionKind[] = [
	'move',
	'set-frontmatter',
	'publish-contexts',
	'insert-template',
	'code',
];

// ---------------------------------------------------------------------------
// Frontmatter coercion helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Coerce a frontmatter value to a boolean, with a default for missing/empty. */
function asBool(value: unknown, fallback: boolean): boolean {
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') {
		const v = value.trim().toLowerCase();
		if (v === 'true') return true;
		if (v === 'false') return false;
	}
	return fallback;
}

/** Coerce a frontmatter value to a string array (accepts a single string). */
function asStringArray(value: unknown): string[] | null {
	if (Array.isArray(value)) {
		return value.map((v) => String(v)).filter((v) => v.trim() !== '');
	}
	const s = asString(value);
	return s ? [s] : null;
}

// ---------------------------------------------------------------------------
// Result discriminator
// ---------------------------------------------------------------------------

export type ParseActionResult = RoutingActionDefinition | RoutingError;

/** Shared error guard for both routing file parsers. */
export function isRoutingError<T extends object>(r: T | RoutingError): r is RoutingError {
	return 'message' in r;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse a routing-action Markdown file into a typed definition.
 *
 * @param content     - Raw Markdown file content.
 * @param frontmatter - Parsed frontmatter (from metadataCache or manual YAML).
 * @param filePath    - Vault-relative path (for error messages + filename tiebreak).
 * @param source      - Where the file came from (built-in scaffold vs vault dir).
 */
export function parseRoutingActionFile(
	content: string,
	frontmatter: Record<string, unknown>,
	filePath: string,
	source: RoutingSource,
): ParseActionResult {
	// -- cpn-type --
	const cpnType = frontmatter[RK.TYPE];
	if (!cpnType) {
		return { filePath, message: `Missing required frontmatter field '${RK.TYPE}'` };
	}
	if (cpnType !== 'routing-action') {
		return {
			filePath,
			message: `Invalid '${RK.TYPE}': '${String(cpnType)}'. Must be 'routing-action'`,
		};
	}

	// -- cpn-routing-action-name --
	const name = asString(frontmatter[RK.ACTION_NAME]);
	if (!name) {
		return { filePath, message: `Missing or empty '${RK.ACTION_NAME}'` };
	}

	// -- cpn-routing-action-kind --
	const kindRaw = asString(frontmatter[RK.ACTION_KIND]);
	if (!kindRaw || !ACTION_KINDS.includes(kindRaw as RoutingActionKind)) {
		return {
			filePath,
			message: `Invalid '${RK.ACTION_KIND}': '${String(frontmatter[RK.ACTION_KIND])}'. Must be one of ${ACTION_KINDS.join(', ')}`,
		};
	}
	const kind = kindRaw as RoutingActionKind;

	const def: RoutingActionDefinition = {
		name,
		kind,
		description: asString(frontmatter[RK.DESCRIPTION]) ?? undefined,
		newNoteOnly: asBool(frontmatter[RK.NEW_NOTE_ONLY], false),
		idempotent: asBool(frontmatter[RK.IDEMPOTENT], true),
		filePath,
		filename: filePath.split('/').pop() ?? filePath,
		source,
		isScaffold: source === 'built-in',
		compiledFn: null,
	};

	// -- kind-specific config --
	switch (kind) {
		case 'move': {
			// target dir is optional here — an option's step params may supply it.
			def.targetDir = asString(frontmatter[RK.TARGET_DIR]) ?? undefined;
			break;
		}
		case 'publish-contexts': {
			def.publishContexts = asStringArray(frontmatter[RK.PUBLISH_CONTEXTS]) ?? undefined;
			break;
		}
		case 'set-frontmatter': {
			const fm = frontmatter[RK.FRONTMATTER];
			if (fm !== undefined && (typeof fm !== 'object' || fm === null || Array.isArray(fm))) {
				return { filePath, message: `'${RK.FRONTMATTER}' must be a mapping (object)` };
			}
			def.frontmatter = (fm as Record<string, unknown>) ?? undefined;
			break;
		}
		case 'insert-template': {
			// Optional here — an option's step params may supply the template.
			// Stored raw (path or `[[wikilink]]`); resolved at run time.
			def.templatePath = asString(frontmatter[RK.TEMPLATE]) ?? undefined;
			break;
		}
		case 'code': {
			const rawCode = extractCodeFence(content);
			if (!rawCode) {
				return { filePath, message: "No TS/JS code fence found (expected a ```ts block)" };
			}
			def.rawCode = rawCode;
			break;
		}
	}

	return def;
}
