import { Plugin, MarkdownView, Notice, App, TFile } from 'obsidian';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { PathUtils } from './utils/path';
import remarkObsidianLinks from './remarkObsidianLinks';

export default class CommonplaceNotesPlugin extends Plugin {
  async onload() {
    console.log('Loading CommonplaceNotesPlugin');
	
    this.addCommand({
      id: 'convert-note-to-html',
      name: 'Convert current note to HTML',
      callback: async () => {
        await this.convertCurrentNote();
      }
    });
  }

  // Helper method to ensure directory exists
  private async ensureDirectory(path: string): Promise<void> {
    const dirs = path.split('/');
    let currentPath = '';
    
    for (const dir of dirs) {
      currentPath += dir + '/';
      if (!(await this.app.vault.adapter.exists(currentPath))) {
        await this.app.vault.adapter.mkdir(currentPath);
      }
    }
  }
  
private getBacklinksHtml(currentFile: TFile): string {
  // Get resolved links from metadata cache
  const resolvedLinks = this.app.metadataCache.resolvedLinks;
  const backlinks = new Set<string>();

  // Find all files that link to the current file
  Object.entries(resolvedLinks).forEach(([sourcePath, links]) => {
    if (links[currentFile.path]) {
      backlinks.add(sourcePath);
    }
  });
  
  if (backlinks.size === 0) {
    return ''; // Return empty string if no backlinks
  }

  // Convert backlinks to HTML
  const backlinksHtml = Array.from(backlinks)
    .map(filePath => {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) return null;
      
      // Generate slug for the linking file
      const linkingFileSlug = PathUtils.slugifyFilePath(file.path);
      // Generate relative path from current file to linking file
      const relativePath = PathUtils.createRelativePath(
        PathUtils.slugifyFilePath(currentFile.path),
        linkingFileSlug
      );
      
      return `<li><a href="${relativePath}">${file.basename}</a></li>`;
    })
    .filter((link): link is string => link !== null) // Type guard to filter out null values
    .join('\n');

  if (!backlinksHtml) {
    return '';
  }

  return `
<hr>
<div class="backlinks">
  <h2>Backlinks</h2>
  <ul>
    ${backlinksHtml}
  </ul>
</div>`;
}

  async convertCurrentNote() {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    
    if (!activeView?.file) {
      new Notice('No active markdown file');
      return;
    }

    try {
      const file = activeView.file;
      const cache = this.app.metadataCache.getFileCache(file);
      const content = await this.app.vault.read(file);
	  
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
      //const html = await this.markdownToHtml(contentWithoutFrontmatter);
	  const html = await this.markdownToHtml(contentWithoutFrontmatter, file);
      
      // Get backlinks HTML
      const backlinksHtml = this.getBacklinksHtml(file);
	  console.log(backlinksHtml);
      
	  // Create the output directory if it doesn't exist
	  const pluginDir = this.manifest.dir;
      const outputDir = `${pluginDir}/html-export`;
      await this.ensureDirectory(outputDir);
	  
	  // Generate output filename (same as input but with .html extension)
      const outputFilename = slug + '.html';
      const outputPath = `${outputDir}/${outputFilename}`;
      
	  // Create a basic HTML document structure
      const fullHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${file.basename}</title>
    <meta name="slug" content="${slug}">
    <style>
      .backlinks {
        margin-top: 2rem;
        padding-top: 1rem;
      }
      .backlinks h2 {
        font-size: 1.2rem;
        margin-bottom: 0.5rem;
      }
      .backlinks ul {
        margin: 0;
        padding-left: 1.5rem;
      }
    </style>
</head>
<body data-slug="${slug}">
${html}
${backlinksHtml}
</body>
</html>`;
      
	  // Save the file
      await this.app.vault.adapter.write(outputPath, fullHtml);
	  
      new Notice(`HTML file saved to ${outputPath}`);
    } catch (error) {
      new Notice(`Error converting to HTML: ${error.message}`);
      console.error('HTML conversion error:', error);
    }
  }

  async markdownToHtml(markdown: string, currentFile: TFile): Promise<string> {
    const currentSlug = PathUtils.slugifyFilePath(currentFile.path);
    
    const processor = unified()
      .use(remarkParse)
      .use(remarkObsidianLinks, {
        currentSlug,
        resolveInternalLinks: (linkText: string) => {
          const [link, alias] = linkText.split('|');
          const targetFile = this.app.metadataCache.getFirstLinkpathDest(link, currentFile.path);
          
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

  onunload() {
    console.log('Unloading CommonplaceNotesPlugin');
  }
}