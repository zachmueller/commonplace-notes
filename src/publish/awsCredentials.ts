import { execAsync } from '../utils/shell';
import type CommonplaceNotesPlugin from '../main';
import type { PublishingProfile } from '../types';
import { Logger } from '../utils/logging';
import { NoticeManager } from '../utils/notice';

export async function refreshCredentials(plugin: CommonplaceNotesPlugin, profileId: string) {
	try {
		const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
		if (!profile) {
			throw new Error('No valid publishing profile found');
		}

		if (profile.publishMechanism !== 'AWS CLI' || !profile.awsSettings) {
			throw new Error('Selected profile is not configured for AWS');
			// TODO::generalize credentials handling and build a better flow around this::
		}

		const commands = profile.awsSettings.credentialRefreshCommands
			.split('\n')
			.filter((cmd: string) => cmd.trim().length > 0)
			.map((cmd: string) => {
				// Replace variables in the command, including AWS CLI path
				return cmd
					.replace('${awsAccountId}', profile.awsSettings?.awsAccountId || '')
					.replace('${awsProfile}', profile.awsSettings?.awsProfile || '');
			});

		let {success, result, error} = await NoticeManager.showProgress(
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

		const awsCommand = plugin.awsCliManager.getAwsCliCommand(profileId);
		const cmd = `${awsCommand} sts get-caller-identity --output json --profile ${profile.awsSettings?.awsProfile}`;
		Logger.debug(`Executing: ${cmd}`);
		const { stdout } = await execAsync(cmd);
		return JSON.parse(stdout);
	} catch (error) {
		Logger.error('Failed to check AWS credentials:', error);
		throw error;
	}
}