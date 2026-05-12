import { PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, S3ServiceException } from '@aws-sdk/client-s3';
import { CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { TFile } from 'obsidian';
import CommonplaceNotesPlugin from '../main';
import { Logger } from '../utils/logging';
import { NoticeManager } from '../utils/notice';
import { renderIndexHtml, renderStylesCss, renderAppJs, renderConfigJson, getFlexSearchJs } from './siteRenderer';

const MAX_CONCURRENCY = 5;

async function runWithConcurrency<T>(
	items: T[],
	fn: (item: T) => Promise<void>,
	concurrency: number,
	onComplete?: () => void
): Promise<void> {
	let index = 0;
	const execute = async (): Promise<void> => {
		while (index < items.length) {
			const current = index++;
			await fn(items[current]);
			if (onComplete) onComplete();
		}
	};
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => execute());
	await Promise.all(workers);
}

function isCredentialError(error: unknown): boolean {
	if (error instanceof S3ServiceException) {
		return ['AccessDenied', 'ExpiredToken', 'ExpiredTokenException', 'InvalidAccessKeyId', 'AuthFailure'].includes(error.name);
	}
	return false;
}

export async function pushLocalJsonsToS3(
	plugin: CommonplaceNotesPlugin,
	profileId: string,
	triggerCloudFrontInvalidation: boolean = false
): Promise<boolean> {
	try {
		const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);

		if (!profile) {
			throw new Error('No publishing profile provided');
		}

		if (profile.publishMechanism !== 'AWS' || !profile.awsSettings) {
			throw new Error('Selected profile is not configured for AWS publishing');
		}

		const s3Client = plugin.awsSdkManager.getS3Client(profile);
		const bucket = profile.awsSettings.bucketName;
		const s3Prefix = profile.awsSettings.s3Prefix || '';

		const stagedNotesDir = plugin.profileManager.getStagedNotesDir(profileId);

		if (!await plugin.app.vault.adapter.exists(stagedNotesDir)) {
			throw new Error(`Staged notes directory does not exist: ${stagedNotesDir}`);
		}

		const listing = await plugin.app.vault.adapter.list(stagedNotesDir);
		const noteFiles = listing.files.filter(f => f.endsWith('.json'));

		if (noteFiles.length === 0) {
			Logger.debug('No staged note files to upload');
			NoticeManager.showNotice('No staged notes to upload');
			return true;
		}

		const { success, error } = await NoticeManager.showProgressWithCounter(
			'Uploading notes to S3',
			noteFiles.length,
			async (updateProgress) => {
				let completed = 0;
				await runWithConcurrency(noteFiles, async (filePath) => {
					const content = await plugin.app.vault.adapter.read(filePath);
					const fileName = filePath.split('/').pop()!;
					const key = `${s3Prefix}notes/${fileName}`;

					await s3Client.send(new PutObjectCommand({
						Bucket: bucket,
						Key: key,
						Body: content,
						ContentType: 'application/json',
					}));

					completed++;
					updateProgress(completed);
					Logger.debug(`Uploaded ${key}`);
				}, MAX_CONCURRENCY);
			},
			`Successfully uploaded ${noteFiles.length} notes to S3`,
			`Notes upload failed, check console for error details`
		);

		if (!success) {
			if (isCredentialError(error)) {
				NoticeManager.showNotice('S3 permission error — please refresh your AWS credentials and try again.', 10000);
			}
			return false;
		}

		await pushMappingAndIndexToS3(plugin, profileId);

		if (triggerCloudFrontInvalidation) {
			await createCloudFrontInvalidation(plugin, profileId);
		}

		return true;
	} catch (error) {
		Logger.error('Error during S3 upload:', error);
		if (isCredentialError(error)) {
			NoticeManager.showNotice('S3 permission error — please refresh your AWS credentials and try again.', 10000);
		} else {
			NoticeManager.showNotice(`Upload failed: ${error.message}`);
		}
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

	const s3Client = plugin.awsSdkManager.getS3Client(profile);
	const bucket = profile.awsSettings.bucketName;
	const s3Prefix = profile.awsSettings.s3Prefix || '';

	const mappingDir = plugin.profileManager.getMappingDir(profileId);
	if (!await plugin.app.vault.adapter.exists(mappingDir)) {
		throw new Error(`Mapping directory does not exist: ${mappingDir}`);
	}

	const listing = await plugin.app.vault.adapter.list(mappingDir);
	const mappingFiles = listing.files;

	if (mappingFiles.length > 0) {
		const { success } = await NoticeManager.showProgressWithCounter(
			'Uploading mappings to S3',
			mappingFiles.length,
			async (updateProgress) => {
				let completed = 0;
				await runWithConcurrency(mappingFiles, async (filePath) => {
					const content = await plugin.app.vault.adapter.read(filePath);
					const fileName = filePath.split('/').pop()!;
					const key = `${s3Prefix}static/mapping/${fileName}`;

					await s3Client.send(new PutObjectCommand({
						Bucket: bucket,
						Key: key,
						Body: content,
						ContentType: 'application/json',
					}));

					completed++;
					updateProgress(completed);
					Logger.debug(`Uploaded mapping: ${key}`);
				}, MAX_CONCURRENCY);
			},
			`Mapping files successfully uploaded to S3`,
			`Mapping upload failed, check console for error details`
		);

		if (!success) throw new Error('Mapping upload failed');
	}

	if (profile.publishContentIndex) {
		const contentIndexPath = plugin.profileManager.getContentIndexPath(profileId);

		if (!await plugin.app.vault.adapter.exists(contentIndexPath)) {
			Logger.warn(`Content index file does not exist: ${contentIndexPath}`);
			NoticeManager.showNotice('No content index file found to upload');
		} else {
			const content = await plugin.app.vault.adapter.read(contentIndexPath);
			const key = `${s3Prefix}static/content/contentIndex.json`;

			const { success } = await NoticeManager.showProgress(
				`Uploading content index to S3`,
				s3Client.send(new PutObjectCommand({
					Bucket: bucket,
					Key: key,
					Body: content,
					ContentType: 'application/json',
				})),
				`Content index successfully uploaded to S3`,
				`Content index upload failed, check console for error details`
			);

			if (!success) throw new Error('Content index upload failed');
			Logger.debug(`Uploaded content index: ${key}`);
		}
	}
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

	const s3Client = plugin.awsSdkManager.getS3Client(profile);
	const bucket = profile.awsSettings.bucketName;
	const s3Prefix = profile.awsSettings.s3Prefix || '';

	try {
		if (hashes.length <= 5) {
			for (const hash of hashes) {
				const key = `${s3Prefix}notes/${hash}.json`;
				await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
				Logger.debug(`Deleted ${key}`);
			}
		} else {
			const objects = hashes.map(hash => ({ Key: `${s3Prefix}notes/${hash}.json` }));
			const response = await s3Client.send(new DeleteObjectsCommand({
				Bucket: bucket,
				Delete: { Objects: objects },
			}));

			if (response.Errors && response.Errors.length > 0) {
				for (const err of response.Errors) {
					Logger.error(`Failed to delete ${err.Key}: ${err.Code} - ${err.Message}`);
				}
				throw new Error(`Batch delete had ${response.Errors.length} error(s)`);
			}

			Logger.debug(`Batch deleted ${hashes.length} objects`);
		}

		return true;
	} catch (error) {
		if (isCredentialError(error)) {
			NoticeManager.showNotice(
				'S3 permission error — please refresh your AWS credentials and try again.',
				10000
			);
			Logger.error('S3 permission error during delete:', error);
			return false;
		}
		Logger.error('Error deleting from S3:', error);
		throw error;
	}
}

