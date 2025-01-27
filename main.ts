import { Plugin, MarkdownView, Notice, App, TFile } from 'obsidian';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { PathUtils } from './utils/path';

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
      const html = await this.markdownToHtml(contentWithoutFrontmatter);
      
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

  async markdownToHtml(markdown: string): Promise<string> {
    const processor = unified()
      .use(remarkParse)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeStringify);
    
    const result = await processor.process(markdown);
    return result.toString();
  }

  onunload() {
    console.log('Unloading CommonplaceNotesPlugin');
  }
}