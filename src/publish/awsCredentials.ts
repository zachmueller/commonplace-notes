import { Notice } from 'obsidian';
import { execAsync } from '../utils/shell';
import type CommonplaceNotesPlugin from '../main';
import type { PublishingProfile } from '../types';
import { Logger } from '../utils/logging';

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

        new Notice('Refreshing AWS credentials');

        const commands = profile.awsSettings.credentialRefreshCommands
            .split('\n')
            .filter((cmd: string) => cmd.trim().length > 0)
            .map((cmd: string) => {
                // Replace variables in the command
                return cmd
                    .replace('${awsAccountId}', profile.awsSettings?.awsAccountId || '')
                    .replace('${awsProfile}', profile.awsSettings?.awsProfile || '');
            });

        for (const command of commands) {
            new Notice(`Executing: ${command}`);
            await execAsync(command);
        }

        new Notice('Successfully refreshed AWS credentials');
    } catch (error) {
        Logger.error('Failed to refresh credentials:', error);
        new Notice('Failed to refresh credentials: ' + (error as Error).message);
        throw error;
    }
}

export async function checkAwsCredentials() {
    try {
        const { stdout } = await execAsync('aws sts get-caller-identity --output json');
        return JSON.parse(stdout);
    } catch (error) {
        Logger.error('Failed to check AWS credentials:', error);
        throw error;
    }
}