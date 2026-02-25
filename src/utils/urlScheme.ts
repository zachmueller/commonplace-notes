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