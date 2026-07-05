/**
 * Types for per-profile site-asset customization (route 2: snippet injection).
 *
 * Users author snippets as `.md` notes under
 * `{cpnDir}/profiles/{profileId}/assets/`. Each note declares a target slot in
 * frontmatter (`cpn-slot`) and carries a single fenced code block whose body is
 * injected verbatim into a `{{SLOT}}` placeholder baked into the built-in
 * template (see `infrastructure/bin/synth-site-assets.ts`).
 *
 * Modeled on the parser-extension types at `src/utils/parser/types.ts`; kept
 * colocated with the asset-customization module rather than in the global
 * `src/types.ts`, matching that precedent.
 */

/** Assets that accept snippet injection. `config.json` is excluded — raw text
 *  would break its JSON parsing; it stays fully structured in `renderConfigJson`. */
export type AssetTarget = 'index.html' | 'styles.css';

/** The named injection points. Each maps to one `{{TOKEN}}` in a template. */
export type AssetSlot =
	| 'head-extra'
	| 'body-end-scripts'
	| 'header-extra-html'
	| 'footer-html'
	| 'extra-css';

/** Which asset each slot injects into. Also the set of valid `cpn-slot` values. */
export const SLOT_TO_ASSET: Record<AssetSlot, AssetTarget> = {
	'head-extra': 'index.html',
	'body-end-scripts': 'index.html',
	'header-extra-html': 'index.html',
	'footer-html': 'index.html',
	'extra-css': 'styles.css',
};

/** The `{{TOKEN}}` placeholder each slot's snippet replaces in its asset. */
export const SLOT_TO_TOKEN: Record<AssetSlot, string> = {
	'head-extra': '{{HEAD_EXTRA}}',
	'body-end-scripts': '{{BODY_END_SCRIPTS}}',
	'header-extra-html': '{{HEADER_EXTRA_HTML}}',
	'footer-html': '{{FOOTER_HTML}}',
	'extra-css': '{{EXTRA_CSS}}',
};

/** All slots that target the index.html asset (used by the single-pass replacer). */
export const INDEX_HTML_SLOTS: AssetSlot[] = (
	Object.keys(SLOT_TO_ASSET) as AssetSlot[]
).filter((slot) => SLOT_TO_ASSET[slot] === 'index.html');

/** A discovered snippet, parsed from one asset-customization note. */
export interface AssetCustomization {
	/** Target asset, derived from {@link slot} via {@link SLOT_TO_ASSET}. */
	asset: AssetTarget;
	/** Injection point (`cpn-slot`). */
	slot: AssetSlot;
	/** Raw fenced-block body, injected verbatim (not escaped/sanitized). */
	snippet: string;
	/** Vault-relative file path (for error messages + filename tiebreak). */
	filePath: string;
	/** Filename component — tiebreaker for concatenation order within a slot. */
	filename: string;
}

/** A non-fatal problem encountered while loading a customization note. */
export interface AssetCustomizationError {
	filePath: string;
	message: string;
}
