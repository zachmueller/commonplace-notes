import CommonplaceNotesPlugin from '../main';
import { Logger } from './logging';
import { PathUtils } from './path';
import { NoticeManager } from './notice';

export class TemplateManager {
	private plugin: CommonplaceNotesPlugin;
	private readonly DEFAULT_TEMPLATE_URL = 'https://raw.githubusercontent.com/zachmueller/commonplace-notes/main/templates/local-template.html';

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
	}

	async ensureLocalTemplate(): Promise<boolean> {
		const templatePath = this.plugin.profileManager.getLocalTemplateHtmlPath();

		// Check if template already exists
		if (await this.plugin.app.vault.adapter.exists(templatePath)) {
			Logger.debug('Local template file already exists');
			return true;
		}

		// Try to download default template
		Logger.info('Local template not found, attempting to download default template from GitHub');

		try {
			const { success, error } = await NoticeManager.showProgress(
				'Downloading default template from GitHub',
				this.downloadDefaultTemplate(templatePath),
				'Successfully downloaded default template',
				'Failed to download template from GitHub'
			);

			return success;
		} catch (error) {
			Logger.error('Failed to download default template:', error);
			NoticeManager.showNotice('Failed to download HTML template.');
			return false;
		}
	}

	private async downloadDefaultTemplate(templatePath: string): Promise<void> {
		// Ensure template directory exists
		const templateDir = this.plugin.profileManager.getTemplateDir();
		await PathUtils.ensureDirectory(this.plugin, templateDir);

		// Download the template
		const response = await fetch(this.DEFAULT_TEMPLATE_URL);

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		const templateContent = await response.text();

		// Validate that it looks like an HTML template
		if (!templateContent.includes('{{NOTES_JSON}}')) {
			throw new Error('Downloaded file does not appear to be a valid template');
		}

		// Write to local file
		await this.plugin.app.vault.adapter.write(templatePath, templateContent);
		Logger.info(`Downloaded default template to ${templatePath}`);
	}
}