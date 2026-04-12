import * as path from 'path';
import { execAsync } from '../utils/shell';
import CommonplaceNotesPlugin from '../main';
import { Logger } from '../utils/logging';
import { NoticeManager } from '../utils/notice';

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

		// Get the AWS CLI command
		const awsCommand = plugin.awsCliManager.getAwsCliCommandFromProfile(profile);

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
		const cmdNotes = `${awsCommand} s3 cp ${notesPath} ${notesS3Prefix} --recursive --profile ${profile.awsSettings.awsProfile}`;
		Logger.debug('Executing command:', cmdNotes);

		const { success: notesSuccess, result: notesResult, error: notesError } = await NoticeManager.showProgress(
			`Uploading notes from local to S3`,
			execAsync(cmdNotes, options),
			`Successfully uploaded notes to S3`,
			`Notes upload failed, check console for error details`
		);
		if (notesResult && notesResult?.stderr) {
			// TODO::generalize aws CLI calls to standardize error handling::
			Logger.debug(`stdout from aws command: ${notesResult?.stdout}`);
			throw new Error(`Notes upload failed: ${notesResult?.stderr}`);
		}
		Logger.debug('Notes upload output:', notesResult?.stdout);

		// Upload mapping files and content index
		await pushMappingAndIndexToS3(plugin, profileId);

		// Trigger CloudFront cache invalidation if configured to
		if (triggerCloudFrontInvalidation) {
			await createCloudFrontInvalidation(plugin, profileId);
		}

		return true;
	} catch (error) {
		Logger.error('Error executing AWS command:', error);
		NoticeManager.showNotice(`Upload failed: ${error.message}`);
		return false;
	}
}

export async function pushMappingAndIndexToS3(
	plugin: CommonplaceNotesPlugin,
	profileId: string
): Promise<void> {
	const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
	if (!profile?.awsSettings) {
		throw new Error('Selected profile is not configured for AWS publishing');
	}

	const awsCommand = plugin.awsCliManager.getAwsCliCommandFromProfile(profile);
	const basePath = (plugin.app.vault.adapter as any).basePath;
	const mappingDir = plugin.profileManager.getMappingDir(profileId);
	const s3Prefix = profile.awsSettings.s3Prefix || '';
	const mappingPath = `"${path.resolve(path.join(basePath, mappingDir))}"`;
	const mappingS3Prefix = `s3://${profile.awsSettings.bucketName}/${s3Prefix}static/mapping/`;
	const options = { cwd: basePath };

	// Upload mapping files
	const cmdMapping = `${awsCommand} s3 cp ${mappingPath} ${mappingS3Prefix} --recursive --profile ${profile.awsSettings.awsProfile}`;
	Logger.debug('Executing command:', cmdMapping);

	const { result: mapResult } = await NoticeManager.showProgress(
		`Uploading mappings from local to S3`,
		execAsync(cmdMapping, options),
		`Mapping files successfully uploaded to S3`,
		`Mapping upload failed, check console for error details`
	);
	if (mapResult && mapResult?.stderr) {
		Logger.debug(`stdout from aws command: ${mapResult?.stdout}`);
		throw new Error(`Mapping upload failed: ${mapResult?.stderr}`);
	}
	Logger.debug('Mappings upload output:', mapResult?.stdout);

	// Upload content index if enabled
	if (profile.publishContentIndex) {
		const contentIndexLoc = plugin.profileManager.getContentIndexPath(profileId);
		const contentIndexPath = `"${path.resolve(path.join(basePath, contentIndexLoc))}"`;

		if (!plugin.app.vault.adapter.exists(contentIndexPath)) {
			Logger.warn(`Content index file does not exist: ${contentIndexPath}`);
			NoticeManager.showNotice('No content index file found to upload');
		} else {
			const contentIndexS3Prefix = `s3://${profile.awsSettings.bucketName}/${s3Prefix}static/content/`;
			const cmdContentIndex = `${awsCommand} s3 cp ${contentIndexPath} ${contentIndexS3Prefix}contentIndex.json --profile ${profile.awsSettings.awsProfile}`;
			Logger.debug('Executing command:', cmdContentIndex);

			const { result: contentResult } = await NoticeManager.showProgress(
				`Uploading content index from local to S3`,
				execAsync(cmdContentIndex, options),
				`Content index successfully uploaded to S3`,
				`Content index upload failed, check console for error details`
			);
			if (contentResult && contentResult?.stderr) {
				Logger.debug(`stdout from aws command: ${contentResult?.stdout}`);
				throw new Error(`Content index upload failed: ${contentResult?.stderr}`);
			}
		}
	}
}

