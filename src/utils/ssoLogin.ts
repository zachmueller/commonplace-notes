import { promises as fs } from 'fs';
import {
	SSOOIDCClient,
	RegisterClientCommand,
	StartDeviceAuthorizationCommand,
	CreateTokenCommand,
} from '@aws-sdk/client-sso-oidc';
import {
	parseKnownFiles,
	loadSsoSessionData,
	getSSOTokenFilepath,
} from '@smithy/shared-ini-file-loader';
import { Logger } from './logging';
import { NoticeManager } from './notice';

/**
 * Error thrown when the profile can't be logged in via the SDK-native flow —
 * usually because it has no modern `sso_session` block. The caller catches this
 * to fall back to the `aws` CLI.
 */
export class SsoLoginUnavailableError extends Error {}

interface ResolvedSsoConfig {
	ssoSessionName: string;
	startUrl: string;
	region: string;
}

/**
 * Read the profile's SSO configuration from the shared config file. Mirrors the
 * resolution the SDK's `fromSso` token provider performs (profile ->
 * `sso_session` -> `sso_start_url`/`sso_region`), so the token we write lands in
 * the exact cache slot `fromSSO` reads.
 */
async function resolveSsoConfig(awsProfile: string): Promise<ResolvedSsoConfig> {
	const profiles = await parseKnownFiles({});
	const profile = profiles[awsProfile];
	if (!profile) {
		throw new SsoLoginUnavailableError(`Profile '${awsProfile}' could not be found in the AWS config file.`);
	}
	const ssoSessionName = profile['sso_session'];
	if (!ssoSessionName) {
		throw new SsoLoginUnavailableError(
			`Profile '${awsProfile}' has no 'sso_session' — SDK-native SSO login requires a modern sso-session config block.`
		);
	}

	const ssoSessions = await loadSsoSessionData({});
	const ssoSession = ssoSessions[ssoSessionName];
	if (!ssoSession) {
		throw new SsoLoginUnavailableError(`SSO session '${ssoSessionName}' could not be found in the AWS config file.`);
	}
	const startUrl = ssoSession['sso_start_url'];
	const region = ssoSession['sso_region'];
	if (!startUrl || !region) {
		throw new SsoLoginUnavailableError(
			`SSO session '${ssoSessionName}' is missing 'sso_start_url' or 'sso_region'.`
		);
	}

	return { ssoSessionName, startUrl, region };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Perform an interactive AWS SSO login entirely through the SDK — no `aws` CLI
 * required. Runs the OIDC device-authorization flow (register client -> start
 * device authorization -> open the browser -> poll for the token) and writes
 * the resulting token to `~/.aws/sso/cache/<sha1(sso_session)>.json` in the
 * exact shape `@aws-sdk/token-providers`' `fromSso` expects, so subsequent
 * `fromSSO` credential resolution picks it up.
 *
 * Throws `SsoLoginUnavailableError` when the profile can't be logged in this way
 * (e.g. no `sso_session` block), letting the caller fall back to the CLI.
 */
export async function ssoLogin(awsProfile: string): Promise<void> {
	const { ssoSessionName, startUrl, region } = await resolveSsoConfig(awsProfile);

	const client = new SSOOIDCClient({ region });
	try {
		const registered = await client.send(
			new RegisterClientCommand({
				clientName: `commonplace-notes-${awsProfile}`,
				clientType: 'public',
				scopes: ['sso:account:access'],
			})
		);
		const { clientId, clientSecret } = registered;
		if (!clientId || !clientSecret) {
			throw new Error('SSO OIDC RegisterClient did not return client credentials.');
		}

		const deviceAuth = await client.send(
			new StartDeviceAuthorizationCommand({ clientId, clientSecret, startUrl })
		);
		const { deviceCode, userCode, verificationUriComplete, verificationUri, expiresIn } = deviceAuth;
		if (!deviceCode || !verificationUriComplete) {
			throw new Error('SSO OIDC StartDeviceAuthorization did not return a device code / verification URL.');
		}

		// Open the browser for the user to approve. `electron` is bundled as an
		// external, so importing it here is safe in the Obsidian desktop app.
		await openVerificationUrl(verificationUriComplete);
		const prompt = NoticeManager.showNotice(
			`Complete AWS SSO sign-in in your browser` +
				(userCode ? ` (code: ${userCode})` : '') +
				(verificationUri ? `\n${verificationUri}` : ''),
			0
		);

		try {
			// Poll until the user approves, the request expires, or we exhaust the window.
			let interval = Math.max(deviceAuth.interval ?? 5, 1);
			const deadline = Date.now() + (expiresIn ?? 600) * 1000;
			while (Date.now() < deadline) {
				await sleep(interval * 1000);
				try {
					const token = await client.send(
						new CreateTokenCommand({
							clientId,
							clientSecret,
							grantType: 'urn:ietf:params:oauth:grant-type:device_code',
							deviceCode,
						})
					);
					if (!token.accessToken || token.expiresIn == null) {
						throw new Error('SSO OIDC CreateToken returned an incomplete token.');
					}
					await writeTokenCache(ssoSessionName, {
						accessToken: token.accessToken,
						expiresAt: new Date(Date.now() + token.expiresIn * 1000).toISOString(),
						refreshToken: token.refreshToken,
						clientId,
						clientSecret,
						region,
						startUrl,
					});
					Logger.debug(`SSO login succeeded for profile '${awsProfile}' (session '${ssoSessionName}').`);
					return;
				} catch (err) {
					const name = (err as Error)?.name || '';
					if (name === 'AuthorizationPendingException') {
						continue; // user hasn't approved yet
					}
					if (name === 'SlowDownException') {
						interval += 5;
						continue;
					}
					throw err;
				}
			}

			throw new Error('AWS SSO login timed out before it was approved.');
		} finally {
			prompt.hide();
		}
	} finally {
		client.destroy();
	}
}

interface SsoTokenCacheFile {
	accessToken: string;
	expiresAt: string;
	refreshToken?: string;
	clientId: string;
	clientSecret: string;
	region: string;
	startUrl: string;
}

/**
 * Write the SSO token to the SDK's cache location. Reuses `getSSOTokenFilepath`
 * so the sha1-of-session-name filename never drifts from what `fromSso` reads.
 */
async function writeTokenCache(ssoSessionName: string, token: SsoTokenCacheFile): Promise<void> {
	const filepath = getSSOTokenFilepath(ssoSessionName);
	await fs.writeFile(filepath, JSON.stringify(token, null, 2));
}

async function openVerificationUrl(url: string): Promise<void> {
	try {
		// Obsidian desktop runs on Electron; `shell.openExternal` opens the
		// system browser. Imported lazily so a missing module never breaks load.
		const { shell } = require('electron');
		await shell.openExternal(url);
	} catch (err) {
		Logger.warn('Could not open browser automatically for SSO login:', err);
		// The notice still shows the verification URL for manual navigation.
	}
}
