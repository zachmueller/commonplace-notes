import { Plugin, MarkdownView, Notice, App, TFile, PluginSettingTab, Setting } from 'obsidian';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { PathUtils } from './utils/path';
import remarkObsidianLinks from './utils/remarkObsidianLinks';
import { exec } from 'child_process';
import { promisify } from 'util';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as path from 'path';

const execAsync = promisify(exec);

interface CommonplaceNotesPublisherSettings {
    awsAccountId: string;
    awsProfile: string;
    awsRole: string;
    bucketName: string;
    region: string;
}

const DEFAULT_SETTINGS: CommonplaceNotesPublisherSettings = {
	awsAccountId: '123456789012',
	awsProfile: 'notes',
	awsRole: 'Admin',
	bucketName: 'my-bucket',
	region: 'us-east-1'
};

export default class CommonplaceNotesPublisherPlugin extends Plugin {
	settings: CommonplaceNotesPublisherSettings;
	private s3Client: S3Client | null = null;
	
	async onload() {
		await this.loadSettings();
		this.addSettingTab(new CommonplaceNotesPublisherSettingTab(this.app, this));

		this.addCommand({
			id: 'convert-note-to-html',
			name: 'Convert current note to HTML',
			callback: async () => {
				await this.convertCurrentNote();
			}
		});

		this.addCommand({
			id: 'refresh-credentials',
			name: 'Refresh AWS credentials',
			callback: async () => {
				await this.refreshCredentials();
			}
		});

		this.addCommand({
			id: 'publish-note',
			name: 'Publish note to S3',
			callback: async () => {
				await this.pushData();
			}
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async refreshMwinit() {
		try {
			new Notice('Refreshing mwinit...');
			await execAsync('start mwinit');
			new Notice('Successfully refreshed mwinit');
		} catch (error) {
			console.error('Failed to refresh mwinit:', error);
		}
	}

	private async checkAwsCredentials() {
		try {
			new Notice('Refreshing mwinit...');
			const { stdout } = await execAsync('aws sts get-caller-identity --output json');
			new Notice('Successfully refreshed mwinit');
		} catch (error) {
			console.error('Failed to refresh mwinit:', error);
		}
	}

	private async refreshCredentials() {
		try {
			new Notice('Refreshing AWS credentials');
			await execAsync(`ada credentials update --account=${this.settings.awsAccountId} --provider=isengard --role=${this.settings.awsRole} --profile=${this.settings.awsProfile} --once`);
			return;
		} catch (error) {
			console.error('Failed to refresh credentials:', error);
			throw error;
		}
	}
/*
	private async getCredentials(): Promise<AwsCredentials> {
		try {
			new Notice('Getting AWS credentials');
			const [accessKeyId, secretKey, sessionToken] = await Promise.all([
				execAsync(`aws configure get aws_access_key_id --profile ${this.settings.awsProfile}`),
				execAsync(`aws configure get aws_secret_access_key --profile ${this.settings.awsProfile}`),
				execAsync(`aws configure get aws_session_token --profile ${this.settings.awsProfile}`)
			]);
			new Notice(`Successfully refreshed: ${accessKeyId.stdout.trim()}`);
			return {
				AccessKeyId: accessKeyId.stdout.trim(),
				SecretAccessKey: secretKey.stdout.trim(),
				SessionToken: sessionToken.stdout.trim()
			};
		} catch (error) {
			console.error('Failed to get credentials:', error);
			throw error;
		}
	}

	private async initializeS3Client() {
		try {
			const credentials = await this.getCredentials();
			
			this.s3Client = new S3Client({
				region: this.settings.region,
				credentials: {
					accessKeyId: credentials.AccessKeyId,
					secretAccessKey: credentials.SecretAccessKey,
					sessionToken: credentials.SessionToken
				}
			});
		} catch (error) {
			console.error('Failed to initialize S3 client:', error);
			throw error;
		}
	}

	private validateS3Config() {
		if (!this.s3Client) {
			throw new Error('S3 client not initialized');
		}
		
		const config = this.s3Client.config;
		if (!config.region || config.region === 'your-region') {
			throw new Error('S3 region not properly configured');
		}
		
		if (!config.credentials) {
			throw new Error('AWS credentials not found');
		}
	}

	private async publishNote() {
		if (!this.s3Client) {
			await this.initializeS3Client();
		}
		
		this.validateS3Config();
		const payload = {
			slug: 'test',
			title: 'Test',
			content: 'This is a basic test of uploading',
			backlinks: [{slug:'sliding-panes', title: 'Sliding Panes'}],
		};

		try {
			// Upload to S3
			const command = new PutObjectCommand({
				Bucket: this.settings.bucketName,
				Key: `notes/test.json`,
				Body: JSON.stringify(payload),
				ContentType: 'application/json'
			});

			await this.s3Client?.send(command);
			
			new Notice('Note published to S3 successfully!');
		} catch (error) {
            console.error('Failed to publish note:', error);
            new Notice('Failed to publish note to S3');
        }
	}
*/
	private async pushData() {
		const basePath = (this.app.vault.adapter as any).basePath;
		const localJsonDirectory = path.join(basePath, '.obsidian', 'plugins', 'commonplace-notes-publisher', 'notes');
		const sourcePathEscaped = `"${path.resolve(localJsonDirectory)}"`;
		console.log(sourcePathEscaped);
		const s3Path = `s3://${this.settings.bucketName}/notes/`;
		const options = {
			cwd: (this.app.vault.adapter as any).basePath
		};
		try {
			const command = `aws s3 cp ${sourcePathEscaped} ${s3Path} --recursive --profile ${this.settings.awsProfile}`;
			console.log('Executing command:', command);
			
			const { stdout, stderr } = await execAsync(command, options);
			console.log('Output:', stdout);
			if (stderr) console.error('Errors:', stderr);
		} catch (error) {
			console.error('Error executing AWS command:', error);
		}
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
		console.log('Unloading CommonplaceNotesPublisherPlugin');
	}
}

class CommonplaceNotesPublisherSettingTab extends PluginSettingTab {
    plugin: CommonplaceNotesPublisherPlugin;

    constructor(app: App, plugin: CommonplaceNotesPublisherPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const {containerEl} = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('AWS Account ID')
            .setDesc('The AWS account ID to use for authentication')
            .addText(text => text
                .setPlaceholder('123456789012')
                .setValue(this.plugin.settings.awsAccountId)
                .onChange(async (value) => {
                    this.plugin.settings.awsAccountId = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('AWS Profile')
            .setDesc('The AWS profile to use for authentication')
            .addText(text => text
                .setPlaceholder('notes')
                .setValue(this.plugin.settings.awsProfile)
                .onChange(async (value) => {
                    this.plugin.settings.awsProfile = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('S3 Bucket Name')
            .setDesc('The name of the S3 bucket to upload to')
            .addText(text => text
                .setPlaceholder('my-notes-bucket')
                .setValue(this.plugin.settings.bucketName)
                .onChange(async (value) => {
                    this.plugin.settings.bucketName = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('AWS Region')
            .setDesc('The AWS region where your bucket is located')
            .addText(text => text
                .setPlaceholder('us-east-1')
                .setValue(this.plugin.settings.region)
                .onChange(async (value) => {
                    this.plugin.settings.region = value;
                    await this.plugin.saveSettings();
                }));
    }
}