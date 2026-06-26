import { Component, MarkdownRenderer } from 'obsidian';
import CommonplaceNotesPlugin from '../main';
import { Logger } from './logging';

export async function convertMarkdownToPlaintext(markdown: string, plugin: CommonplaceNotesPlugin): Promise<string> {
	try {
		// Clean up problematic syntax
		let cleanMarkdown = markdown;
		cleanMarkdown = cleanMarkdown
			// Preserve dataview query contents by just removing the backticks and dataview keyword
			.replace(/```dataview\n([\s\S]*?)```/g, '$1')
			// Remove HTML comments
			.replace(/<!--[\s\S]*?-->/g, '')

		// Convert to plaintext. Use a short-lived Component to own the lifecycle of
		// any event handlers registered during the render, so they get cleaned up
		// when we unload it (avoids the "not passing Component" memory-leak warning).
		const element = document.createElement('div');
		const component = new Component();
		component.load();
		try {
			await MarkdownRenderer.render(
				plugin.app,
				cleanMarkdown,
				element,
				'',
				component
			);
		} catch (renderError) {
			Logger.warn(`Render error, falling back to basic cleanup:`, renderError);
			return cleanMarkdown;
		} finally {
			component.unload();
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