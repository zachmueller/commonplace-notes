import { fromEnv, fromIni, fromSSO } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentityProvider } from '@smithy/types';

/**
 * Build a credential provider that walks the standard chain for a named AWS
 * profile: environment variables, then the shared credentials/config file, then
 * SSO. The first provider that resolves wins.
 *
 * Shared by AwsSdkManager and CloudFormationManager so the two never drift.
 *
 * Unlike a naive `catch {}` loop, this captures each provider's error and, when
 * the whole chain fails, throws with the *real* underlying cause (the last, most
 * relevant error — usually SSO) instead of a generic "no credentials" message.
 * When the cause looks like an expired/invalid SSO session it appends actionable
 * guidance, because that is the common failure (e.g. switching between two SSO
 * sessions on the same Identity Center invalidates the other's token).
 */
export function buildProfileCredentialProvider(awsProfile: string): AwsCredentialIdentityProvider {
	const providers: AwsCredentialIdentityProvider[] = [
		fromEnv(),
		fromIni({ profile: awsProfile }),
		fromSSO({ profile: awsProfile }),
	];

	return async (identityProperties?: Record<string, unknown>) => {
		let lastError: unknown;
		for (const provider of providers) {
			try {
				return await provider(identityProperties);
			} catch (err) {
				lastError = err;
				// Fall through to next provider
			}
		}

		const cause = lastError instanceof Error
			? (lastError.name ? `${lastError.name}: ${lastError.message}` : lastError.message)
			: String(lastError);

		let message =
			`No valid AWS credentials found for profile "${awsProfile}". ` +
			`Checked: environment variables, shared credentials file, SSO. ` +
			`Last error — ${cause}`;

		if (looksLikeExpiredSso(lastError)) {
			message +=
				`. Your SSO session for "${awsProfile}" looks expired or invalid — ` +
				`run \`aws sso login --profile ${awsProfile}\` in a terminal, then run ` +
				`the "Refresh credentials" command.`;
		}

		throw new Error(message);
	};
}

/**
 * Result of attempting to resolve credentials for a profile.
 * `expiredSso` distinguishes the "SSO session needs re-login" case (which the
 * caller can recover from by triggering a login) from other failures.
 */
export type CredentialResolution =
	| { ok: true }
	| { ok: false; expiredSso: boolean; error: Error };

/**
 * Actively resolve credentials for a profile by invoking the standard chain
 * once. On success this also triggers the SDK's silent SSO refresh-token
 * renewal (and rewrites the token cache) when the cached token has merely aged
 * out. On failure it reports whether the cause looks like an expired/invalid
 * SSO session so the caller can decide whether to trigger a re-login.
 */
export async function resolveProfileCredentials(awsProfile: string): Promise<CredentialResolution> {
	try {
		await buildProfileCredentialProvider(awsProfile)();
		return { ok: true };
	} catch (err) {
		const error = err instanceof Error ? err : new Error(String(err));
		return { ok: false, expiredSso: looksLikeExpiredSso(err), error };
	}
}

/**
 * Heuristic: does this error indicate an expired/invalid SSO token (as opposed
 * to a missing profile or a config typo)? Covers the SSO service's typical
 * rejections and any "token"-mentioning message.
 */
export function looksLikeExpiredSso(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const haystack = `${err.name} ${err.message}`.toLowerCase();
	return (
		haystack.includes('unauthorizedexception') ||
		haystack.includes('forbiddenexception') ||
		haystack.includes('token') ||
		haystack.includes('sso session') ||
		haystack.includes('expired')
	);
}
