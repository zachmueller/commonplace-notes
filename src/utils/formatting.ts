import { TFile, MarkdownView, MarkdownRenderer } from 'obsidian';

export async function convertMarkdownToPlaintext(file: TFile): Promise<string> {
	try {
		// Check if file exists and is markdown
		if (!file || file.extension !== 'md') {
			throw new Error('Not a markdown file');
		}

		// Get the cached file metadata
		const markdown = await this.app.vault.read(file);
		const cache = this.app.metadataCache.getFileCache(file);

		// Remove any frontmatter
		let cleanMarkdown = markdown;
		if (cache?.frontmatter && cache.frontmatterPosition) {
			const frontmatterEnd = cache.frontmatterPosition.end.offset;
			cleanMarkdown = markdown.slice(frontmatterEnd).trim();
		}

		// Convert to plaintext
		const element = document.createElement('div');
		await MarkdownRenderer.renderMarkdown(
			cleanMarkdown,
			element,
			'',
			this
		);
		return element.innerText;
	} catch (error) {
		console.error('Error converting Markdown:', error);
		throw error;
	}
}