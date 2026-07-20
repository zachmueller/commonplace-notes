/**
 * Centralized URL formatting for note links.
 *
 * - 'current' scheme:  #/{type}{value}  (slash-delimited, no `=`)
 * - 'original' scheme: #{type}={value}  (ampersand-delimited, `=` separator)
 *
 * The leading `{type}` is a single-char code the site's `resolveHash()` switches on:
 * `u` = cpn-uid, `p` = permanent content-hash, and `~` = title/slug (the canonical
 * human-readable form). An inbound `t` is accepted as a title code too but is
 * normalized to `~` on parse, so the address bar always shows `~` for title links.
 *
 * The scheme setting only controls **output**. Parsing always accepts both formats.
 */

export type UrlScheme = 'current' | 'original';

/** Per-note parameters carried in a segment as `;key=value` pairs. */
export type NoteParams = Record<string, string | number>;

/**
 * Serialize per-note parameters into a `;key=value` suffix, e.g. `;width=800`.
 *
 * Symmetry contract — must agree with the published site's `parseURLFragment()`
 * and `serializeParams()` (in siteAssets.ts / index.html): values are
 * `encodeURIComponent`-encoded so a value containing the reserved `;` or `=`
 * can't corrupt the structure, key/value split on the first `=`, and keys are
 * emitted in stable alphabetical order so URLs are deterministic.
 *
 * @param params  Per-note parameters (omit/empty → returns '')
 * @returns       A string such as `;width=800`, or '' when there are no params
 */
export function serializeParams(params?: NoteParams): string {
	if (!params) return '';
	return Object.keys(params).sort().map(k =>
		`;${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`
	).join('');
}

/**
 * Build a fragment URL for a single note parameter.
 *
 * Per-note `params` only apply to the 'current' (slash) scheme; the 'original'
 * (`#type=value`) scheme does not compose per-note state and ignores them.
 *
 * @param type    Parameter type character (e.g. 'u', 'p', '~')
 * @param value   Raw (unencoded) parameter value
 * @param scheme  Which URL scheme to produce
 * @param params  Optional per-note parameters (current scheme only)
 * @returns       A string such as `#/uABC123`, `#/uABC123;width=800`, or `#u=ABC123`
 */
export function formatNoteUrl(type: string, value: string, scheme: UrlScheme, params?: NoteParams): string {
	if (scheme === 'original') {
		return `#${type}=${encodeURIComponent(value)}`;
	}
	// 'current' scheme
	return `#/${type}${encodeURIComponent(value)}${serializeParams(params)}`;
}

/**
 * Join multiple parameter segments into one 'current'-scheme fragment, e.g. "#/uA/uB".
 *
 * Stacking is only supported under the 'current' (slash) scheme — the 'original'
 * (`#type=value`) scheme does not compose into a multi-segment stack — so this
 * returns null for 'original', letting callers fall back to single-note behavior.
 *
 * A single segment produces `#/uUID`, identical to `formatNoteUrl('u', uid, 'current')`,
 * preserving backward compatibility with the legacy single-note URL. The segment
 * format mirrors the published site's `updateURL()` exactly so the emitted stack
 * is parsed correctly by the site's `parseURLFragment()`.
 *
 * Each segment may carry optional per-note `params` serialized as `;key=value`
 * suffixes (e.g. `#/uA;width=800/uB`), symmetric with the site's parser.
 *
 * @param segments  Ordered list of `{ type, value, params? }` pairs (raw values)
 * @param scheme    Which URL scheme to produce
 * @returns         A string such as `#/uA/uB`, or null when scheme is 'original'
 */
export function formatNoteStackUrl(
	segments: Array<{ type: string; value: string; params?: NoteParams }>,
	scheme: UrlScheme
): string | null {
	if (scheme !== 'current') return null;
	if (segments.length === 0) return '#/';
	return '#' + segments.map(s => `/${s.type}${encodeURIComponent(s.value)}${serializeParams(s.params)}`).join('');
}