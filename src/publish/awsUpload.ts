import { Notice } from 'obsidian';
import * as path from 'path';
import { execAsync } from '../utils/shell';
import CommonplaceNotesPlugin from '../main';

export async function pushLocalJsonsToS3(plugin: CommonplaceNotesPlugin, profileId: string) {
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

	// TODO::extract this directory setup into the main plugin class for standard access pattern::
    const basePath = (plugin.app.vault.adapter as any).basePath;
	const notesDir = path.join(basePath, '.obsidian', 'plugins', 'commonplace-notes-publisher', 'notes');
	const notesPath = `"${path.resolve(notesDir)}"`;
    const notesS3Prefix = `s3://${profile.awsSettings.bucketName}/notes/`;

	// craft path for mapping files
	const mappingDir = path.join(basePath, plugin.mappingManager.mappingDir);
	const mappingPath = `"${mappingDir}"`;
	const mappingS3Prefix = `s3://${profile.awsSettings.bucketName}/static/mapping/`;

	// standard options to send to the shell
	const options = {
        cwd: (plugin.app.vault.adapter as any).basePath
    };

    try {
        // Upload notes
		new Notice('Uploading notes from local to S3...');
        const cmdNotes = `aws s3 cp ${notesPath} ${notesS3Prefix} --recursive --profile ${profile.awsSettings.awsProfile}`;
        console.log('Executing command:', cmdNotes);

        const { stdout: stdoutNotes, stderr: stderrNotes } = await execAsync(cmdNotes, options);
        new Notice('Successfully uploaded notes to S3');
        console.log('Notes upload output:', stdoutNotes);
        if (stderrNotes) console.error('Errors:', stderrNotes);

		// Upload mapping files
		new Notice('Uploading mappings from local to S3...');
        const cmdMapping = `aws s3 cp ${mappingPath} ${mappingS3Prefix} --recursive --profile ${profile.awsSettings.awsProfile}`;
        console.log('Executing command:', cmdMapping);

        const { stdout: stdoutMapping, stderr: stderrMapping } = await execAsync(cmdMapping, options);
        new Notice('Mapping files successfully uploaded to S3');
        console.log('Mappings upload output:', stdoutMapping);
        if (stderrMapping) console.error('Errors:', stderrMapping);
    } catch (error) {
        console.error('Error executing AWS command:', error);
    }
}