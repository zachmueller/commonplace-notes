import { App, PluginSettingTab, Setting } from 'obsidian';
import CommonplaceNotesPublisherPlugin from './main';

export class CommonplaceNotesPublisherSettingTab extends PluginSettingTab {
    plugin: CommonplaceNotesPublisherPlugin;

    constructor(app: App, plugin: CommonplaceNotesPublisherPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('AWS Account ID')
            .setDesc('The AWS account ID to use for authentication')
            .addText(text => text
                .setPlaceholder('123456789012')
                .setValue(this.plugin.settings.awsAccountId)
                .onChange(async (value) => {
                    this.plugin.settings.awsAccountId = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('AWS Profile')
            .setDesc('The AWS profile to use for authentication')
            .addText(text => text
                .setPlaceholder('notes')
                .setValue(this.plugin.settings.awsProfile)
                .onChange(async (value) => {
                    this.plugin.settings.awsProfile = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('S3 Bucket Name')
            .setDesc('The name of the S3 bucket to upload to')
            .addText(text => text
                .setPlaceholder('my-notes-bucket')
                .setValue(this.plugin.settings.bucketName)
                .onChange(async (value) => {
                    this.plugin.settings.bucketName = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('AWS Region')
            .setDesc('The AWS region where your bucket is located')
            .addText(text => text
                .setPlaceholder('us-east-1')
                .setValue(this.plugin.settings.region)
                .onChange(async (value) => {
                    this.plugin.settings.region = value;
                    await this.plugin.saveSettings();
                }));

		new Setting(containerEl)
			.setName('Credential Refresh Commands')
			.setDesc('Enter the commands to refresh AWS credentials (one per line). You can use ${awsAccountId} and ${awsProfile} as variables.')
			.addTextArea(text => text
				.setPlaceholder('aws sso login --profile notes')
				.setValue(this.plugin.settings.credentialRefreshCommands)
				.onChange(async (value) => {
					this.plugin.settings.credentialRefreshCommands = value;
					await this.plugin.saveSettings();
				}));
    }
}