import { Notice, TFile, MarkdownView } from 'obsidian';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import CommonplaceNotesPublisherPlugin from '../main';
import { PathUtils, ensureDirectory } from '../utils/path';
import remarkObsidianLinks from '../utils/remarkObsidianLinks';

interface BacklinkInfo {
	slug: string;
	title: string;
}

interface NoteOutputJson {
	slug: string;
	title: string;
	content: string;
	backlinks: BacklinkInfo[];
}

export function getBacklinks(plugin: CommonplaceNotesPublisherPlugin, targetFile: TFile) {
	// Get resolved links from metadata cache
	const resolvedLinks = plugin.app.metadataCache.resolvedLinks;
	console.log(resolvedLinks);
	const backlinks: BacklinkInfo[] = [];

	// Find all files that link to the current file
	Object.entries(resolvedLinks).forEach(([sourcePath, links]) => {
		if (links[targetFile.path]) {
			console.log(`Found path: ${sourcePath}`);
			const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
			if (file instanceof TFile) {
				backlinks.push({
					slug: PathUtils.slugifyFilePath(file.path),
					title: file.basename
				});
			}
		}
	});
	console.log(backlinks);
	console.log(JSON.stringify(backlinks));
	return backlinks;
}

export async function convertCurrentNote(plugin: CommonplaceNotesPublisherPlugin) {
	const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	
	if (!activeView?.file) {
		new Notice('No active markdown file');
		return;
	}

	try {
		const file = activeView.file;
		const cache = plugin.app.metadataCache.getFileCache(file);
		const content = await plugin.app.vault.read(file);

		// Generate slug for the current file
		const slug = PathUtils.slugifyFilePath(file.path);
		console.log(`Generated slug: ${slug}`);

		// Remove frontmatter if it exists
		let contentWithoutFrontmatter = content;
		if (cache?.frontmatter && cache.frontmatterPosition) {
			const frontmatterEnd = cache.frontmatterPosition.end.offset;
			contentWithoutFrontmatter = content.slice(frontmatterEnd).trim();
		}

		// Convert to HTML
		const html = await markdownToHtml(plugin, contentWithoutFrontmatter, file);

		// Get backlinks
		const backlinks = getBacklinks(plugin, file);
		

		// Create the output directory if it doesn't exist
		const pluginDir = plugin.manifest.dir;
		const outputDir = `${pluginDir}/notes`;
		await ensureDirectory(plugin, outputDir);

		// Generate output filename (same as input but with .html extension)
		const outputFilename = slug + '.json';
		const outputPath = `${outputDir}/${outputFilename}`;

		// Craft a JSON to write
		const output: NoteOutputJson = {
			slug: slug,
			title: file.basename,
			content: html,
			backlinks: backlinks
		};

		// Save the file
		await plugin.app.vault.adapter.write(outputPath, JSON.stringify(output));

		new Notice(`Note output saved to ${outputPath}`);
	} catch (error) {
		new Notice(`Error converting note: ${error.message}`);
		console.error('Note conversion error:', error);
	}
}

export async function markdownToHtml(plugin: CommonplaceNotesPublisherPlugin, markdown: string, currentFile: TFile): Promise<string> {
	const currentSlug = PathUtils.slugifyFilePath(currentFile.path);
	
	const processor = unified()
		.use(remarkParse)
		.use(remarkObsidianLinks, {
			currentSlug,
			resolveInternalLinks: (linkText: string) => {
				const [link, alias] = linkText.split('|');
				const targetFile = plugin.app.metadataCache.getFirstLinkpathDest(link, currentFile.path);
				
				if (targetFile) {
					return {
						slug: PathUtils.slugifyFilePath(targetFile.path),
						displayText: alias || link
					};
				}
				
				return null;
			}
		})
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeStringify);
	
	const result = await processor.process(markdown);
	return result.toString();
}