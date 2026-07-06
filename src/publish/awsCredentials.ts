import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { execAsync } from '../utils/shell';
import type CommonplaceNotesPlugin from '../main';
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

		if (profile.awsSettings.credentialMode === 'custom-command') {
			const commands = profile.awsSettings.credentialRefreshCommands
				.split('\n')
				.filter((cmd: string) => cmd.trim().length > 0)
				.map((cmd: string) => {
					return cmd
						.replace('${awsAccountId}', profile.awsSettings?.awsAccountId || '')
						.replace('${awsProfile}', profile.awsSettings?.awsProfile || '');
				});

			const { success, error } = await NoticeManager.showProgress(
				`Refreshing AWS credentials`,
				(async () => {
					for (const command of commands) {
						Logger.debug(`Executing: ${command}`);
						await execAsync(command);
					}
				})(),
				`Successfully refreshed AWS credentials`
			);

			if (!success) {
				throw error;
			}
		}

		plugin.awsSdkManager.invalidateClients(profileId);
		// CloudFormationManager keeps its OWN client caches (deploys, stack updates,
		// the "Sync callback URL" button) — invalidate those too, or a stale client
		// with memoized expired credentials survives the refresh.
		plugin.cloudFormationManager.invalidateClients(profileId, profile.awsSettings.awsProfile);
	} catch (error) {
		Logger.error('Failed to refresh credentials:', error);
		NoticeManager.showNotice('Failed to refresh credentials: ' + (error as Error).message);
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
