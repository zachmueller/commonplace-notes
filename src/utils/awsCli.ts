import CommonplaceNotesPlugin from '../main';
import { PublishingProfile } from '../types';
import { Logger } from './logging';

export class AwsCliManager {
	private plugin: CommonplaceNotesPlugin;

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
	}

	/**
	 * Get the AWS CLI command to use for a given profile
	 * @param profileId - The profile ID to get AWS CLI path for
	 * @returns The AWS CLI command (either custom path or default "aws")
	 */
	getAwsCliCommand(profileId: string): string {
		const profile = this.plugin.settings.publishingProfiles.find(p => p.id === profileId);

		if (!profile || !profile.awsSettings) {
			Logger.debug(`No AWS settings found for profile ${profileId}, using default 'aws' command`);
			return 'aws';
		}

		const customPath = profile.awsSettings.awsCliPath;

		if (customPath && customPath.trim()) {
			Logger.debug(`Using custom AWS CLI path for profile ${profileId}: ${customPath}`);
			return customPath.trim();
		}

		Logger.debug(`Using default 'aws' command for profile ${profileId}`);
		return 'aws';
	}

	/**
	 * Get the AWS CLI command for a given profile object
	 * @param profile - The profile object
	 * @returns The AWS CLI command (either custom path or default "aws")
	 */
	getAwsCliCommandFromProfile(profile: PublishingProfile): string {
		const customPath = profile.awsSettings?.awsCliPath;

		if (customPath && customPath.trim()) {
			Logger.debug(`Using custom AWS CLI path: ${customPath}`);
			return customPath.trim();
		}

		Logger.debug(`Using default 'aws' command`);
		return 'aws';
	}
}