import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { execWithAwsEnv } from '../utils/shell';
import { resolveProfileCredentials } from '../utils/awsCredentialChain';
import { ssoLogin, SsoLoginUnavailableError } from '../utils/ssoLogin';
import type CommonplaceNotesPlugin from '../main';
import type { AWSProfileSettings } from '../types';
import { Logger } from '../utils/logging';
import { NoticeManager } from '../utils/notice';

export async function refreshCredentials(plugin: CommonplaceNotesPlugin, profileId: string) {
	try {
		const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
		if (!profile) {
			throw new Error('No valid publishing profile found');
		}

		if (profile.publishMechanism !== 'AWS' || !profile.awsSettings) {
			throw new Error('Selected profile is not configured for AWS');
		}
		const awsSettings = profile.awsSettings;

		// Invalidate cached clients FIRST so no stale client with memoized expired
		// credentials survives — this covers the SDK client caches and the
		// CloudFormationManager's own caches (deploys, stack updates, the
		// "Sync callback URL" button).
		plugin.awsSdkManager.invalidateClients(profileId);
		plugin.cloudFormationManager.invalidateClients(profileId, awsSettings.awsProfile);

		if (awsSettings.credentialMode === 'custom-command') {
			await runCustomCommands(awsSettings);
			return;
		}

		// SDK mode: actively resolve credentials. A successful resolve also
		// triggers the SDK's silent SSO refresh-token renewal (rewriting the token
		// cache) when the cached token has merely aged out.
		await refreshViaSdk(awsSettings);
	} catch (error) {
		Logger.error('Failed to refresh credentials:', error);
		NoticeManager.showNotice('Failed to refresh credentials: ' + (error as Error).message);
		throw error;
	}
}

async function runCustomCommands(awsSettings: AWSProfileSettings): Promise<void> {
	const commands = awsSettings.credentialRefreshCommands
		.split('\n')
		.filter((cmd: string) => cmd.trim().length > 0)
		.map((cmd: string) => {
			return cmd
				.replace('${awsAccountId}', awsSettings.awsAccountId || '')
				.replace('${awsProfile}', awsSettings.awsProfile || '');
		});

	const { success, error } = await NoticeManager.showProgress(
		`Refreshing AWS credentials`,
		(async () => {
			for (const command of commands) {
				Logger.debug(`Executing: ${command}`);
				await execWithAwsEnv(command, awsSettings.awsCliPath);
			}
		})(),
		`Successfully refreshed AWS credentials`
	);

	if (!success) {
		throw error;
	}
}

async function refreshViaSdk(awsSettings: AWSProfileSettings): Promise<void> {
	const awsProfile = awsSettings.awsProfile;

	const initial = await resolveProfileCredentials(awsProfile);
	if (initial.ok) {
		NoticeManager.showNotice('✓ AWS credentials are valid');
		return;
	}

	// Only an expired/invalid SSO session is recoverable here. Other failures
	// (missing profile, config typo) surface the actionable underlying error.
	if (!initial.expiredSso) {
		throw initial.error;
	}

	// Try SDK-native SSO login (no CLI dependency), falling back to the `aws` CLI.
	try {
		await ssoLogin(awsProfile);
	} catch (err) {
		if (err instanceof SsoLoginUnavailableError) {
			Logger.debug(`SDK-native SSO login unavailable: ${err.message}. Falling back to the aws CLI.`);
			await refreshViaCli(awsSettings);
		} else {
			throw err;
		}
	}

	// Confirm the login actually produced usable credentials.
	const confirmed = await resolveProfileCredentials(awsProfile);
	if (!confirmed.ok) {
		throw confirmed.error;
	}
	NoticeManager.showNotice('✓ AWS credentials refreshed');
}

async function refreshViaCli(awsSettings: AWSProfileSettings): Promise<void> {
	const cliPath = awsSettings.awsCliPath?.trim();
	const awsBinary = cliPath && cliPath.length > 0 ? cliPath : 'aws';
	const command = `${awsBinary} sso login --profile ${awsSettings.awsProfile}`;

	const { success, error } = await NoticeManager.showProgress(
		`Refreshing AWS credentials via aws CLI`,
		(async () => {
			Logger.debug(`Executing: ${command}`);
			await execWithAwsEnv(command, cliPath);
		})(),
		`Successfully refreshed AWS credentials`
	);

	if (!success) {
		throw error;
	}
}

export async function checkAwsCredentials(plugin: CommonplaceNotesPlugin, profileId: string) {
	try {
		const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
		if (!profile) {
			throw new Error('No valid publishing profile found');
		}

		const stsClient = plugin.awsSdkManager.getSTSClient(profile);
		const response = await stsClient.send(new GetCallerIdentityCommand({}));
		Logger.debug(`AWS identity verified: ${response.Arn}`);
		return {
			Account: response.Account,
			Arn: response.Arn,
			UserId: response.UserId,
		};
	} catch (error) {
		Logger.error('Failed to check AWS credentials:', error);
		throw error;
	}
}
