import { Notice } from 'obsidian';
import { execAsync } from '../utils/shell';

export async function refreshMwinit() {
	try {
		new Notice('Refreshing mwinit...');
		await execAsync('start mwinit');
		new Notice('Successfully refreshed mwinit');
	} catch (error) {
		console.error('Failed to refresh mwinit:', error);
	}
}

export async function checkAwsCredentials() {
	try {
		new Notice('Refreshing mwinit...');
		const { stdout } = await execAsync('aws sts get-caller-identity --output json');
		new Notice('Successfully refreshed mwinit');
	} catch (error) {
		console.error('Failed to refresh mwinit:', error);
	}
}

export async function refreshCredentials() {
	try {
		new Notice('Refreshing AWS credentials');
		await execAsync(`ada credentials update --account=${this.settings.awsAccountId} --provider=isengard --role=${this.settings.awsRole} --profile=${this.settings.awsProfile} --once`);
		return;
	} catch (error) {
		console.error('Failed to refresh credentials:', error);
		throw error;
	}
}