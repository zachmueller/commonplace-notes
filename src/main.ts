import { Plugin, MarkdownView, Notice, App, TFile } from 'obsidian';
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
            credentialRefreshCommands: ''
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
	publisher: Publisher;

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
					new Notice('No active file');
					return;
				}

				// check publishing contexts
				const contexts = await this.publisher.getPublishContextsForFile(file);
				if (contexts.length === 0) {
					new Notice('No publishing contexts defined for this note');
					return;
				}

				// prompt to select profile, if needed
				const profile = await this.publisher.promptForProfile(contexts);
				if (!profile) return;

				// check for baseUrl setting
				if (!profile.baseUrl) {
					new Notice(`No baseUrl defined for profile ${profile.id}`);
					return;
				}

				// craft URL
				const uid = await this.frontmatterManager.getNoteUID(file);
				if (!uid) {
					new Notice(`Did not find UID for note '${file.basename}'`);
					return;
				}
				const base = profile.baseUrl.replace(/\/?$/, '/');
				const url = `${base}#u=${encodeURIComponent(uid)}`;
				try {
					await navigator.clipboard.writeText(url);
					new Notice('Note URL copied');
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
		// Clear any existing profile commands first
		const app = this.app as ObsidianApp;
		app.commands.listCommands()
			.filter((cmd: Command) => cmd.id.startsWith('commonplace-notes:toggle-profile-'))
			.forEach((cmd: Command) => {
				Logger.debug(`Deregistering command ${cmd.id}`);
				app.commands.removeCommand(cmd.id);
			});

		// Register a command for each profile
		this.settings.publishingProfiles.forEach(profile => {
			Logger.debug(`Registering command dynamically: ${profile.id}`);
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
		});
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
				const title = this.frontmatterManager.getFrontmatterValue(file, 'cpn-title') || file.basename;
				const uid = await this.frontmatterManager.getNoteUID(file);
				if (uid) {
					Logger.info(`Processing ${file.basename}`);
					await this.contentIndexManager.queueUpdate(profile.id, uid, title, raw);
				}
			}
		}

		// apply queued updates
		await this.contentIndexManager.applyQueuedUpdates(profile.id);
		new Notice(`Reprocessed contentIndex.json for profile ${profile.id}`);
	}

	onunload() {
		Logger.info('Unloading CommonplaceNotesPlugin');
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