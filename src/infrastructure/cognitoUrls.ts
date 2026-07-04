/**
 * Helpers for the Cognito Hosted UI / Google OAuth URLs that a user must
 * register in their Google Cloud OAuth client. All three surfaces that show
 * these URLs (the wizard's pre-deploy hint, its completion screen, and the
 * Settings → Infrastructure section) go through here so they never drift.
 *
 * The Hosted UI domain is deterministic from the chosen auth-domain prefix and
 * the deploy region, so the redirect URI can be shown *before* deploy — letting
 * the user pre-register it in Google (sign-in fails until Google trusts it).
 */

/**
 * The Cognito Hosted UI origin: `https://<prefix>.auth.<region>.amazoncognito.com`.
 * Returns undefined when the prefix or region is not yet known.
 */
export function cognitoHostedUiDomain(
	prefix: string | undefined,
	region: string | undefined,
): string | undefined {
	if (!prefix || !region) return undefined;
	return `https://${prefix}.auth.${region}.amazoncognito.com`;
}

/** The Google OAuth client values derived from a Cognito Hosted UI domain. */
export interface GoogleOAuthUrls {
	/** "Authorized JavaScript origin" — the bare Hosted UI origin. */
	jsOrigin: string;
	/** "Authorized redirect URI" — the origin plus `/oauth2/idpresponse`. */
	redirectUri: string;
}

/**
 * Derive the Google OAuth "Authorized JavaScript origin" and "Authorized
 * redirect URI" from a Cognito Hosted UI domain. Tolerates a trailing slash.
 */
export function googleOAuthUrls(hostedUiDomain: string): GoogleOAuthUrls {
	const jsOrigin = hostedUiDomain.replace(/\/+$/, '');
	return {
		jsOrigin,
		redirectUri: `${jsOrigin}/oauth2/idpresponse`,
	};
}
