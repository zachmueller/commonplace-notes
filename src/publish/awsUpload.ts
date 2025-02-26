import { Notice } from 'obsidian';
import * as path from 'path';
import { execAsync } from '../utils/shell';
import CommonplaceNotesPlugin from '../main';
import { Logger } from '../utils/logging';

export async function pushLocalJsonsToS3(
	plugin: CommonplaceNotesPlugin,
	profileId: string,
	triggerCloudFrontInvalidation: boolean = false
): Promise<boolean> {
	try {
		// Get the chosen profile
		const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);

		if (!profile) {
			throw new Error('No publishing profile provided');
		}

		if (profile.publishMechanism !== 'AWS CLI' || !profile.awsSettings) {
			throw new Error('Selected profile is not configured for AWS publishing');
		}

		// TODO::extract this directory setup into the main plugin class for standard access pattern::
		const basePath = (plugin.app.vault.adapter as any).basePath;
		const stagedNotesDir = plugin.profileManager.getStagedNotesDir(profileId);
		const mappingDir = plugin.profileManager.getMappingDir(profileId);
		const contentIndexLoc = plugin.profileManager.getContentIndexPath(profileId);
		const contentIndexPath = `"${path.resolve(path.join(basePath, contentIndexLoc))}"`;

		// Verify directories and files exist
		if (!plugin.app.vault.adapter.exists(stagedNotesDir)) {
			throw new Error(`Staged notes directory does not exist: ${stagedNotesDir}`);
		}
		if (!plugin.app.vault.adapter.exists(mappingDir)) {
			throw new Error(`Mapping directory does not exist: ${mappingDir}`);
		}

		const notesPath = `"${path.resolve(path.join(basePath, stagedNotesDir))}"`;
		// Add prefix to S3 paths if configured
		const s3Prefix = profile.awsSettings.s3Prefix || '';
		const notesS3Prefix = `s3://${profile.awsSettings.bucketName}/${s3Prefix}notes/`;
		const mappingPath = `"${path.resolve(path.join(basePath, mappingDir))}"`;
		const mappingS3Prefix = `s3://${profile.awsSettings.bucketName}/${s3Prefix}static/mapping/`;

		// standard options to send to the shell
		const options = { cwd: basePath };

		// Upload notes
		new Notice('Uploading notes from local to S3...');
		const cmdNotes = `aws s3 cp ${notesPath} ${notesS3Prefix} --recursive --profile ${profile.awsSettings.awsProfile}`;
		Logger.debug('Executing command:', cmdNotes);

		const { stdout: stdoutNotes, stderr: stderrNotes } = await execAsync(cmdNotes, options);
		if (stderrNotes) {
			// TODO::generalize aws CLI calls to standardize error handling::
			Logger.debug(`stdout from aws command: ${stdoutNotes}`);
			throw new Error(`Notes upload failed: ${stderrNotes}`);
		}
		Logger.debug('Notes upload output:', stdoutNotes);
		new Notice('Successfully uploaded notes to S3');

		// Upload mapping files
		new Notice('Uploading mappings from local to S3...');
		const cmdMapping = `aws s3 cp ${mappingPath} ${mappingS3Prefix} --recursive --profile ${profile.awsSettings.awsProfile}`;
		Logger.debug('Executing command:', cmdMapping);

		const { stdout: stdoutMapping, stderr: stderrMapping } = await execAsync(cmdMapping, options);
		if (stderrMapping) {
			Logger.debug(`stdout from aws command: ${stdoutMapping}`);
			throw new Error(`Mapping upload failed: ${stderrMapping}`);
		}
		Logger.debug('Mappings upload output:', stdoutMapping);
		new Notice('Mapping files successfully uploaded to S3');

		// Upload content index if enabled
		if (profile.publishContentIndex) {
			new Notice('Uploading content index from local to S3...');

			if (!plugin.app.vault.adapter.exists(contentIndexPath)) {
				Logger.warn(`Content index file does not exist: ${contentIndexPath}`);
				new Notice('No content index file found to upload');
			} else {
				const contentIndexS3Prefix = `s3://${profile.awsSettings.bucketName}/${s3Prefix}static/content/`;
				const cmdContentIndex = `aws s3 cp ${contentIndexPath} ${contentIndexS3Prefix}contentIndex.json --profile ${profile.awsSettings.awsProfile}`;
				Logger.debug('Executing command:', cmdContentIndex);

				const { stdout: stdoutContentIndex, stderr: stderrContentIndex } = 
					await execAsync(cmdContentIndex, options);
				if (stderrContentIndex) {
					Logger.debug(`stdout from aws command: ${stdoutContentIndex}`);
					throw new Error(`Content index upload failed: ${stderrContentIndex}`);
				}
				new Notice('Content index successfully uploaded to S3');
			}
		}

		// Trigger CloudFront cache invalidation if configured to
		if (triggerCloudFrontInvalidation) {
			await createCloudFrontInvalidation(plugin, profileId);
		}

		return true;
	} catch (error) {
		Logger.error('Error executing AWS command:', error);
		new Notice(`Upload failed: ${error.message}`);
		return false;
	}
}

async function createCloudFrontInvalidation(plugin: CommonplaceNotesPlugin, profileId: string): Promise<boolean> {
	try {
		const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
		if (!profile?.awsSettings?.cloudFrontDistributionId) {
			Logger.debug('No CloudFront distribution ID configured, skipping invalidation');
			return false;
		}

		const cmd = `aws cloudfront create-invalidation --distribution-id ${profile.awsSettings.cloudFrontDistributionId} --paths "/*" --profile ${profile.awsSettings.awsProfile}`;
		
		new Notice('Creating CloudFront invalidation...');
		const { stdout, stderr } = await execAsync(cmd);
		
		if (stderr) {
			Logger.error('CloudFront invalidation error:', stderr);
			throw new Error(stderr);
		}

		Logger.debug('CloudFront invalidation created:', stdout);
		new Notice('CloudFront invalidation created successfully');
		return true;
	} catch (error) {
		Logger.error('Failed to create CloudFront invalidation:', error);
		new Notice('Failed to create CloudFront invalidation: ' + error.message);
		return false;
	}
}