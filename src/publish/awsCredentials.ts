import { Notice } from 'obsidian';
import { execAsync } from '../utils/shell';
import type CommonplaceNotesPublisherPlugin from '../main';

export async function refreshCredentials(plugin: CommonplaceNotesPublisherPlugin) {
	try {
		new Notice('Refreshing AWS credentials');

		const commands = plugin.settings.credentialRefreshCommands
			.split('\n')
			.filter(cmd => cmd.trim().length > 0)
			.map(cmd => {
				// Replace variables in the command
				return cmd
					.replace('${awsAccountId}', plugin.settings.awsAccountId)
					.replace('${awsProfile}', plugin.settings.awsProfile);
			});

		for (const command of commands) {
			new Notice(`Executing: ${command}`);
			await execAsync(command);
		}

		new Notice('Successfully refreshed AWS credentials');
	} catch (error) {
		console.error('Failed to refresh credentials:', error);
		new Notice('Failed to refresh credentials: ' + error.message);
		throw error;
	}
}

export async function checkAwsCredentials() {
    try {
        const { stdout } = await execAsync('aws sts get-caller-identity --output json');
        return JSON.parse(stdout);
    } catch (error) {
        console.error('Failed to check AWS credentials:', error);
        throw error;
    }
}