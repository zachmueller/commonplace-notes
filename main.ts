import { Plugin, MarkdownView, Notice, App, TFile } from 'obsidian';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { PathUtils } from './utils/path';
import { LinkProcessor } from './LinkProcessor';
import remarkObsidianLinks from './remarkObsidianLinks';

export default class CommonplaceNotesPlugin extends Plugin {
  private linkProcessor: LinkProcessor;

  async onload() {
    console.log('Loading CommonplaceNotesPlugin');
	this.linkProcessor = new LinkProcessor(this.app);

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
	  
      // Get link data
      const linkData = this.linkProcessor.getLinkData(file);
	  
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
      
	  // Create the output directory if it doesn't exist
      const outputDir = '.obsidian/plugins/commonplace-notes/html-export';
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
    <script>
      window.pageData = ${JSON.stringify({
        slug,
        links: linkData
      }, null, 2)};
    </script>
</head>
<body data-slug="${slug}">
${html}
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
/*
  async markdownToHtml(markdown: string): Promise<string> {
    const processor = unified()
      .use(remarkParse)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeStringify);
    
    const result = await processor.process(markdown);
    return result.toString();
  }
*/
async markdownToHtml(markdown: string, currentFile: TFile): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkObsidianLinks, {
      baseUrl: '', // Or your desired base URL, e.g., 'http://example.com'
      resolveInternalLinks: (linkText: string) => {
        // Split link text and alias if present
        const [link, alias] = linkText.split('|');
        
        // Use Obsidian's link resolution
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