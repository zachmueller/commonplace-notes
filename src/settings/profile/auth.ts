import type { SettingDefinitionGroup } from 'obsidian';
import { PublishingProfile } from '../../types';
import { DefinitionContext } from '../context';

/**
 * "Authentication & Delivery" group (AWS profiles): AWS account/profile/region,
 * credential mode (+ refresh commands or CLI path, by mode), and the CloudFront
 * invalidation scheme + distribution ID. The caller ensures `awsSettings`.
 */
export function authGroup(ctx: DefinitionContext, profile: PublishingProfile): SettingDefinitionGroup {
	const key = (path: string) => ctx.profileKey(profile, `awsSettings.${path}`);
	const customCommand = () => profile.awsSettings?.credentialMode === 'custom-command';

	return {
		type: 'group',
		heading: 'Authentication & Delivery',
		visible: () => profile.publishMechanism === 'AWS',
		items: [
			{
				name: 'AWS account ID',
				desc: 'The AWS account ID to use for authentication',
				aliases: ['account'],
				control: { type: 'text', key: key('awsAccountId'), placeholder: '123456789012' },
			},
			{
				name: 'AWS profile',
				desc: 'The AWS profile to use for authentication',
				aliases: ['credentials', 'sso'],
				control: { type: 'text', key: key('awsProfile'), placeholder: 'notes' },
			},
			{
				name: 'AWS region',
				desc: 'The AWS region where your bucket is located',
				aliases: ['region'],
				control: { type: 'text', key: key('region'), placeholder: 'us-east-1' },
			},
			{
				name: 'Credential mode',
				desc: 'SDK uses the standard credential chain (env vars, shared credentials, SSO). Custom command runs shell commands to refresh credentials.',
				aliases: ['credentials', 'sso', 'login'],
				control: {
					type: 'dropdown',
					key: key('credentialMode'),
					defaultValue: 'sdk',
					options: { 'sdk': 'SDK (default)', 'custom-command': 'Custom command' },
				},
			},
			{
				name: 'Credential refresh commands',
				desc: 'Enter the commands to refresh AWS credentials (one per line). You can use ${awsAccountId} and ${awsProfile} as variables.',
				aliases: ['credentials', 'sso login', 'shell'],
				visible: customCommand,
				control: { type: 'textarea', key: key('credentialRefreshCommands'), placeholder: 'aws sso login --profile notes' },
			},
			{
				name: 'AWS CLI path (optional)',
				desc: 'Full path to the aws binary (e.g. /opt/homebrew/bin/aws). Used as a fallback to run "aws sso login" when SDK-native renewal cannot refresh an expired SSO session.',
				aliases: ['aws cli', 'sso login', 'binary'],
				visible: () => !customCommand(),
				control: { type: 'text', key: key('awsCliPath'), placeholder: '/opt/homebrew/bin/aws' },
			},
			{
				name: 'CloudFront invalidation scheme',
				desc: 'When to trigger CloudFront invalidations',
				aliases: ['CloudFront', 'cache', 'invalidate'],
				control: {
					type: 'dropdown',
					key: key('cloudFrontInvalidationScheme'),
					defaultValue: 'individual',
					options: {
						individual: 'Individual note',
						connected: 'Active & Connected',
						sinceLast: 'Since last full publish',
						all: 'Publish all',
						manual: 'Manual',
					},
				},
			},
			{
				name: 'CloudFront Distribution ID',
				desc: 'The ID of your CloudFront distribution for cache invalidation',
				aliases: ['CloudFront', 'cache', 'distribution'],
				control: { type: 'text', key: key('cloudFrontDistributionId'), placeholder: 'E1234ABCDEF5GH' },
			},
		],
	};
}
