import { Notice } from 'obsidian';
import * as path from 'path';
import { execAsync } from '../utils/shell';
import CommonplaceNotesPublisherPlugin from '../main';

export async function pushLocalJsonsToS3(plugin: CommonplaceNotesPublisherPlugin, profileId: string) {
    // Get the active profile
    const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);

    if (!profile) {
        new Notice('No publishing profile provided');
        return;
    }

    if (profile.publishMechanism !== 'AWS CLI' || !profile.awsSettings) {
        new Notice('Selected profile is not configured for AWS publishing');
        return;
    }

    const basePath = (plugin.app.vault.adapter as any).basePath;
    const localJsonDirectory = path.join(basePath, '.obsidian', 'plugins', 'commonplace-notes-publisher', 'notes');
    const sourcePathEscaped = `"${path.resolve(localJsonDirectory)}"`;

    const s3Path = `s3://${profile.awsSettings.bucketName}/notes/`;
    const options = {
        cwd: (plugin.app.vault.adapter as any).basePath
    };

    try {
        new Notice('Uploading notes from local to S3...');
        const command = `aws s3 cp ${sourcePathEscaped} ${s3Path} --recursive --profile ${profile.awsSettings.awsProfile}`;
        console.log('Executing command:', command);

        const { stdout, stderr } = await execAsync(command, options);
        new Notice('Successfully uploaded notes to S3!');
        console.log('Output:', stdout);
        if (stderr) console.error('Errors:', stderr);
    } catch (error) {
        console.error('Error executing AWS command:', error);
    }
}