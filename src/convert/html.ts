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
	uid: string;
	slug: string;
	title: string;
	content: string;
	backlinks: BacklinkInfo[];
	hash: string;
	lastUpdated: number;
	raw: string;
	priorHash: string | null;
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

export async function getSHA1Hash(content: string): Promise<string> {
	const msgUint8 = new TextEncoder().encode(content);
	const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
	return hashHex;
}

export async function convertNotetoJSON(plugin: CommonplaceNotesPublisherPlugin, file: TFile) {
	try {
		// Capture last updated timestamp ahead of any possible other modifications
		const updatedTimestamp = file.stat.mtime;

		// Capture UID of the note
		const fm = new FrontmatterManager(plugin.app);
		const uid = await fm.getNoteUID(file);
		const cache = plugin.app.metadataCache.getFileCache(file);

		// Generate slug for the current file
		const slug = PathUtils.slugifyFilePath(file.path);
		console.log(`Generated slug: ${slug}`);

		// Remove frontmatter if it exists
		let content = await plugin.app.vault.read(file);
		if (cache?.frontmatter && cache.frontmatterPosition) {
			const frontmatterEnd = cache.frontmatterPosition.end.offset;
			content = content.slice(frontmatterEnd).trim();
		}

		// Calculate new hash
		const newHash = await getSHA1Hash(`${uid}::${content}`);

		// Get prior hash from frontmatter
		let priorHash = fm.getFrontmatterValue(file, 'cpn-prior-hash');

		// Only update the prior hash in frontmatter if the hash has changed
		if (!priorHash || priorHash !== newHash) {
			await fm.add(file, {'cpn-prior-hash': newHash});
			await fm.process();
		}

		// Handle cases where prior hash was previously null
		if (priorHash === newHash) {
			priorHash = null;
		}
		// TODO::still remaining edge cases here where it might erroneously 
		//   result in priorHash being null from consecutive publishings.
		//   Need to continue deep diving to sort out proper logic to make
		//   this more robust::

		// Convert to HTML
		const html = await markdownToHtml(plugin, content, file);

		// Update mappings
		plugin.mappingManager.updateMappings(slug, uid, newHash);
		await plugin.mappingManager.saveMappings();

		// Get backlinks
		const backlinks = await getBacklinks(plugin, file);

		// Craft a JSON to write
		const output: NoteOutputJson = {
			uid: uid,
			slug: slug,
			title: file.basename,
			content: html,
			backlinks: backlinks,
			hash: newHash,
			lastUpdated: updatedTimestamp,
			raw: content,
			priorHash: priorHash || null
		};

		// Generate output file
		const outputDir = `${plugin.manifest.dir}/notes`;
		await PathUtils.ensureDirectory(plugin, outputDir);
		const outputPath = `${outputDir}/${newHash}.json`;
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