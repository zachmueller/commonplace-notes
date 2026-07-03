import { Plugin, MarkdownView, App, TFile, Modal, Setting, Notice, WorkspaceLeaf } from 'obsidian';
import { CommonplaceNotesSettingTab } from './settings';
import { 
	CommonplaceNotesSettings,
	BulkPublishContextMapping,
	BulkPublishContextConfig,
	PublishContextChange
} from './types';
import { PathUtils } from './utils/path';
import { refreshCredentials } from './publish/awsCredentials';
import { ProfileManager } from './utils/profiles';
import { IndicatorManager } from './utils/indicators';
import { NoteManager } from './utils/notes';
import { ParserExtensionManager } from './utils/parserExtensions';
import { FrontmatterManager } from './utils/frontmatter';
import { ContentIndexManager } from './utils/contentIndex';
import { MappingManager } from './utils/mappings';
import { NoticeManager } from './utils/notice';
import { TemplateManager } from './utils/templateManager';
import { AwsSdkManager } from './utils/awsSdk';
import { Publisher } from './publish/publisher';
import { Logger } from './utils/logging';
import { formatNoteUrl, formatNoteStackUrl } from './utils/urlScheme';
import { CloudFormationManager } from './infrastructure/cloudFormationManager';
import { DeploymentWizardModal } from './infrastructure/deploymentWizardModal';

// defining interfaces to facilitate deregistering commands
interface Commands {
	removeCommand(id: string): void;
}

interface ObsidianApp extends App {
	commands: Commands;
}

