/**
 * Centralized URL formatting for note links.
 *
 * - 'current' scheme:  #/{type}{value}  (slash-delimited, no `=`)
 * - 'original' scheme: #{type}={value}  (ampersand-delimited, `=` separator)
 *
 * The scheme setting only controls **output**. Parsing always accepts both formats.
 */

export type UrlScheme = 'current' | 'original';

/**
 * Build a fragment URL for a single note parameter.
 *
 * @param type    Parameter type character (e.g. 'u', 'p', '~')
 * @param value   Raw (unencoded) parameter value
 * @param scheme  Which URL scheme to produce
 * @returns       A string such as `#/uABC123` or `#u=ABC123`
 */
export function formatNoteUrl(type: string, value: string, scheme: UrlScheme): string {
	if (scheme === 'original') {
		return `#${type}=${encodeURIComponent(value)}`;
	}
	// 'current' scheme
	return `#/${type}${encodeURIComponent(value)}`;
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
 * @param segments  Ordered list of `{ type, value }` parameter pairs (raw values)
 * @param scheme    Which URL scheme to produce
 * @returns         A string such as `#/uA/uB`, or null when scheme is 'original'
 */
export function formatNoteStackUrl(
	segments: Array<{ type: string; value: string }>,
	scheme: UrlScheme
): string | null {
	if (scheme !== 'current') return null;
	if (segments.length === 0) return '#/';
	return '#' + segments.map(s => `/${s.type}${encodeURIComponent(s.value)}`).join('');
}