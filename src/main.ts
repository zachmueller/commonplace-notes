import { Plugin, MarkdownView, App, TFile } from 'obsidian';
import { CommonplaceNotesSettingTab } from './settings';
import { 
	CommonplaceNotesSettings,
	BulkPublishContextMapping,
	BulkPublishContextConfig,
	PublishContextChange
} from './types';
import { execAsync } from './utils/shell';
import { PathUtils } from './utils/path';
import { pushLocalJsonsToS3 } from './publish/awsUpload';
import { refreshCredentials } from './publish/awsCredentials';
import { ProfileManager } from './utils/profiles';
import { IndicatorManager } from './utils/indicators';
import { NoteManager } from './utils/notes';
import { FrontmatterManager } from './utils/frontmatter';
import { ContentIndexManager } from './utils/contentIndex';
import { MappingManager } from './utils/mappings';
import { NoticeManager } from './utils/notice';
import { TemplateManager } from './utils/templateManager';
import { AwsCliManager } from './utils/awsCli';
import { Publisher } from './publish/publisher';
import { Logger } from './utils/logging';

// defining interfaces to facilitate deregistering commands
interface Command {
	id: string;
	name: string;
}

interface Commands {
	listCommands(): Command[];
	removeCommand(id: string): void;
}

interface ObsidianApp extends App {
	commands: Commands;
}

const DEFAULT_SETTINGS: CommonplaceNotesSettings = {
    publishingProfiles: [{
        name: 'Default AWS Profile',
        id: 'default',
		lastFullPublishTimestamp: 0,
        excludedDirectories: ['private/'],
        baseUrl: '',
		homeNotePath: '',
        isPublic: false,
		publishContentIndex: true,
        publishMechanism: 'AWS CLI',
        indicator: {
			style: 'color',
			color: '#3366cc'
		},
		awsSettings: {
            awsAccountId: '123456789012',
            awsProfile: 'notes',
            bucketName: 'my-bucket',
            region: 'us-east-1',
            cloudFrontInvalidationScheme: 'individual',
            credentialRefreshCommands: '',
			awsCliPath: ''
        }
    }],
	debugMode: false,
};

export default class CommonplaceNotesPlugin extends Plugin {
	settings: CommonplaceNotesSettings;
	profileManager: ProfileManager;
	indicatorManager: IndicatorManager;
	noteManager: NoteManager;
	frontmatterManager: FrontmatterManager;
	contentIndexManager: ContentIndexManager;
	mappingManager: MappingManager;
	templateManager: TemplateManager;
	publisher: Publisher;
	awsCliManager: AwsCliManager;

