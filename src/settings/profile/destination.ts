import { Setting } from 'obsidian';
import { ProfileContext } from '../context';
import { initAWSSettings } from './shared';
import { renderInfrastructureSection } from './infrastructure';
import { renderAuthSection } from './auth';
import { renderSiteCustomizationSection } from './siteCustomization';

/**
 * "Destination" section: publish mechanism + base URL, then mechanism-specific
 * settings. For AWS this also spawns the Infrastructure, Authentication &
 * Delivery, and Site Customization sections (each its own collapsible), because
 * they only apply to AWS profiles. `profileContainer` is the parent the extra
 * AWS sections are appended to (siblings of Destination, not children).
 */
export function renderDestinationSection(
	ctx: ProfileContext,
	destSection: HTMLElement,
	profileContainer: HTMLElement,
): void {
	const { plugin, profile, index } = ctx;

	new Setting(destSection)
		.setName('Publish mechanism')
		.addDropdown(dropdown => dropdown
			.addOption('AWS', 'AWS')
			.addOption('Local', 'Local')
			.setValue(profile.publishMechanism)
			.onChange(async (value: 'AWS' | 'Local') => {
				plugin.settings.publishingProfiles[index].publishMechanism = value;
				await plugin.saveSettings();
				ctx.rerenderProfile();
			}));

	new Setting(destSection)
		.setName('Base URL')
		.setDesc('Base URL for published notes')
		.addText(text => text
			.setValue(profile.baseUrl)
			.onChange(async (value) => {
				plugin.settings.publishingProfiles[index].baseUrl = value;
				await plugin.saveSettings();
			}));

	if (profile.publishMechanism === 'AWS') {
		renderAWSDestinationSettings(ctx, destSection);

		const infraSection = ctx.createSection(profileContainer, 'Infrastructure');
		renderInfrastructureSection(ctx, infraSection);

		const authSection = ctx.createSection(profileContainer, 'Authentication & Delivery');
		renderAuthSection(ctx, authSection);

		const siteSection = ctx.createSection(profileContainer, 'Site Customization');
		renderSiteCustomizationSection(ctx, siteSection);
	} else {
		renderLocalSettings(ctx, destSection);
	}
}

function renderAWSDestinationSettings(ctx: ProfileContext, containerEl: HTMLElement): void {
	const { plugin, profile } = ctx;
	initAWSSettings(profile);

	new Setting(containerEl)
		.setName('S3 bucket name')
		.setDesc('The name of the S3 bucket to upload to')
		.addText(text => text
			.setPlaceholder('my-notes-bucket')
			.setValue(profile.awsSettings?.bucketName || '')
			.onChange(async (value) => {
				if (profile.awsSettings) {
					profile.awsSettings.bucketName = value;
					await plugin.saveSettings();
				}
			}));

	new Setting(containerEl)
		.setName('S3 prefix')
		.setDesc('Optional prefix path in the S3 bucket (e.g., "site/"). Leave empty to use bucket root.')
		.addText(text => text
			.setPlaceholder('notes/')
			.setValue(profile.awsSettings?.s3Prefix || '')
			.onChange(async (value) => {
				if (profile.awsSettings) {
					profile.awsSettings.s3Prefix = value ?
						(value.endsWith('/') ? value : `${value}/`) :
						'';
					await plugin.saveSettings();
				}
			}));
}

function renderLocalSettings(_ctx: ProfileContext, _containerEl: HTMLElement): void {
	// Display Local-specific settings when implemented
}