const S3_PERMISSION_ERROR_PATTERNS = [
	'AccessDenied',
	'ExpiredToken',
	'InvalidAccessKeyId',
	'403 Forbidden',
	'AuthFailure'
];

function isPermissionError(stderr: string): boolean {
	return S3_PERMISSION_ERROR_PATTERNS.some(pattern => stderr.includes(pattern));
}

export async function deleteNoteHashesFromS3(
	plugin: CommonplaceNotesPlugin,
	profileId: string,
	hashes: string[]
): Promise<boolean> {
	const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
	if (!profile?.awsSettings) {
		throw new Error('Selected profile is not configured for AWS publishing');
	}

	const awsCommand = plugin.awsCliManager.getAwsCliCommandFromProfile(profile);
	const basePath = (plugin.app.vault.adapter as any).basePath;
	const s3Prefix = profile.awsSettings.s3Prefix || '';
	const options = { cwd: basePath };

	for (const hash of hashes) {
		const s3Key = `s3://${profile.awsSettings.bucketName}/${s3Prefix}notes/${hash}.json`;
		const cmd = `${awsCommand} s3 rm ${s3Key} --profile ${profile.awsSettings.awsProfile}`;
		Logger.debug('Executing S3 delete command:', cmd);

		try {
			const result = await execAsync(cmd, options);
			if (result.stderr) {
				if (isPermissionError(result.stderr)) {
					NoticeManager.showNotice(
						'S3 permission error — please refresh your AWS credentials and try again.',
						10000
					);
					Logger.error('S3 permission error during delete:', result.stderr);
					return false;
				}
				Logger.warn(`Non-fatal stderr during S3 delete of ${hash}: ${result.stderr}`);
			}
			Logger.debug(`Successfully deleted ${s3Key}`);
		} catch (error) {
			const errorMsg = error.message || error.toString();
			if (isPermissionError(errorMsg)) {
				NoticeManager.showNotice(
					'S3 permission error — please refresh your AWS credentials and try again.',
					10000
				);
				Logger.error('S3 permission error during delete:', errorMsg);
				return false;
			}
			Logger.error(`Error deleting ${s3Key}:`, error);
			throw error;
		}
	}

	return true;
}

export async function createCloudFrontInvalidation(plugin: CommonplaceNotesPlugin, profileId: string): Promise<boolean> {
	try {
		const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
		if (!profile?.awsSettings?.cloudFrontDistributionId) {
			Logger.debug('No CloudFront distribution ID configured, skipping invalidation');
			return false;
		}

		const awsCommand = plugin.awsCliManager.getAwsCliCommand(profileId);
		const cmd = `${awsCommand} cloudfront create-invalidation --distribution-id ${profile.awsSettings.cloudFrontDistributionId} --paths "/*" --profile ${profile.awsSettings.awsProfile}`;

		const { success, result, error } = await NoticeManager.showProgress(
			`Creating CloudFront invalidation`,
			execAsync(cmd),
			`CloudFront invalidation created successfully`,
			`CloudFront invalidation failed, check console for error details`
		);
		if (result && result?.stderr) {
			Logger.error('CloudFront invalidation error:', result?.stderr);
			throw new Error(`CloudFront invalidation failed: ${result?.stderr}`);
		}

		Logger.debug('CloudFront invalidation created:', result?.stdout);
		return true;
	} catch (error) {
		Logger.error('Failed to create CloudFront invalidation:', error);
		NoticeManager.showNotice('Failed to create CloudFront invalidation: ' + error.message);
		return false;
	}
}