	async onload() {
		// Initialize settings
		await this.loadSettings();
		Logger.setDebugMode(!!this.settings.debugMode);

		// Initialize classes
		this.profileManager = new ProfileManager(this);
		this.indicatorManager = new IndicatorManager(this);
		this.noteManager = new NoteManager(this);
		this.frontmatterManager = new FrontmatterManager(this.app);
		this.contentIndexManager = new ContentIndexManager(this);
		this.mappingManager = new MappingManager(this);
		this.publisher = new Publisher(this);
		this.templateManager = new TemplateManager(this);
		this.awsCliManager = new AwsCliManager(this);

		// Initialize indicator updates
		// Targeted indicator refresh upon file open events
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file) {
					Logger.debug(`File opened for indicator: ${file?.path}`);
					this.indicatorManager.updateIndicators(file);
				}
			})
		);

		// Refresh indicators upon frontmatter changes
		this.registerEvent(
			this.app.metadataCache.on('changed', async (file) => {
				const cache = this.app.metadataCache.getFileCache(file);
				if (cache?.frontmatter && 'cpn-publish-contexts' in cache.frontmatter) {
					Logger.debug('Publish contexts changed, updating indicators');
					await this.indicatorManager.updateAllVisibleIndicators();
				}
			})
		);

		await this.profileManager.initialize();

		this.addSettingTab(new CommonplaceNotesSettingTab(this.app, this));
		this.registerCommands();

		// Refresh indicators upon fully loading
		this.app.workspace.onLayoutReady(async () => {
			Logger.debug('Layout ready, initializing indicators');
			await this.indicatorManager.updateAllVisibleIndicators();
		});
	}

	private registerCommands() {
		this.addCommand({
			id: 'refresh-credentials',
			name: 'Refresh credentials',
			callback: async () => {
				const profile = await this.publisher.promptForProfile();
				if (!profile) {
					throw new Error('No valid profile selected');
				}
				await refreshCredentials(this, profile.id);
			}
		});

		this.addCommand({
			id: 'publish-current-note',
			name: 'Publish current note',
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!activeView?.file) return false;
				if (checking) return true;
				
				this.publisher.publishSingle(activeView.file);
				return true;
			}
		});

		this.addCommand({
			id: 'publish-connected-notes',
			name: 'Publish active and connected notes',
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!activeView?.file) return false;
				if (checking) return true;
				
				this.publisher.publishConnected(activeView.file);
				return true;
			}
		});

		this.addCommand({
			id: 'publish-updates',
			name: 'Publish updates since last full publish',
			callback: async () => {
				await this.publisher.publishUpdates();
			}
		});

		this.addCommand({
			id: 'publish-all',
			name: 'Publish all notes',
			callback: async () => {
				await this.publisher.publishAll();
			}
		});

		this.addCommand({
			id: 'copy-active-note-published-url',
			name: 'Copy link to current note URL',
			callback: async () => {
				// check that file is active
				const file = this.app.workspace.getActiveFile();
				if (!file) {
					NoticeManager.showNotice('No active file');
					return;
				}

				// check publishing contexts
				const contexts = await this.publisher.getPublishContextsForFile(file);
				if (contexts.length === 0) {
					NoticeManager.showNotice('No publishing contexts defined for this note');
					return;
				}

				// prompt to select profile, if needed
				const profile = await this.publisher.promptForProfile(contexts);
				if (!profile) return;

				// check for baseUrl setting
				if (!profile.baseUrl) {
					NoticeManager.showNotice(`No baseUrl defined for profile ${profile.id}`);
					return;
				}

				// craft URL
				const uid = this.frontmatterManager.getNoteUID(file);
				if (!uid) {
					NoticeManager.showNotice(`Did not find UID for note '${file.basename}'`);
					return;
				}
				const base = profile.baseUrl.replace(/\/?$/, '/');
				const url = `${base}#u=${encodeURIComponent(uid)}`;
				try {
					await navigator.clipboard.writeText(url);
					NoticeManager.showNotice('Note URL copied');
				} catch (error) {
					Logger.error('Error copying note URL:', error);
					throw new Error('Error copying note URL, check console');
				}
			}
		});

		this.registerProfileCommands();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	registerProfileCommands() {
		Logger.debug('Starting to register profile commands');

		// Clear any existing profile commands first
		const app = this.app as ObsidianApp;
		const existingCommands = app.commands.listCommands()
			.filter((cmd: Command) => cmd.id.startsWith('commonplace-notes:toggle-profile-'));
		Logger.debug(`Found ${existingCommands.length} existing profile commands to remove`);

		// Attempt to deregister each command individually
		existingCommands.forEach((cmd: Command) => {
			Logger.debug(`Deregistering command ${cmd.id}`);
			try {
				app.commands.removeCommand(cmd.id);
			} catch (error) {
				Logger.error(`Error removing command ${cmd.id}:`, error);
			}
		});

		// Register a command for each profile
		Logger.debug(`Registering commands for ${this.settings.publishingProfiles.length} profiles`);
		this.settings.publishingProfiles.forEach(profile => {
			Logger.debug(`Registering command for profile: ${profile.name} (${profile.id})`);
			try {
				this.addCommand({
					id: `toggle-profile-${profile.id}`,
					name: `Toggle publishing context: ${profile.name}`,
					checkCallback: (checking: boolean) => {
						const activeFile = this.app.workspace.getActiveFile();
						if (!activeFile) return false;
						
						if (checking) return true;

						// Toggle the publish context
						this.frontmatterManager.togglePublishContext(activeFile, profile.id);
						return true;
					}
				});
				Logger.debug(`Successfully registered command for profile ${profile.name}`);
			} catch (error) {
				Logger.error(`Error registering command for profile ${profile.name}:`, error);
			}
		});
		Logger.debug('Completed profile command registration');
	}

	async rebuildContentIndex(): Promise<void> {
		/*
		Access this in the Obsidian console via:
const cpn = app.plugins.plugins['commonplace-notes'];
cpn.rebuildContentIndex();
		*/
		// Process each note
		const profile = await this.publisher.promptForProfile();
		if (!profile) return;
		const files = await this.publisher.getAllPublishableNotes(profile.id);
		for (const file of files) {
			if (profile.publishContentIndex) {
				const rawWithFrontmatter = await this.app.vault.read(file);
				const raw = await this.noteManager.stripFrontmatter(file, rawWithFrontmatter);
				const title = this.frontmatterManager.getNoteTitle(file);
				const uid = this.frontmatterManager.getNoteUID(file);
				if (uid) {
					Logger.info(`Processing ${file.basename}`);
					await this.contentIndexManager.queueUpdate(profile.id, uid, title, raw);
				}
			}
		}

		// apply queued updates
		await this.contentIndexManager.applyQueuedUpdates(profile.id);
		NoticeManager.showNotice(`Reprocessed contentIndex.json for profile ${profile.id}`);
	}

	/**
	 * Check for files with publish contexts in string format instead of array
	 * Access in Obsidian console:
	 * const cpn = app.plugins.plugins['commonplace-notes'];
	 * cpn.checkPublishContextsFormat();
	 */
	async checkPublishContextsFormat(): Promise<void> {
		const files = this.app.vault.getMarkdownFiles();
		let issueCount = 0;

		Logger.info('Scanning for files with string publish contexts...');

		for (const file of files) {
			const rawContexts = this.frontmatterManager.getFrontmatterValue(file, 'cpn-publish-contexts');
			if (rawContexts && typeof rawContexts === 'string') {
				this.frontmatterManager.normalizePublishContexts(file);
				issueCount++;
				Logger.info(`Found issue in: ${file.path} (value: "${rawContexts}")`);
			}
		}

		if (issueCount === 0) {
			Logger.info('✓ All publish contexts are properly formatted as lists');
		} else {
			Logger.info(`Found ${issueCount} files with string publish contexts. Run fixPublishContextsFormat() to fix.`);
		}

		return;
	}

	/**
	 * Fix publish contexts format for files with string values instead of arrays
	 * Access in Obsidian console:
	 * const cpn = app.plugins.plugins['commonplace-notes'];
	 * cpn.fixPublishContextsFormat(); // Use default delimiter (comma)
	 * cpn.fixPublishContextsFormat('|'); // Use custom delimiter
	 * cpn.fixPublishContextsFormat(null); // Don't split at all, just wrap in array
	 * 
	 * @param delimiter Optional delimiter to split string values (default: ',')
	 * @param dryRun If true, only logs what would be changed without making changes
	 */
	async fixPublishContextsFormat(delimiter: string | null = ',', dryRun: boolean = false): Promise<void> {
		// Initialize scan if problematic files are empty
		if (this.frontmatterManager.getMisconfiguredContexts().length === 0) {
			Logger.info('Scanning for files with string publish contexts...');
			const files = this.app.vault.getMarkdownFiles();

			for (const file of files) {
				const rawContexts = this.frontmatterManager.getFrontmatterValue(file, 'cpn-publish-contexts');
				if (rawContexts && typeof rawContexts === 'string') {
					this.frontmatterManager.normalizePublishContexts(file);
				}
			}
		}

		const problematicFiles = this.frontmatterManager.getMisconfiguredContexts();

		if (problematicFiles.length === 0) {
			Logger.info('No files found with publish contexts format issues');
			return;
		}

		Logger.info(`Found ${problematicFiles.length} files with string publish contexts:`);
		problematicFiles.forEach(path => Logger.info(`- ${path}`));

		if (dryRun) {
			Logger.info('DRY RUN: No changes made. Run without dryRun=true to apply changes.');
			return;
		}

		let fixedCount = 0;
		let failedCount = 0;

		Logger.info(`Fixing ${problematicFiles.length} files using delimiter: ${delimiter === null ? 'NONE (wrapping as-is)' : `"${delimiter}"`}`);

		for (const filePath of problematicFiles) {
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (file instanceof TFile) {
				try {
					// Get the raw string value
					const rawContexts = this.frontmatterManager.getFrontmatterValue(file, 'cpn-publish-contexts');

					if (typeof rawContexts === 'string') {
						// Convert to array based on delimiter parameter
						let normalized: string[];

						if (delimiter === null) {
							// Just wrap the string in an array without splitting
							normalized = [rawContexts.trim()];
						} else {
							// Split by delimiter and clean up
							normalized = rawContexts.split(delimiter)
								.map(s => s.trim())
								.filter(s => s.length > 0);
						}

						// Apply the fix
						await this.frontmatterManager.updateFrontmatter(file, {
							'cpn-publish-contexts': normalized
						});

						fixedCount++;
						Logger.info(`Fixed ${filePath}: ${rawContexts} → ${JSON.stringify(normalized)}`);
					}
				} catch (error) {
					Logger.error(`Failed to fix ${filePath}:`, error);
					failedCount++;
				}
			}
		}

		if (fixedCount > 0) {
			this.frontmatterManager.clearMisconfiguredContexts();
		}

		Logger.info(`Completed: Fixed ${fixedCount} files, ${failedCount} failed`);
	}

	onunload() {
		Logger.info('Unloading CommonplaceNotesPlugin');
		NoticeManager.cleanup();
	}

	private async getTimeWindowHash(): Promise<string> {
		// Round to nearest 3-hour window (in milliseconds)
		const threeHours = 3 * 60 * 60 * 1000;
		const windowTimestamp = Math.floor(Date.now() / threeHours) * threeHours;

		// Convert timestamp to string and then to Uint8Array
		const data = new TextEncoder().encode(windowTimestamp.toString());

		// Generate SHA-256 hash
		const hashBuffer = await crypto.subtle.digest('SHA-256', data);

		// Convert to hex string and take first 8 characters
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
		return hashHex.substring(0, 8);
	}

	private async writePreviewCSV(filePath: string, changes: PublishContextChange[]): Promise<void> {
		const stringifyArray = (arr: any[]): string =>
			'[' + arr.map(item => typeof item === 'string'
				? `'${item}'` : item).join(', ') + ']';
		const csvContent = [
			['File Path', 'Current Contexts', 'Proposed Contexts', 'Action', 'Include Pattern', 'Exclude Pattern'].join(','),
			...changes.map(change => [
				change.filePath,
				stringifyArray(change.currentContexts),
				stringifyArray(change.proposedContexts),
				change.action,
				change.includePattern,
				change.excludePattern
			].map(field => `"${field}"`).join(','))
		].join('\n');

		await this.app.vault.adapter.write(filePath, csvContent);
	}

	async bulkUpdatePublishContexts(
		config: BulkPublishContextConfig,
		validationHash?: string,
		dryRun: boolean = true
	): Promise<void> {
		// Validate hash
		const expectedHash = await this.getTimeWindowHash();
		if (validationHash !== expectedHash) {
			throw new Error(
				`Invalid validation hash. Expected: ${expectedHash}\n` +
				`This hash is valid for the current 3-hour window.\n` +
				`Please ensure you have backed up your vault before proceeding.`
			);
			return;
		}

		// Get all markdown files
		const files = this.app.vault.getMarkdownFiles();
		const changes: PublishContextChange[] = [];
		let updateCount = 0;

		// Process each file
		for (const file of files) {
			const filePath = file.path;

			// Check if file is in an excluded directory
			const isExcluded = config.exclude.some(excludeDir =>
				filePath.startsWith(excludeDir) || filePath.includes('/' + excludeDir + '/')
			);

			if (isExcluded) {
				// Record excluded files in the preview
				const excludePattern = config.exclude.find(excludeDir =>
					filePath.startsWith(excludeDir) || filePath.includes('/' + excludeDir + '/')
				) || '';

				changes.push({
					filePath,
					currentContexts: this.frontmatterManager.getFrontmatterValue(file, 'cpn-publish-contexts') || [],
					proposedContexts: [],
					action: 'Excluded',
					includePattern: '',
					excludePattern
				});
				continue;
			}

			// Find matching include patterns
			const matchingIncludes = config.include.filter(inc =>
				filePath.startsWith(inc.directory) || filePath.includes('/' + inc.directory + '/')
			);

			if (matchingIncludes.length > 0) {
				const currentContexts = this.frontmatterManager.getFrontmatterValue(file, 'cpn-publish-contexts') || [];
				let proposedContexts = [...currentContexts];

				// Process each matching pattern
				matchingIncludes.forEach(inc => {
					if (inc.action === 'add') {
						// Add new contexts
						proposedContexts = Array.from(new Set([...proposedContexts, ...inc.contexts]));
					} else if (inc.action === 'remove') {
						// Remove specified contexts
						proposedContexts = proposedContexts.filter(ctx => !inc.contexts.includes(ctx));
					}
				});

				const hasChanges = JSON.stringify(currentContexts) !== JSON.stringify(proposedContexts);

				changes.push({
					filePath,
					currentContexts,
					proposedContexts,
					action: hasChanges ? 'Update' : 'No Change',
					includePattern: matchingIncludes.map(inc =>
						`${inc.directory} (${inc.action} ${inc.contexts.join(',')})`
					).join(', '),
					excludePattern: ''
				});

				// Apply changes if not in dry run mode and there are actual changes
				if (!dryRun && hasChanges) {
					await this.frontmatterManager.updateFrontmatter(file, {
						'cpn-publish-contexts': proposedContexts
					});
					updateCount++;
				}
			}
		}

		// Write preview CSV
		await this.writePreviewCSV(config.previewPath, changes);

		// Log summary
		const mode = dryRun ? 'Preview' : 'Applied';
		Logger.info(`${mode} CSV written to ${config.previewPath}`);
		Logger.info(`Total files to be updated: ${changes.filter(c => c.action === 'Update').length}`);
		Logger.info(`Total files excluded: ${changes.filter(c => c.action === 'Excluded').length}`);
		Logger.info(`Total files unchanged: ${changes.filter(c => c.action === 'No Change').length}`);

		if (!dryRun) {
			Logger.info(`Successfully updated ${updateCount} files`);
		} else {
			Logger.info(`To apply these changes, call this function again with dryRun set to false`);
		}
	}
}