import { Notice } from 'obsidian';
import * as path from 'path';
import { execAsync } from '../utils/shell';
import CommonplaceNotesPlugin from '../main';

export async function pushLocalJsonsToS3(
	plugin: CommonplaceNotesPlugin,
	profileId: string,
	triggerCloudFrontInvalidation: boolean = false
): Promise<boolean> {
    try {
		// Get the active profile
		const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);

		if (!profile) {
			throw new Error('No publishing profile provided');
		}

		if (profile.publishMechanism !== 'AWS CLI' || !profile.awsSettings) {
			throw new Error('Selected profile is not configured for AWS publishing');
		}

		// TODO::extract this directory setup into the main plugin class for standard access pattern::
		const basePath = (plugin.app.vault.adapter as any).basePath;
		const notesDir = path.join(basePath, '.obsidian', 'plugins', 'commonplace-notes', 'notes');
		const profileMappingDir = path.join(basePath, plugin.mappingManager.mappingDir, profileId);

		// Verify directories exist before attempting upload
		if (!plugin.app.vault.adapter.exists(notesDir)) {
			throw new Error(`Notes directory does not exist: ${notesDir}`);
		}
		if (!plugin.app.vault.adapter.exists(profileMappingDir)) {
			throw new Error(`Mapping directory does not exist: ${profileMappingDir}`);
		}

		const notesPath = `"${path.resolve(notesDir)}"`;
		const notesS3Prefix = `s3://${profile.awsSettings.bucketName}/notes/`;
		const mappingPath = `"${profileMappingDir}"`;
		const mappingS3Prefix = `s3://${profile.awsSettings.bucketName}/static/mapping/`;

		// standard options to send to the shell
		const options = {
			cwd: basePath
		};

        // Upload notes
		new Notice('Uploading notes from local to S3...');
        const cmdNotes = `aws s3 cp ${notesPath} ${notesS3Prefix} --recursive --profile ${profile.awsSettings.awsProfile}`;
        console.log('Executing command:', cmdNotes);

        const { stdout: stdoutNotes, stderr: stderrNotes } = await execAsync(cmdNotes, options);
		if (stderrNotes) {
			// TODO::generalize aws CLI calls to standardize error handling::
			console.log(`stdout from aws command: ${stdoutNotes}`);
			throw new Error(`Notes upload failed: ${stderrNotes}`);
		}
        console.log('Notes upload output:', stdoutNotes);
        new Notice('Successfully uploaded notes to S3');

		// Upload mapping files
		new Notice('Uploading mappings from local to S3...');
        const cmdMapping = `aws s3 cp ${mappingPath} ${mappingS3Prefix} --recursive --profile ${profile.awsSettings.awsProfile}`;
        console.log('Executing command:', cmdMapping);

        const { stdout: stdoutMapping, stderr: stderrMapping } = await execAsync(cmdMapping, options);
		if (stderrMapping) {
			console.log(`stdout from aws command: ${stdoutNotes}`);
			throw new Error(`Mapping upload failed: ${stderrMapping}`);
		}
        console.log('Mappings upload output:', stdoutMapping);
        new Notice('Mapping files successfully uploaded to S3');

		if (profile.publishContentIndex) {
			new Notice('Uploading content index from local to S3...');

			// Add content index path to upload
			const contentIndexPath = path.join(
				basePath,
				plugin.publisher.getContentIndexPath(profileId)
			);
			const contentIndexS3Prefix = `s3://${profile.awsSettings.bucketName}/static/content/`;

			// Upload content index
			const cmdContentIndex = `aws s3 cp "${contentIndexPath}" ${contentIndexS3Prefix}contentIndex.json --profile ${profile.awsSettings.awsProfile}`;
			console.log('Executing command:', cmdContentIndex);

			const { stdout: stdoutContentIndex, stderr: stderrContentIndex } = 
				await execAsync(cmdContentIndex, options);
			if (stderrContentIndex) {
				console.log(`stdout from aws command: ${stdoutContentIndex}`);
				throw new Error(`Content index upload failed: ${stderrContentIndex}`);
			}
		}

		// Trigger CloudFront cache invalidation if configured to
		if (triggerCloudFrontInvalidation) {
			await createCloudFrontInvalidation(plugin, profileId);
		}

		return true;
    } catch (error) {
        console.error('Error executing AWS command:', error);
		new Notice(`Upload failed: ${error.message}`);
		return false;
    }
}

async function createCloudFrontInvalidation(plugin: CommonplaceNotesPlugin, profileId: string): Promise<boolean> {
	try {
		const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
		if (!profile?.awsSettings?.cloudFrontDistributionId) {
			console.log('No CloudFront distribution ID configured, skipping invalidation');
			return false;
		}

		const cmd = `aws cloudfront create-invalidation --distribution-id ${profile.awsSettings.cloudFrontDistributionId} --paths "/*" --profile ${profile.awsSettings.awsProfile}`;
		
		new Notice('Creating CloudFront invalidation...');
		const { stdout, stderr } = await execAsync(cmd);
		
		if (stderr) {
			console.error('CloudFront invalidation error:', stderr);
			throw new Error(stderr);
		}

		console.log('CloudFront invalidation created:', stdout);
		new Notice('CloudFront invalidation created successfully');
		return true;
	} catch (error) {
		console.error('Failed to create CloudFront invalidation:', error);
		new Notice('Failed to create CloudFront invalidation: ' + error.message);
		return false;
	}
}