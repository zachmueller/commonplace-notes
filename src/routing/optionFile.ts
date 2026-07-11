/**
 * Parser for routing OPTION `.md` files (`cpn-type: routing-option`).
 *
 * Validates the `cpn-*` frontmatter and parses the hybrid `cpn-steps` list into
 * `rawSteps` (wikilink references and/or inline action specs). Resolution of
 * references against the discovered action registry happens later, in the
 * RoutingManager, once every action is known.
 */

import type {
	InlineActionSpec,
	OnError,
	RawStep,
	RoutingActionKind,
	RoutingError,
	RoutingOptionDefinition,
	RoutingSource,
	TitlePromptMode,
} from './types';

const ON_ERROR_VALUES: readonly OnError[] = ['abort', 'continue'];
const TITLE_PROMPT_VALUES: readonly TitlePromptMode[] = ['always', 'only-if-Untitled', 'off'];
const ACTION_KINDS: readonly RoutingActionKind[] = [
	'move',
	'set-frontmatter',
	'publish-contexts',
	'code',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Strip `[[ ]]`, a `|alias`, and a `#heading`/`^block` from a wikilink to get the bare name. */
export function bareWikilinkName(raw: string): string {
	let s = raw.trim();
	const m = s.match(/^\[\[([^\]]+)\]\]$/);
	if (m) s = m[1];
	// Drop alias (after `|`) and any heading/block anchor (after `#`).
	s = s.split('|')[0];
	s = s.split('#')[0];
	// A vault path reference — keep just the basename.
	s = s.split('/').pop() ?? s;
	return s.trim();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Result discriminator
// ---------------------------------------------------------------------------

export type ParseOptionResult = RoutingOptionDefinition | RoutingError;

// ---------------------------------------------------------------------------
// Step parsing
// ---------------------------------------------------------------------------

/**
 * Parse one `cpn-steps` entry into a `RawStep`. Accepted authoring shapes:
 *   - a bare wikilink string:      `"[[move]]"`
 *   - a ref with params (map):     `{ action: "[[move]]", params: { dir: "x" } }`
 *   - an inline action (map):      `{ inline: { kind: "set-frontmatter", ... } }`
 *
 * Returns a `RawStep`, or a string describing why the entry is invalid.
 */
function parseRawStep(entry: unknown): RawStep | string {
	// Bare wikilink string.
	if (typeof entry === 'string') {
		const name = bareWikilinkName(entry);
		return name ? { ref: name } : `Empty step reference: '${entry}'`;
	}

	if (!isPlainObject(entry)) {
		return `Step must be a wikilink string or a mapping; got ${typeof entry}`;
	}

	// Inline action.
	if ('inline' in entry) {
		const inline = entry['inline'];
		if (!isPlainObject(inline)) return "Inline step 'inline' must be a mapping";
		const kind = asString(inline['kind']);
		if (!kind || !ACTION_KINDS.includes(kind as RoutingActionKind)) {
			return `Inline step has invalid 'kind': '${String(inline['kind'])}'`;
		}
		const spec: InlineActionSpec = {
			kind: kind as RoutingActionKind,
			name: asString(inline['name']) ?? undefined,
			description: asString(inline['description']) ?? undefined,
			newNoteOnly: typeof inline['newNoteOnly'] === 'boolean' ? inline['newNoteOnly'] : undefined,
			idempotent: typeof inline['idempotent'] === 'boolean' ? inline['idempotent'] : undefined,
			targetDir: asString(inline['targetDir']) ?? undefined,
			publishContexts: Array.isArray(inline['contexts'])
				? (inline['contexts'] as unknown[]).map(String)
				: Array.isArray(inline['publishContexts'])
					? (inline['publishContexts'] as unknown[]).map(String)
					: undefined,
			frontmatter: isPlainObject(inline['frontmatter'])
				? (inline['frontmatter'] as Record<string, unknown>)
				: undefined,
			code: asString(inline['code']) ?? undefined,
		};
		return { inline: spec };
	}

	// Ref with params.
	const actionRef = asString(entry['action']) ?? asString(entry['ref']);
	if (!actionRef) {
		return "Step mapping must have an 'action' (wikilink) or be an 'inline' spec";
	}
	const name = bareWikilinkName(actionRef);
	if (!name) return `Empty step reference: '${actionRef}'`;
	const params = isPlainObject(entry['params'])
		? (entry['params'] as Record<string, unknown>)
		: undefined;
	return { ref: name, params };
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse a routing-option Markdown file into a typed definition (steps unresolved).
 */
export function parseRoutingOptionFile(
	content: string,
	frontmatter: Record<string, unknown>,
	filePath: string,
	source: RoutingSource,
): ParseOptionResult {
	// -- cpn-type --
	const cpnType = frontmatter['cpn-type'];
	if (!cpnType) {
		return { filePath, message: "Missing required frontmatter field 'cpn-type'" };
	}
	if (cpnType !== 'routing-option') {
		return {
			filePath,
			message: `Invalid 'cpn-type': '${String(cpnType)}'. Must be 'routing-option'`,
		};
	}

	// -- cpn-option-name --
	const name = asString(frontmatter['cpn-option-name']);
	if (!name) {
		return { filePath, message: "Missing or empty 'cpn-option-name'" };
	}

	// -- cpn-on-error --
	const onErrorRaw = asString(frontmatter['cpn-on-error']);
	if (onErrorRaw && !ON_ERROR_VALUES.includes(onErrorRaw as OnError)) {
		return {
			filePath,
			message: `Invalid 'cpn-on-error': '${onErrorRaw}'. Must be 'abort' or 'continue'`,
		};
	}
	const onError = (onErrorRaw as OnError) ?? 'abort';

	// -- cpn-title-prompt (optional override) --
	const titlePromptRaw = asString(frontmatter['cpn-title-prompt']);
	if (titlePromptRaw && !TITLE_PROMPT_VALUES.includes(titlePromptRaw as TitlePromptMode)) {
		return {
			filePath,
			message: `Invalid 'cpn-title-prompt': '${titlePromptRaw}'. Must be one of ${TITLE_PROMPT_VALUES.join(', ')}`,
		};
	}
	const titlePrompt = (titlePromptRaw as TitlePromptMode) ?? undefined;

	// -- cpn-steps --
	const stepsRaw = frontmatter['cpn-steps'];
	if (!Array.isArray(stepsRaw)) {
		return { filePath, message: "Missing or invalid 'cpn-steps' (must be a list)" };
	}
	const rawSteps: RawStep[] = [];
	for (let i = 0; i < stepsRaw.length; i++) {
		const parsed = parseRawStep(stepsRaw[i]);
		if (typeof parsed === 'string') {
			return { filePath, message: `Step ${i + 1}: ${parsed}` };
		}
		rawSteps.push(parsed);
	}

	return {
		name,
		description: asString(frontmatter['cpn-description']) ?? undefined,
		onError,
		titlePrompt,
		steps: [],
		rawSteps,
		degraded: false,
		filePath,
		filename: filePath.split('/').pop() ?? filePath,
		source,
		isScaffold: source === 'built-in',
	};
}
