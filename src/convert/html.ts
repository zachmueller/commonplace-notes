import { Notice, TFile, MarkdownView } from 'obsidian';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import CommonplaceNotesPublisherPlugin from '../main';
import { PathUtils } from '../utils/path';
import { generateUID } from '../utils/uid';
import { FrontmatterManager } from '../utils/frontmatter';
import remarkObsidianLinks, { ResolvedNoteInfo } from '../utils/remarkObsidianLinks';

interface BacklinkInfo {
	uid: string;
	slug: string;
	title: string;
}

interface NoteOutputJson {
	slug: string;
	title: string;
	content: string;
	backlinks: BacklinkInfo[];
}

export async function getBacklinks(plugin: CommonplaceNotesPublisherPlugin, targetFile: TFile): Promise<BacklinkInfo[]> {
	// Get resolved links from metadata cache
	const resolvedLinks = plugin.app.metadataCache.resolvedLinks;
	console.log(resolvedLinks);
	const backlinks: BacklinkInfo[] = [];

	// Find all files that link to the current file
	const promises = Object.entries(resolvedLinks).map(async ([sourcePath, links]) => {
		if (links[targetFile.path]) {
			console.log(`Found path: ${sourcePath}`);
			const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
			if (file instanceof TFile) {
				const fm = new FrontmatterManager(plugin.app);
				const uid = await fm.getNoteUID(file);
				return {
					uid: uid,
					slug: PathUtils.slugifyFilePath(file.path),
					title: file.basename
				};
			}
		}
		return null;
	});

	// Wait for all promises to resolve and filter out null values
	const results = await Promise.all(promises);
	const filteredResults = results.filter((result): result is BacklinkInfo => result !== null);

	console.log(filteredResults);
	console.log(JSON.stringify(filteredResults));
	return filteredResults;
}

export async function convertCurrentNote(plugin: CommonplaceNotesPublisherPlugin) {
	const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	
	if (!activeView?.file) {
		new Notice('No active markdown file');
		return;
	}

	try {
		const file = activeView.file;
		const fm = new FrontmatterManager(plugin.app);
		const uid = await fm.getNoteUID(file);
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
		const backlinks = await getBacklinks(plugin, file);
		

		// Create the output directory if it doesn't exist
		const pluginDir = plugin.manifest.dir;
		const outputDir = `${pluginDir}/notes`;
		await PathUtils.ensureDirectory(plugin, outputDir);

		// Generate output filename (same as input but with .html extension)
		const outputFilename = `${uid}.json`;
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
	const processor = unified()
		.use(remarkParse)
		.use(remarkObsidianLinks, {
			frontmatterManager: plugin.frontmatterManager,
			resolveInternalLinks: async (linkText: string): Promise<ResolvedNoteInfo | null> => {
				const [link, alias] = linkText.split('|');
				const targetFile = plugin.app.metadataCache.getFirstLinkpathDest(link, currentFile.path);
				
				if (targetFile instanceof TFile) {
					try {
						const uid = await plugin.frontmatterManager.getNoteUID(targetFile);
						return {
							uid,
							title: targetFile.basename,
							displayText: alias || link
						};
					} catch (error) {
						console.error(`Failed to get UID for file ${targetFile.path}:`, error);
						return null;
					}
				}
				
				return null;
			}
		})
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeStringify);
	
	const result = await processor.process(markdown);
	return result.toString();
}