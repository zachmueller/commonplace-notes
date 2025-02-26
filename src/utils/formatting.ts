import { TFile, MarkdownView, MarkdownRenderer } from 'obsidian';
import { Logger } from './logging';

export async function convertMarkdownToPlaintext(file: TFile): Promise<string> {
	try {
		// Check if file exists and is markdown
		if (!file || file.extension !== 'md') {
			throw new Error('Not a markdown file');
		}

		// Get the cached file metadata
		Logger.debug(`Converting ${file.basename} to plaintext`);
		const markdown = await this.app.vault.read(file);
		const cache = this.app.metadataCache.getFileCache(file);

		// Remove any frontmatter
		let cleanMarkdown = markdown;
		if (cache?.frontmatter && cache.frontmatterPosition) {
			const frontmatterEnd = cache.frontmatterPosition.end.offset;
			cleanMarkdown = markdown.slice(frontmatterEnd).trim();
		}

		// Clean up problematic syntax
		 cleanMarkdown = cleanMarkdown
			// Preserve dataview query contents by just removing the backticks and dataview keyword
			.replace(/```dataview\n([\s\S]*?)```/g, '$1')
			// Remove HTML comments
			.replace(/<!--[\s\S]*?-->/g, '')

		// Convert to plaintext
		const element = document.createElement('div');
		try {
			await MarkdownRenderer.renderMarkdown(
				cleanMarkdown,
				element,
				'',
				this
			);
		} catch (renderError) {
			Logger.warn(`Render error for ${file.path}, falling back to basic cleanup:`, renderError);
			return cleanMarkdown;
		}
		// Extract text content
        const textContent = element.innerText || element.textContent || cleanMarkdown;

		// Clean up whitespace
        return textContent
            .replace(/\n\s*\n/g, '\n\n')  // Normalize multiple newlines
            .trim();
	} catch (error) {
		Logger.error('Error converting Markdown:', error);
		throw error;
	}
}