const DEFAULT_SETTINGS: CommonplaceNotesSettings = {
	uidLength: 8,
	urlScheme: 'current',
	urlStackWindowSeconds: 10,
	cpnDirectory: 'cpn',
    publishingProfiles: [{
        name: 'Default AWS Profile',
        id: 'default',
		lastFullPublishTimestamp: 0,
        excludedDirectories: ['private/'],
        baseUrl: '',
		homeNotePath: '',
        isPublic: false,
		publishContentIndex: true,
		obscureRawWikilinks: true,
        publishMechanism: 'AWS',
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
			credentialMode: 'sdk',
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
	parserExtensionManager: ParserExtensionManager;
	frontmatterManager: FrontmatterManager;
	contentIndexManager: ContentIndexManager;
	mappingManager: MappingManager;
	templateManager: TemplateManager;
	publisher: Publisher;
	awsSdkManager: AwsSdkManager;
	cloudFormationManager: CloudFormationManager;
	private registeredProfileCommandIds: string[] = [];

	// Transient state for append-mode URL stacking. Holds the in-progress
	// stack, the sliding-window timers, and the live countdown Notice.
	// Null whenever no stack is being assembled.
	private urlStackState: {
		profileId: string;
		baseUrl: string;           // already normalized with a trailing slash
		uids: string[];            // ordered, de-duped
		expiresAt: number;         // epoch ms when the window lapses
		timer: number;             // expiry setTimeout id
		countdownInterval: number; // 1s tick refreshing the Notice
		notice: Notice;            // persistent countdown Notice (duration 0)
	} | null = null;

	async onload() {
		// Initialize settings
		await this.loadSettings();
		Logger.setDebugMode(!!this.settings.debugMode);

		// Initialize classes
		this.profileManager = new ProfileManager(this);
		this.indicatorManager = new IndicatorManager(this);
		this.noteManager = new NoteManager(this);
		this.parserExtensionManager = new ParserExtensionManager(this);
		this.frontmatterManager = new FrontmatterManager(this);
		this.contentIndexManager = new ContentIndexManager(this);
		this.mappingManager = new MappingManager(this);
		this.publisher = new Publisher(this);
		this.templateManager = new TemplateManager(this);
		this.awsSdkManager = new AwsSdkManager(this);
		this.cloudFormationManager = new CloudFormationManager(this);

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
			id: 'export-parser-scaffolds',
			name: 'Export all parser stage definitions to vault',
			callback: async () => {
				try {
					const paths = await this.parserExtensionManager.exportAllScaffolds();
					const dir = this.settings.cpnDirectory ?? 'cpn';
					NoticeManager.showNotice(`Exported ${paths.length} parser stage(s) to ${dir}/parsers/`);
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					NoticeManager.showNotice(`Failed to export parser stages: ${msg}`);
					Logger.error('Failed to export parser scaffolds:', error);
				}
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
			id: 'delete-published-note',
			name: 'Delete a published note',
			callback: async () => {
				await this.publisher.deletePublishedNote();
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

				const urlScheme = this.settings.urlScheme || 'current';

				// --- Continue an active stack -------------------------------
				// A stack is only ever active under the 'current' scheme, so if
				// one exists we append to it without re-prompting for a profile.
				if (this.urlStackState) {
					const state = this.urlStackState;

					// The note must belong to the same publish context as the stack.
					const fileContexts = await this.publisher.getPublishContextsForFile(file);
					if (!fileContexts.includes(state.profileId)) {
						NoticeManager.showNotice(`Skipped '${file.basename}' — not in publish context`, 3000);
						this.resetUrlStackWindow(); // give the user time to navigate elsewhere
						return;
					}

					// Resolve the UID; skip (but keep the stack alive) if missing.
					const uid = this.frontmatterManager.getNoteUID(file);
					if (!uid) {
						NoticeManager.showNotice(`Did not find UID for note '${file.basename}'`);
						this.resetUrlStackWindow();
						return;
					}

					// De-dupe, then rewrite the clipboard with the full stack.
					if (!state.uids.includes(uid)) {
						state.uids.push(uid);
					}
					const fragment = formatNoteStackUrl(
						state.uids.map(u => ({ type: 'u', value: u })),
						'current'
					);
					const url = `${state.baseUrl}${fragment}`;
					try {
						await navigator.clipboard.writeText(url);
					} catch (error) {
						Logger.error('Error copying note URL:', error);
						throw new Error('Error copying note URL, check console');
					}

					this.resetUrlStackWindow();
					this.renderUrlStackNotice();
					return;
				}

				// --- First invocation (no active stack) ---------------------

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

				// The 'original' scheme does not compose into a multi-segment
				// stack, so fall back to the legacy single-note copy.
				if (urlScheme !== 'current') {
					const fragment = formatNoteUrl('u', uid, urlScheme);
					const url = `${base}${fragment}`;
					try {
						await navigator.clipboard.writeText(url);
						NoticeManager.showNotice('Note URL copied (switch to the "Current" URL scheme to stack notes)');
					} catch (error) {
						Logger.error('Error copying note URL:', error);
						throw new Error('Error copying note URL, check console');
					}
					return;
				}

				// Start a new stack: copy the single-note URL now, then open the
				// sliding window so subsequent invocations append to it.
				const fragment = formatNoteStackUrl([{ type: 'u', value: uid }], 'current');
				const url = `${base}${fragment}`;
				try {
					await navigator.clipboard.writeText(url);
				} catch (error) {
					Logger.error('Error copying note URL:', error);
					throw new Error('Error copying note URL, check console');
				}

				this.urlStackState = {
					profileId: profile.id,
					baseUrl: base,
					uids: [uid],
					expiresAt: 0,
					timer: 0,
					countdownInterval: 0,
					notice: new Notice('', 0)
				};
				this.resetUrlStackWindow();
				this.renderUrlStackNotice();
			}
		});

		this.addCommand({
			id: 'copy-open-notes-stacked-url',
			name: 'Copy open notes as stacked URL',
			callback: async () => {
				const urlScheme = this.settings.urlScheme || 'current';
				if (urlScheme !== 'current') {
					NoticeManager.showNotice('Stacked URLs require the "Current" URL scheme (see settings)');
					return;
				}

				// Collect Markdown leaves in the main editor area, left-to-right.
				const files = this.getMainAreaMarkdownFiles();
				if (files.length === 0) {
					NoticeManager.showNotice('No open notes in the main editor area');
					return;
				}

				// Gather the union of all open notes' publish contexts to drive
				// the profile prompt.
				const contextSet = new Set<string>();
				for (const file of files) {
					const contexts = await this.publisher.getPublishContextsForFile(file);
					for (const c of contexts) contextSet.add(c);
				}
				if (contextSet.size === 0) {
					NoticeManager.showNotice('None of the open notes have publishing contexts defined');
					return;
				}

				const profile = await this.publisher.promptForProfile([...contextSet]);
				if (!profile) return;
				if (!profile.baseUrl) {
					NoticeManager.showNotice(`No baseUrl defined for profile ${profile.id}`);
					return;
				}

				// Build the stack in tab order, skipping notes outside the chosen
				// context (or without a UID) and recording them for the user.
				const uids: string[] = [];
				const skipped: string[] = [];
				for (const file of files) {
					const contexts = await this.publisher.getPublishContextsForFile(file);
					if (!contexts.includes(profile.id)) {
						skipped.push(file.basename);
						continue;
					}
					const uid = this.frontmatterManager.getNoteUID(file);
					if (!uid) {
						skipped.push(file.basename);
						continue;
					}
					if (!uids.includes(uid)) uids.push(uid);
				}

				if (uids.length === 0) {
					NoticeManager.showNotice(`No open notes are in the "${profile.name}" publish context`);
					return;
				}

				const base = profile.baseUrl.replace(/\/?$/, '/');
				const fragment = formatNoteStackUrl(uids.map(u => ({ type: 'u', value: u })), 'current');
				const url = `${base}${fragment}`;
				try {
					await navigator.clipboard.writeText(url);
					const noun = uids.length === 1 ? 'note' : 'notes';
					NoticeManager.showNotice(`Stacked URL copied (${uids.length} ${noun})`);
				} catch (error) {
					Logger.error('Error copying note URL:', error);
					throw new Error('Error copying note URL, check console');
				}

				if (skipped.length > 0) {
					NoticeManager.showNotice(`Skipped (not in context): ${skipped.join(', ')}`, 6000);
				}
			}
		});

		this.addCommand({
			id: 'deploy-infrastructure',
			name: 'Deploy publishing infrastructure',
			callback: async () => {
				const profile = await this.publisher.promptForProfile();
				if (!profile) return;
				if (profile.publishMechanism !== 'AWS') {
					NoticeManager.showNotice('Infrastructure deployment is only available for AWS profiles.');
					return;
				}
				new DeploymentWizardModal(
					this.app,
					this,
					this.cloudFormationManager,
					profile,
				).open();
			}
		});

		this.addCommand({
			id: 'destroy-infrastructure',
			name: 'Destroy publishing infrastructure',
			callback: async () => {
				const profile = await this.publisher.promptForProfile();
				if (!profile) return;
				const state = profile.infrastructureState;
				if (!state || state.status === 'none') {
					NoticeManager.showNotice('No infrastructure deployed for this profile.');
					return;
				}
				if (state.imported) {
					NoticeManager.showNotice('Imported stacks cannot be destroyed from the plugin. Manage them via CDK.');
					return;
				}
				const confirmed = await new Promise<boolean>(resolve => {
					const confirmModal = new Modal(this.app);
					confirmModal.onOpen = () => {
						confirmModal.contentEl.createEl('h3', { text: 'Destroy Infrastructure' });
						confirmModal.contentEl.createEl('p', {
							text: `This will delete the CloudFormation stacks for profile "${profile.name}". The S3 bucket will be retained (not deleted). This action cannot be undone.`,
						});
						new Setting(confirmModal.contentEl)
							.addButton(btn => btn.setButtonText('Cancel').onClick(() => { resolve(false); confirmModal.close(); }))
							.addButton(btn => btn.setButtonText('Destroy').setWarning().onClick(() => { resolve(true); confirmModal.close(); }));
					};
					confirmModal.onClose = () => resolve(false);
					confirmModal.open();
				});
				if (!confirmed) return;

				try {
					if (state.comment?.stackName) {
						// Delete the comment stack before the site stack so the
						// /comments/* origin's referenced bucket policy is gone first.
						await this.cloudFormationManager.deleteStack(state.comment.stackName, profile, state.region);
					}
					if (state.fullStackName) {
						await this.cloudFormationManager.deleteStack(state.fullStackName, profile, state.region);
					}
					if (state.certStackName && !state.certificateReused) {
						// Never delete a certificate we reused rather than created — it is
						// owned outside this profile's stacks. (A reused cert also leaves
						// certStackName unset; this is belt-and-suspenders.)
						await this.cloudFormationManager.deleteStack(state.certStackName, profile, 'us-east-1');
					}
					if (state.cognitoAuth?.stackName) {
						// The Cognito stack owns a Lambda@Edge function whose replicas
						// are removed asynchronously by CloudFront only after the
						// distribution is gone — its first delete attempt may fail with
						// a "replicated function" error and need a retry later.
						await this.cloudFormationManager.deleteStack(state.cognitoAuth.stackName, profile, 'us-east-1');
					}
					if (state.passwordAuth?.stackName) {
						// Same Lambda@Edge replica-removal caveat as the Cognito stack.
						await this.cloudFormationManager.deleteStack(state.passwordAuth.stackName, profile, 'us-east-1');
					}
					// Reset to defaults (no spread) — clears cognitoAuth/passwordAuth/comment and intent.
					profile.infrastructureState = { status: 'none', useRoute53: false, originAccessMethod: 'oac' };
					profile.readGate = undefined;
					profile.cognitoAuth = undefined;
					profile.commenting = undefined;
					await this.saveSettings();
					NoticeManager.showNotice(
						(state.cognitoAuth?.stackName || state.passwordAuth?.stackName)
							? 'Infrastructure destruction initiated. The auth stack may need a retry once the CloudFront edge replicas are removed.'
							: 'Infrastructure destruction initiated.',
					);
				} catch (err: any) {
					NoticeManager.showNotice(`Error: ${err.message}`);
				}
			}
		});

		this.registerProfileCommands();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		await this.migrateSettings();
	}

	private async migrateSettings() {
		let needsSave = false;

		for (const profile of this.settings.publishingProfiles) {
			if ((profile.publishMechanism as string) === 'AWS CLI') {
				profile.publishMechanism = 'AWS';
				needsSave = true;
			}

			if (profile.awsSettings && !profile.awsSettings.credentialMode) {
				profile.awsSettings.credentialMode = profile.awsSettings.credentialRefreshCommands
					? 'custom-command'
					: 'sdk';
				needsSave = true;
			}

			if (profile.obscureRawWikilinks === undefined) {
				profile.obscureRawWikilinks = true;
				needsSave = true;
			}
		}

		if (needsSave) {
			await this.saveData(this.settings);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// --- Append-mode URL stacking helpers ---------------------------------

	private get urlStackWindowMs(): number {
		const seconds = this.settings.urlStackWindowSeconds ?? 10;
		return Math.max(1, seconds) * 1000;
	}

	// (Re)start the sliding window: refresh the expiry timeout and ensure the
	// 1s countdown tick is running. Called on every successful append AND on a
	// skip, so the user always gets a fresh window to navigate to a note.
	private resetUrlStackWindow() {
		if (!this.urlStackState) return;
		const state = this.urlStackState;

		state.expiresAt = Date.now() + this.urlStackWindowMs;

		window.clearTimeout(state.timer);
		state.timer = window.setTimeout(() => this.clearUrlStack(), this.urlStackWindowMs);

		if (!state.countdownInterval) {
			state.countdownInterval = window.setInterval(() => this.renderUrlStackNotice(), 1000);
		}
	}

	// Refresh the persistent Notice text with the current note count and the
	// remaining seconds in the window.
	private renderUrlStackNotice() {
		if (!this.urlStackState) return;
		const state = this.urlStackState;
		const remaining = Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000));
		const count = state.uids.length;
		const noun = count === 1 ? 'note' : 'notes';
		state.notice.setMessage(`Stacking URL (${count} ${noun}) — ${remaining}s left`);
	}

	// Enumerate the files backing Markdown leaves in the main editor area
	// (rootSplit), excluding sidebars, in left-to-right tab order. Obsidian's
	// iterateRootLeaves walks the main split in visual order.
	private getMainAreaMarkdownFiles(): TFile[] {
		const files: TFile[] = [];
		this.app.workspace.iterateRootLeaves((leaf: WorkspaceLeaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file) {
				files.push(view.file);
			}
		});
		return files;
	}

	// Tear down the stack: clear both timers, hide the Notice, drop the state.
	private clearUrlStack() {
		if (!this.urlStackState) return;
		const state = this.urlStackState;
		window.clearTimeout(state.timer);
		if (state.countdownInterval) window.clearInterval(state.countdownInterval);
		state.notice.hide();
		this.urlStackState = null;
	}

	registerProfileCommands() {
		Logger.debug('Starting to register profile commands');

		// Remove the profile commands we previously registered, tracked by id.
		// We intentionally avoid app.commands.listCommands() here: it evaluates every
		// registered command's checkCallback to filter the list, which throws for core
		// commands when called during onload (before the workspace layout is ready).
		const app = this.app as ObsidianApp;
		Logger.debug(`Found ${this.registeredProfileCommandIds.length} existing profile commands to remove`);
		for (const id of this.registeredProfileCommandIds) {
			Logger.debug(`Deregistering command ${id}`);
			try {
				app.commands.removeCommand(id);
			} catch (error) {
				Logger.error(`Error removing command ${id}:`, error);
			}
		}
		this.registeredProfileCommandIds = [];

		// Register a command for each profile
		Logger.debug(`Registering commands for ${this.settings.publishingProfiles.length} profiles`);
		this.settings.publishingProfiles.forEach(profile => {
			Logger.debug(`Registering command for profile: ${profile.name} (${profile.id})`);
			try {
				const command = this.addCommand({
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
				this.registeredProfileCommandIds.push(command.id);
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
					// Mirror the scrub applied in queueNote so the content index
					// stays aligned with the published `raw` (default on).
					const obscure = profile.obscureRawWikilinks ?? true;
					const indexRaw = obscure
						? await this.noteManager.rewriteRawWikilinks(raw, file, profile.id)
						: raw;
					await this.contentIndexManager.queueUpdate(profile.id, uid, title, indexRaw);
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
		this.clearUrlStack();
		this.awsSdkManager.dispose();
		this.cloudFormationManager.dispose();
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