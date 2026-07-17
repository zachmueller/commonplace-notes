/**
 * Pure parsing + injection logic for site-asset customizations.
 *
 * No runtime `obsidian` import (this module is intentionally dependency-free so
 * it unit-tests under tsx, exactly like `src/utils/parser/parserFile.ts`). The
 * vault-facing discovery layer lives in `./discovery.ts`.
 */

import {
	AssetCustomization,
	AssetCustomizationError,
	AssetSlot,
	INDEX_HTML_SLOTS,
	SLOT_TO_ASSET,
	SLOT_TO_TOKEN,
} from './types';

// ---------------------------------------------------------------------------
// Fence extraction
// ---------------------------------------------------------------------------

/**
 * Extract the body of the first ```html / ```css / ```js / ```javascript fenced
 * block. Returns the inner text, or null if none/empty. Mirrors
 * `extractCodeFence` in `src/utils/parser/parserFile.ts`, widened to the snippet
 * languages (the fence language is a hint for the author's editor — it is not
 * validated against the slot, since e.g. a `head-extra` slot legitimately holds
 * an inline `<script>` authored in an ```html fence).
 */
export function extractSnippetFence(content: string): string | null {
	const regex = /^```(?:html|css|js|javascript)\s*\n([\s\S]*?)^```\s*$/gm;
	const match = regex.exec(content);
	if (!match) return null;
	const snippet = match[1] ?? '';
	if (snippet.trim() === '') return null;
	return snippet;
}

// ---------------------------------------------------------------------------
// Frontmatter helpers
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isAssetSlot(value: string): value is AssetSlot {
	return Object.prototype.hasOwnProperty.call(SLOT_TO_ASSET, value) === true;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export type ParseAssetResult = AssetCustomization | AssetCustomizationError;

function isError(r: ParseAssetResult): r is AssetCustomizationError {
	return 'message' in r;
}

export { isError as isAssetError };

/**
 * Parse an asset-customization Markdown note into a typed descriptor.
 *
 * @param content     - Raw Markdown file content.
 * @param frontmatter - Parsed frontmatter (from metadataCache or manual YAML).
 * @param filePath    - Vault-relative path (for errors + filename tiebreak).
 */
export function parseAssetCustomizationFile(
	content: string,
	frontmatter: Record<string, unknown>,
	filePath: string,
): ParseAssetResult {
	// -- cpn-type --
	const cpnType = frontmatter['cpn-type'];
	if (!cpnType) {
		return { filePath, message: "Missing required frontmatter field 'cpn-type'" };
	}
	if (cpnType !== 'asset') {
		return { filePath, message: `Invalid 'cpn-type': '${String(cpnType)}'. Must be 'asset'` };
	}

	// -- cpn-slot --
	const slotRaw = asString(frontmatter['cpn-slot']);
	if (!slotRaw) {
		return { filePath, message: "Missing or empty 'cpn-slot'" };
	}
	if (!isAssetSlot(slotRaw)) {
		const valid = Object.keys(SLOT_TO_ASSET).join(', ');
		return {
			filePath,
			message: `Invalid 'cpn-slot': '${slotRaw}'. Must be one of: ${valid}`,
		};
	}
	const slot = slotRaw;

	// -- snippet fence --
	const snippet = extractSnippetFence(content);
	if (snippet === null) {
		return {
			filePath,
			message: 'No snippet fence found (expected a ```html, ```css, or ```js block)',
		};
	}

	const filename = filePath.split('/').pop() ?? filePath;

	return {
		asset: SLOT_TO_ASSET[slot],
		slot,
		snippet,
		filePath,
		filename,
	};
}

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

/**
 * Concatenate all snippets targeting one slot, in filename-ascending order
 * (deterministic — matches the parser system's filename tiebreak). Joined with
 * a blank line so adjacent snippets stay visually separated in the output.
 */
function concatSlotSnippets(
	customizations: AssetCustomization[],
	slot: AssetSlot,
): string {
	return customizations
		.filter((c) => c.slot === slot)
		.sort((a, b) => a.filename.localeCompare(b.filename))
		.map((c) => c.snippet)
		.join('\n');
}

/**
 * Replace every index.html slot token with its concatenated snippets in a
 * SINGLE pass. Using a function replacement (rather than a literal string) is
 * deliberate and load-bearing:
 *   - `$`-safe: a literal replacement string would interpret `$&`, `$1`, etc.
 *     inside user snippets (e.g. a regex-heavy redirect shim) and corrupt them.
 *   - never re-scans injected content, so a snippet that itself contains a
 *     `{{...}}` string can't trigger a second substitution.
 *   - absent tokens simply don't match → no-op (tolerates a user/future route-1
 *     asset that removed a placeholder).
 */
export function applyIndexHtmlSlots(
	html: string,
	customizations: AssetCustomization[],
): string {
	// Build an alternation of just the index.html tokens (without the braces,
	// which are added by the pattern) so styles.css's EXTRA_CSS is never touched.
	const tokenNames = INDEX_HTML_SLOTS.map((slot) =>
		SLOT_TO_TOKEN[slot].replace(/[{}]/g, ''),
	);
	const tokenToSlot = new Map<string, AssetSlot>(
		INDEX_HTML_SLOTS.map((slot) => [SLOT_TO_TOKEN[slot].replace(/[{}]/g, ''), slot]),
	);
	const pattern = new RegExp(`\\{\\{(${tokenNames.join('|')})\\}\\}`, 'g');

	return html.replace(pattern, (_match, tokenName: string) => {
		const slot = tokenToSlot.get(tokenName);
		if (!slot) return '';
		return concatSlotSnippets(customizations, slot);
	});
}

/** Replace the styles.css `{{EXTRA_CSS}}` token with its concatenated snippets. */
export function applyStylesCssSlots(
	css: string,
	customizations: AssetCustomization[],
): string {
	return css.replace(/\{\{EXTRA_CSS\}\}/g, () =>
		concatSlotSnippets(customizations, 'extra-css'),
	);
}
