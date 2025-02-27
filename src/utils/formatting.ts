import { MarkdownRenderer } from 'obsidian';
import { Logger } from './logging';

export async function convertMarkdownToPlaintext(markdown: string): Promise<string> {
	try {
		// Clean up problematic syntax
		let cleanMarkdown = markdown;
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
			Logger.warn(`Render error, falling back to basic cleanup:`, renderError);
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