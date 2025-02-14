import { Plugin, MarkdownView, Notice, App, TFile, PluginSettingTab, Setting } from 'obsidian';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { PathUtils } from './utils/path';
import remarkObsidianLinks from './utils/remarkObsidianLinks';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execAsync = promisify(exec);

interface CommonplaceNotesPublisherSettings {
    awsAccountId: string;
    awsProfile: string;
    awsRole: string;
    bucketName: string;
    region: string;
}

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

const DEFAULT_SETTINGS: CommonplaceNotesPublisherSettings = {
	awsAccountId: '123456789012',
	awsProfile: 'notes',
	awsRole: 'Admin',
	bucketName: 'my-bucket',
	region: 'us-east-1'
};

export default class CommonplaceNotesPublisherPlugin extends Plugin {
	settings: CommonplaceNotesPublisherSettings;
	
	async onload() {
		await this.loadSettings();
		this.addSettingTab(new CommonplaceNotesPublisherSettingTab(this.app, this));

		this.addCommand({
			id: 'testing-stuff',
			name: 'Testing stuff',
			callback: async () => {
				await this.test();
			}
		});

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
				await this.pushLocalJsonsToS3();
			}
		});
	}

	private test() {
		//console.log(this.getBacklinks());
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

	private async pushLocalJsonsToS3() {
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



	private getBacklinks(targetFile: TFile) {
		// Get resolved links from metadata cache
		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		console.log(resolvedLinks);
		const backlinks: BacklinkInfo[] = [];

		// Find all files that link to the current file
		Object.entries(resolvedLinks).forEach(([sourcePath, links]) => {
			if (links[targetFile.path]) {
				console.log(`Found path: ${sourcePath}`);
				const file = this.app.vault.getAbstractFileByPath(sourcePath);
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




	private async ensureDirectory(targetPath: string): Promise<void> {
		// Normalize the path to handle different path separators
		const normalizedPath = targetPath.replace(/\\/g, '/');
		const dirPath = path.dirname(normalizedPath);
		
		if (!(await this.app.vault.adapter.exists(dirPath))) {
			await this.app.vault.adapter.mkdir(dirPath);
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
			const html = await this.markdownToHtml(contentWithoutFrontmatter, file);

			// Get backlinks
			const backlinks = this.getBacklinks(file);
			

			// Create the output directory if it doesn't exist
			const pluginDir = this.manifest.dir;
			const outputDir = `${pluginDir}/notes`;
			await this.ensureDirectory(outputDir);

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
			await this.app.vault.adapter.write(outputPath, JSON.stringify(output));

			new Notice(`Note output saved to ${outputPath}`);
		} catch (error) {
			new Notice(`Error converting note: ${error.message}`);
			console.error('Note conversion error:', error);
		}
	}


// TODO::switch out linking behavior to follow the new style in the JSON-backed setup::
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