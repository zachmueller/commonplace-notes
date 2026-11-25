import type { SettingDefinitionGroup } from 'obsidian';
import { PublishingProfile } from '../../types';
import { DefinitionContext } from '../context';

/**
 * "Destination" group: publish mechanism + base URL, then the AWS-only bucket
 * fields. The other AWS-only areas (Infrastructure, Authentication & Delivery,
 * Site Customization, Deploy hooks) are their own groups / pages on the
 * profile page, shown only while the mechanism is AWS.
 */
export function destinationGroup(ctx: DefinitionContext, profile: PublishingProfile): SettingDefinitionGroup {
	const key = (path: string) => ctx.profileKey(profile, path);
	const isAws = () => profile.publishMechanism === 'AWS';

	return {
		type: 'group',
		heading: 'Destination',
		items: [
			{
				name: 'Publish mechanism',
				desc: 'Where this profile publishes. AWS-only settings are hidden for Local profiles.',
				aliases: ['local', 'aws', 'target'],
				control: { type: 'dropdown', key: key('publishMechanism'), options: { AWS: 'AWS', Local: 'Local' } },
			},
			{
				name: 'Base URL',
				desc: 'Base URL for published notes',
				aliases: ['domain', 'site url', 'website'],
				control: { type: 'text', key: key('baseUrl'), placeholder: 'https://notes.example.com/' },
			},
			{
				name: 'S3 bucket name',
				desc: 'The name of the S3 bucket to upload to',
				aliases: ['S3', 'bucket', 'storage'],
				visible: isAws,
				control: { type: 'text', key: key('awsSettings.bucketName'), placeholder: 'my-notes-bucket' },
			},
			{
				name: 'S3 prefix',
				desc: 'Optional prefix path in the S3 bucket (e.g., "site/"). Leave empty to use bucket root.',
				aliases: ['S3', 'folder', 'path'],
				visible: isAws,
				control: { type: 'text', key: key('awsSettings.s3Prefix'), placeholder: 'notes/' },
			},
		],
	};
}
