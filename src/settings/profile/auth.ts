import { Setting } from 'obsidian';
import { ProfileContext } from '../context';
import { initAWSSettings } from './shared';

/**
 * "Authentication & Delivery" section (AWS profiles): AWS account/profile/region,
 * credential mode (+ conditional refresh commands / CLI path), and CloudFront
 * invalidation scheme + distribution ID.
 */
export function renderAuthSection(ctx: ProfileContext, containerEl: HTMLElement): void {
	const { plugin, profile } = ctx;
	initAWSSettings(profile);

	new Setting(containerEl)
		.setName('AWS account ID')
		.setDesc('The AWS account ID to use for authentication')
		.addText(text => text
			.setPlaceholder('123456789012')
			.setValue(profile.awsSettings?.awsAccountId || '')
			.onChange(async (value) => {
				if (profile.awsSettings) {
					profile.awsSettings.awsAccountId = value;
					await plugin.saveSettings();
				}
			}));

	new Setting(containerEl)
		.setName('AWS profile')
		.setDesc('The AWS profile to use for authentication')
		.addText(text => text
			.setPlaceholder('notes')
			.setValue(profile.awsSettings?.awsProfile || '')
			.onChange(async (value) => {
				if (profile.awsSettings) {
					profile.awsSettings.awsProfile = value;
					await plugin.saveSettings();
				}
			}));

	new Setting(containerEl)
		.setName('AWS region')
		.setDesc('The AWS region where your bucket is located')
		.addText(text => text
			.setPlaceholder('us-east-1')
			.setValue(profile.awsSettings?.region || '')
			.onChange(async (value) => {
				if (profile.awsSettings) {
					profile.awsSettings.region = value;
					await plugin.saveSettings();
				}
			}));

	new Setting(containerEl)
		.setName('Credential mode')
		.setDesc('SDK uses the standard credential chain (env vars, shared credentials, SSO). Custom command runs shell commands to refresh credentials.')
		.addDropdown(dropdown => dropdown
			.addOption('sdk', 'SDK (default)')
			.addOption('custom-command', 'Custom command')
			.setValue(profile.awsSettings?.credentialMode || 'sdk')
			.onChange(async (value: 'sdk' | 'custom-command') => {
				if (profile.awsSettings) {
					profile.awsSettings.credentialMode = value;
					await plugin.saveSettings();
					ctx.rerenderProfile();
				}
			}));

	if (profile.awsSettings!.credentialMode === 'custom-command') {
		new Setting(containerEl)
			.setName('Credential refresh commands')
			.setDesc('Enter the commands to refresh AWS credentials (one per line). You can use ${awsAccountId} and ${awsProfile} as variables.')
			.addTextArea(text => text
				.setPlaceholder('aws sso login --profile notes')
				.setValue(profile.awsSettings?.credentialRefreshCommands || '')
				.onChange(async (value) => {
					if (profile.awsSettings) {
						profile.awsSettings.credentialRefreshCommands = value;
						await plugin.saveSettings();
					}
				}));
	} else {
		new Setting(containerEl)
			.setName('AWS CLI path (optional)')
			.setDesc('Full path to the aws binary (e.g. /opt/homebrew/bin/aws). Used as a fallback to run "aws sso login" when SDK-native renewal cannot refresh an expired SSO session.')
			.addText(text => text
				.setPlaceholder('/opt/homebrew/bin/aws')
				.setValue(profile.awsSettings?.awsCliPath || '')
				.onChange(async (value) => {
					if (profile.awsSettings) {
						profile.awsSettings.awsCliPath = value;
						await plugin.saveSettings();
					}
				}));
	}

	new Setting(containerEl)
		.setName('CloudFront invalidation scheme')
		.setDesc('When to trigger CloudFront invalidations')
		.addDropdown(dropdown => dropdown
			.addOption('individual', 'Individual note')
			.addOption('connected', 'Active & Connected')
			.addOption('sinceLast', 'Since last full publish')
			.addOption('all', 'Publish all')
			.addOption('manual', 'Manual')
			.setValue(profile.awsSettings?.cloudFrontInvalidationScheme || 'individual')
			.onChange(async (value: any) => {
				if (profile.awsSettings) {
					profile.awsSettings.cloudFrontInvalidationScheme = value;
					await plugin.saveSettings();
				}
			}));

	new Setting(containerEl)
		.setName('CloudFront Distribution ID')
		.setDesc('The ID of your CloudFront distribution for cache invalidation')
		.addText(text => text
			.setPlaceholder('E1234ABCDEF5GH')
			.setValue(profile.awsSettings?.cloudFrontDistributionId || '')
			.onChange(async (value) => {
				if (profile.awsSettings) {
					profile.awsSettings.cloudFrontDistributionId = value;
					await plugin.saveSettings();
				}
			}));
}