export async function pushSiteAssetsToS3(
	plugin: CommonplaceNotesPlugin,
	profileId: string
): Promise<boolean> {
	try {
		const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);

		if (!profile) {
			throw new Error('No publishing profile provided');
		}

		if (profile.publishMechanism !== 'AWS' || !profile.awsSettings) {
			throw new Error('Selected profile is not configured for AWS publishing');
		}

		const s3Client = plugin.awsSdkManager.getS3Client(profile);
		const bucket = profile.awsSettings.bucketName;
		const s3Prefix = profile.awsSettings.s3Prefix || '';

		// Resolve home note UID from the configured home note path
		let homeNoteUid: string | undefined;
		if (profile.homeNotePath) {
			const homeFile = plugin.app.vault.getAbstractFileByPath(profile.homeNotePath);
			if (homeFile instanceof TFile) {
				homeNoteUid = plugin.frontmatterManager.getNoteUID(homeFile) || undefined;
			}
		}

		const assets: { key: string; body: string; contentType: string; cacheControl: string }[] = [
			{
				key: `${s3Prefix}index.html`,
				body: renderIndexHtml(profile, homeNoteUid),
				contentType: 'text/html',
				cacheControl: 'no-cache',
			},
			{
				key: `${s3Prefix}styles.css`,
				body: renderStylesCss(profile),
				contentType: 'text/css',
				cacheControl: 'public, max-age=31536000, immutable',
			},
			{
				key: `${s3Prefix}app.js`,
				body: renderAppJs(),
				contentType: 'application/javascript',
				cacheControl: 'public, max-age=31536000, immutable',
			},
			{
				key: `${s3Prefix}flexsearch.min.js`,
				body: getFlexSearchJs(),
				contentType: 'application/javascript',
				cacheControl: 'public, max-age=31536000, immutable',
			},
			{
				key: `${s3Prefix}config.json`,
				body: renderConfigJson(profile, homeNoteUid),
				contentType: 'application/json',
				cacheControl: 'no-cache',
			},
		];

		const { success, error } = await NoticeManager.showProgress(
			'Uploading site assets to S3',
			(async () => {
				for (const asset of assets) {
					await s3Client.send(new PutObjectCommand({
						Bucket: bucket,
						Key: asset.key,
						Body: asset.body,
						ContentType: asset.contentType,
						CacheControl: asset.cacheControl,
					}));
					Logger.debug(`Uploaded site asset: ${asset.key}`);
				}
			})(),
			'Site assets uploaded successfully',
			'Site assets upload failed, check console for error details'
		);

		if (!success) {
			if (isCredentialError(error)) {
				NoticeManager.showNotice('S3 permission error — please refresh your AWS credentials and try again.', 10000);
			}
			return false;
		}

		return true;
	} catch (error) {
		Logger.error('Error uploading site assets:', error);
		if (isCredentialError(error)) {
			NoticeManager.showNotice('S3 permission error — please refresh your AWS credentials and try again.', 10000);
		} else {
			NoticeManager.showNotice(`Site assets upload failed: ${error.message}`);
		}
		return false;
	}
}

export async function createCloudFrontInvalidation(plugin: CommonplaceNotesPlugin, profileId: string): Promise<boolean> {
	try {
		const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
		if (!profile?.awsSettings?.cloudFrontDistributionId) {
			Logger.debug('No CloudFront distribution ID configured, skipping invalidation');
			return false;
		}

		const cfClient = plugin.awsSdkManager.getCloudFrontClient(profile);

		const { success, error } = await NoticeManager.showProgress(
			`Creating CloudFront invalidation`,
			cfClient.send(new CreateInvalidationCommand({
				DistributionId: profile.awsSettings.cloudFrontDistributionId,
				InvalidationBatch: {
					Paths: { Quantity: 1, Items: ['/*'] },
					CallerReference: Date.now().toString(),
				},
			})),
			`CloudFront invalidation created successfully`,
			`CloudFront invalidation failed, check console for error details`
		);

		if (!success) {
			throw error;
		}

		return true;
	} catch (error) {
		Logger.error('Failed to create CloudFront invalidation:', error);
		NoticeManager.showNotice('Failed to create CloudFront invalidation: ' + error.message);
		return false;
	}
}
