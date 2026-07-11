/**
 * Parser for routing OPTION `.md` files (`cpn-type: routing-option`).
 *
 * Validates the `cpn-*` frontmatter and parses the `cpn-routing-steps` list into
 * `rawSteps` — one wikilink-plus-params string per step. Resolution of references
 * against the discovered action registry happens later, in the RoutingManager,
 * once every action is known.
 */

import { RK } from './frontmatterKeys';
import type {
	OnError,
	RawStep,
	RoutingError,
	RoutingOptionDefinition,
	RoutingSource,
	TitlePromptMode,
} from './types';

const ON_ERROR_VALUES: readonly OnError[] = ['abort', 'continue'];
const TITLE_PROMPT_VALUES: readonly TitlePromptMode[] = ['always', 'only-if-Untitled', 'off'];

/** Leading `[[action]]` wikilink of a step string; non-greedy so it stops at the action's own `]]`. */
const STEP_REF_RE = /^\s*\[\[(.+?)\]\]/;

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

// ---------------------------------------------------------------------------
// Result discriminator
// ---------------------------------------------------------------------------

export type ParseOptionResult = RoutingOptionDefinition | RoutingError;

// ---------------------------------------------------------------------------
// Step parsing
// ---------------------------------------------------------------------------

/**
 * Parse one `cpn-routing-steps` entry into a `RawStep`. Each entry is a single
 * string: a leading `[[action]]` wikilink, optionally followed by `key: value`
 * params. Multiple params are separated by `;`; a value containing `,` becomes a
 * list, otherwise a scalar string. Examples:
 *   - `"[[default-frontmatter]]"`
 *   - `"[[move]] dir: data"`
 *   - `"[[set-publish-contexts]] contexts: public, amazon"`
 *   - `"[[insert-template]] template: [[Meeting Note Template]]"`
 *
 * Returns a `RawStep`, or a string describing why the entry is invalid.
 */
function parseRawStep(entry: unknown): RawStep | string {
	if (typeof entry !== 'string') {
		const kind = Array.isArray(entry) ? 'a list' : typeof entry;
		return `Step must be a wikilink string like "[[action]] key: value"; got ${kind} (object/inline step syntax is no longer supported)`;
	}

	const trimmed = entry.trim();
	if (!trimmed) return 'Empty step';

	const m = trimmed.match(STEP_REF_RE);
	if (!m) return `Step must start with an action wikilink, e.g. "[[move]]": '${entry}'`;
	const ref = bareWikilinkName(`[[${m[1]}]]`);
	if (!ref) return `Empty action reference in step: '${entry}'`;

	const rest = trimmed.slice(m[0].length).trim();
	if (!rest) return { ref };

	const params: Record<string, unknown> = {};
	for (const seg of rest.split(';')) {
		const s = seg.trim();
		if (!s) continue; // tolerate a trailing/extra ';'
		const colon = s.indexOf(':'); // split on the FIRST colon; values may contain ':'
		if (colon === -1) return `Step param must be 'key: value': '${s}'`;
		const key = s.slice(0, colon).trim();
		if (!key) return `Step param has an empty key: '${s}'`;
		const rawVal = s.slice(colon + 1).trim();
		if (!rawVal) return `Step param '${key}' has an empty value`;
		params[key] = rawVal.includes(',')
			? rawVal.split(',').map((v) => v.trim()).filter((v) => v !== '')
			: rawVal;
	}
	return { ref, params };
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
	const cpnType = frontmatter[RK.TYPE];
	if (!cpnType) {
		return { filePath, message: `Missing required frontmatter field '${RK.TYPE}'` };
	}
	if (cpnType !== 'routing-option') {
		return {
			filePath,
			message: `Invalid '${RK.TYPE}': '${String(cpnType)}'. Must be 'routing-option'`,
		};
	}

	// -- cpn-routing-option-name --
	const name = asString(frontmatter[RK.OPTION_NAME]);
	if (!name) {
		return { filePath, message: `Missing or empty '${RK.OPTION_NAME}'` };
	}

	// -- cpn-routing-on-error --
	const onErrorRaw = asString(frontmatter[RK.ON_ERROR]);
	if (onErrorRaw && !ON_ERROR_VALUES.includes(onErrorRaw as OnError)) {
		return {
			filePath,
			message: `Invalid '${RK.ON_ERROR}': '${onErrorRaw}'. Must be 'abort' or 'continue'`,
		};
	}
	const onError = (onErrorRaw as OnError) ?? 'abort';

	// -- cpn-routing-title-prompt (optional override) --
	const titlePromptRaw = asString(frontmatter[RK.TITLE_PROMPT]);
	if (titlePromptRaw && !TITLE_PROMPT_VALUES.includes(titlePromptRaw as TitlePromptMode)) {
		return {
			filePath,
			message: `Invalid '${RK.TITLE_PROMPT}': '${titlePromptRaw}'. Must be one of ${TITLE_PROMPT_VALUES.join(', ')}`,
		};
	}
	const titlePrompt = (titlePromptRaw as TitlePromptMode) ?? undefined;

	// -- cpn-routing-steps --
	const stepsRaw = frontmatter[RK.STEPS];
	if (!Array.isArray(stepsRaw)) {
		return { filePath, message: `Missing or invalid '${RK.STEPS}' (must be a list)` };
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
		description: asString(frontmatter[RK.DESCRIPTION]) ?? undefined,
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
