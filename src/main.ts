import { Plugin, MarkdownView, App, TFile, Modal, Setting, Notice, WorkspaceLeaf, normalizePath } from 'obsidian';
import { CommonplaceNotesSettingTab } from './settings';
import {
	CommonplaceNotesSettings,
	BulkPublishContextMapping,
	BulkPublishContextConfig,
	PublishContextChange,
	PublishingProfile,
	OrphanedEdgeResource
} from './types';
import { StackEvent } from './infrastructure/types';
import { DeleteFunctionCommand } from '@aws-sdk/client-lambda';
import {
	ListAttachedRolePoliciesCommand,
	DetachRolePolicyCommand,
	DeleteRoleCommand,
} from '@aws-sdk/client-iam';
import { PathUtils } from './utils/path';
import { refreshCredentials } from './publish/awsCredentials';
import { ProfileManager } from './utils/profiles';
import { IndicatorManager } from './utils/indicators';
import { NoteManager } from './utils/notes';
import { ParserExtensionManager } from './utils/parserExtensions';
import { RoutingManager } from './routing/routingManager';
import { FrontmatterManager } from './utils/frontmatter';
import { ContentIndexManager } from './utils/contentIndex';
import { KbCorpusManager } from './utils/kbCorpus';
import { MappingManager } from './utils/mappings';
import { NoticeManager } from './utils/notice';
import { TemplateManager } from './utils/templateManager';
import { AwsSdkManager } from './utils/awsSdk';
import { Publisher } from './publish/publisher';
import { Logger, errorMessage, errorCode } from './utils/logging';
import { formatNoteUrl, formatNoteStackUrl } from './utils/urlScheme';
import { CloudFormationManager } from './infrastructure/cloudFormationManager';
import { DeployHookManager } from './infrastructure/hooks/deployHookManager';
import { DeploymentWizardModal } from './infrastructure/deploymentWizardModal';
import { RecentCommentsView, RECENT_COMMENTS_VIEW } from './views/recentCommentsView';
import type { CommentThreadCache } from './utils/recentComments';

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
	commentsPanelMode: 'recent',
	routingTitlePrompt: 'only-if-Untitled',
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
	routingManager: RoutingManager;
	frontmatterManager: FrontmatterManager;
	contentIndexManager: ContentIndexManager;
	kbCorpusManager: KbCorpusManager;
	mappingManager: MappingManager;
	templateManager: TemplateManager;
	publisher: Publisher;
	awsSdkManager: AwsSdkManager;
	cloudFormationManager: CloudFormationManager;
	deployHookManager: DeployHookManager;
	private registeredProfileCommandIds: string[] = [];

	// Session-only per-note comment thread cache, shared by both comments-panel
	// modes (Recent + Active note) and keyed by `${profileId}::${noteUid}`. Lives
	// on the plugin so a note fetched in one mode is instantly reusable in the
	// other; created fresh on load and GC'd on unload/reload (clears on reload).
	readonly commentThreadCache: CommentThreadCache = new Map();

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
		this.routingManager = new RoutingManager(this);
		this.frontmatterManager = new FrontmatterManager(this);
		this.contentIndexManager = new ContentIndexManager(this);
		this.kbCorpusManager = new KbCorpusManager(this);
		this.mappingManager = new MappingManager(this);
		this.publisher = new Publisher(this);
		this.templateManager = new TemplateManager(this);
		this.awsSdkManager = new AwsSdkManager(this);
		this.cloudFormationManager = new CloudFormationManager(this);
		this.deployHookManager = new DeployHookManager(this);

		// Initialize indicator updates
		// Targeted indicator refresh upon file open events
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file) {
					Logger.debug(`File opened for indicator: ${file?.path}`);
					void this.indicatorManager.updateIndicators(file);
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

		// V2 seam — opt-in auto-routing when a note is created (e.g. from a clicked
		// wikilink). Disabled for V1; routing is command-driven. When enabled, guard
		// against competing Templater directory triggers (see docs).
		// this.registerEvent(
		// 	this.app.vault.on('create', (file) => {
		// 		if (file instanceof TFile && file.extension === 'md') {
		// 			void this.routingManager.runRoute(file, 'create');
		// 		}
		// 	})
		// );

		await this.profileManager.initialize();

		this.addSettingTab(new CommonplaceNotesSettingTab(this.app, this));
		this.registerCommands();

		// Recent Comments side panel (author-facing Phase 2).
		this.registerView(RECENT_COMMENTS_VIEW, (leaf) => new RecentCommentsView(leaf, this));
		this.addRibbonIcon('message-square', 'Comments', () => this.activateRecentCommentsView());

		// Refresh indicators upon fully loading
		this.app.workspace.onLayoutReady(async () => {
			Logger.debug('Layout ready, initializing indicators');
			await this.indicatorManager.updateAllVisibleIndicators();

			// If the panel was restored open in this workspace, refresh it once when
			// its data is >=8h stale. The view itself no-ops when the feed is fresh.
			for (const leaf of this.app.workspace.getLeavesOfType(RECENT_COMMENTS_VIEW)) {
				const view = leaf.view;
				if (view instanceof RecentCommentsView) await view.refreshIfStale();
			}

			// Opportunistically retry deferred cleanup of orphaned Lambda@Edge
			// resources from a prior force-clean — hours have likely passed since the
			// last session, so CloudFront may finally have removed the replicas.
			// Fire-and-forget so a slow/failed AWS call never blocks startup.
			this.sweepPendingEdgeCleanup();
		});
	}

	/** Fire-and-forget retry of deferred Lambda@Edge cleanup for every profile with
	 * pending orphans. Each profile's failures are isolated so one bad profile can't
	 * abort the sweep; nothing is awaited by the caller. */
	private sweepPendingEdgeCleanup(): void {
		for (const profile of this.settings.publishingProfiles) {
			if (!profile.pendingEdgeCleanup?.length) continue;
			this.cleanupOrphanedEdgeResources(profile).catch(err =>
				Logger.warn(`Deferred edge cleanup failed for profile ${profile.name}:`, err),
			);
		}
	}

	async activateRecentCommentsView() {
		const existing = this.app.workspace.getLeavesOfType(RECENT_COMMENTS_VIEW);
		if (existing.length > 0) {
			void this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: RECENT_COMMENTS_VIEW, active: true });
		void this.app.workspace.revealLeaf(leaf);
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
			id: 'open-recent-comments',
			name: 'Open comments panel',
			callback: () => this.activateRecentCommentsView(),
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
			id: 'export-routing-scaffolds',
			name: 'Export all routing actions & options to vault',
			callback: async () => {
				try {
					const paths = await this.routingManager.exportAllScaffolds();
					const dir = this.settings.cpnDirectory ?? 'cpn';
					NoticeManager.showNotice(`Exported ${paths.length} routing file(s) to ${dir}/routes/`);
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					NoticeManager.showNotice(`Failed to export routing files: ${msg}`);
					Logger.error('Failed to export routing scaffolds:', error);
				}
			}
		});

		this.addCommand({
			id: 'route-new-note',
			name: 'Route new note',
			callback: async () => {
				try {
					const file = await this.createAndOpenNote();
					await this.routingManager.runRoute(file, 'create');
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					NoticeManager.showNotice(`Route new note failed: ${msg}`);
					Logger.error('Route new note failed:', error);
				}
			}
		});

		this.addCommand({
			id: 'route-existing-note',
			name: 'Route existing note',
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!activeView?.file) return false;
				if (checking) return true;

				void this.routingManager.runRoute(activeView.file, 'update');
				return true;
			}
		});

		this.addCommand({
			id: 'publish-current-note',
			name: 'Publish current note',
			checkCallback: (checking: boolean) => {
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!activeView?.file) return false;
				if (checking) return true;
				
				void this.publisher.publishSingle(activeView.file);
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
				
				void this.publisher.publishConnected(activeView.file);
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
			id: 'sync-chat-knowledge-base',
			name: 'Sync chat knowledge base (re-index published notes)',
			callback: async () => {
				const profile = await this.publisher.promptForProfile();
				if (!profile) return;
				if (!profile.chat?.enabled) {
					NoticeManager.showNotice('LLM chat is not enabled for this profile');
					return;
				}
				try {
					const jobId = await this.cloudFormationManager.startChatIngestion(profile);
					NoticeManager.showNotice(jobId
						? 'Chat knowledge base ingestion started (indexing takes a moment)'
						: 'Chat is not fully deployed for this profile');
				} catch (e: unknown) {
					Logger.error('Manual KB ingestion failed:', e);
					NoticeManager.showNotice(`KB ingestion failed: ${errorMessage(e)}`);
				}
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
				const choice = await this.confirmDestroyInfrastructure(profile);
				if (!choice.confirmed) return;

				NoticeManager.showNotice('Infrastructure destruction started…');
				try {
					const result = await this.destroyInfrastructure(
						profile,
						{ deleteBuckets: choice.deleteBuckets },
						(event) => {
							Logger.info(`[destroy ${profile.name}] ${event.logicalResourceId} - ${event.status}`);
						},
					);
					if (result.fullyDestroyed) {
						NoticeManager.showNotice('Infrastructure destroyed.');
					} else {
						NoticeManager.showNotice(
							`Some stacks could not be deleted yet (${result.leftoverStacks.join(', ')}). ` +
							(result.authStackRetryNeeded
								? 'Auth stacks with Lambda@Edge may need time for CloudFront to remove edge replicas. '
								: '') +
							'Use "Force-clean leftover infrastructure" in Settings → Danger Zone to finish.',
						);
					}
				} catch (err: unknown) {
					NoticeManager.showNotice(`Error destroying infrastructure: ${errorMessage(err)}`);
				}
			}
		});

		this.registerProfileCommands();
	}

	/**
	 * Create an empty "Untitled" note in Obsidian's default new-note folder and
	 * open it in a new tab. Used by the "Route new note" command, which then runs
	 * the routing pipeline against the returned file. Honors the user's
	 * Files & Links → "Default location for new notes" setting.
	 */
	private async createAndOpenNote(): Promise<TFile> {
		const parent = this.app.fileManager.getNewFileParent('');
		const base = parent.path && parent.path !== '/' ? `${parent.path}/` : '';
		let path = normalizePath(`${base}Untitled.md`);
		// Avoid collisions (Untitled.md, Untitled 1.md, …) — vault.create won't overwrite.
		for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) {
			path = normalizePath(`${base}Untitled ${i}.md`);
		}
		const file = await this.app.vault.create(path, '');
		await this.app.workspace.getLeaf('tab').openFile(file);
		return file;
	}

	/**
	 * Confirmation dialog for tearing down a profile's infrastructure. Resolves
	 * true only if the user explicitly clicks Destroy. Shared by the command and
	 * the Settings "Danger Zone" button so the S3-retention warning stays in one
	 * place.
	 */
	confirmDestroyInfrastructure(profile: PublishingProfile): Promise<{ confirmed: boolean; deleteBuckets: boolean }> {
		return new Promise(resolve => {
			const confirmModal = new Modal(this.app);
			let deleteBuckets = false;
			let settled = false;
			const finish = (confirmed: boolean) => {
				if (settled) return;
				settled = true;
				resolve({ confirmed, deleteBuckets });
				confirmModal.close();
			};

			confirmModal.onOpen = () => {
				confirmModal.contentEl.createEl('h3', { text: 'Destroy Infrastructure' });
				confirmModal.contentEl.createEl('p', {
					text: `This will delete the CloudFormation stacks for profile "${profile.name}". By default the S3 buckets are retained (not deleted); enable the option below to also remove them. This action cannot be undone.`,
				});

				new Setting(confirmModal.contentEl)
					.setName('Also delete S3 data (published content + comments)')
					.setDesc('Empty and remove the retained S3 buckets. This permanently deletes your published site content and any stored comments. Leave off to keep the buckets and their data.')
					.addToggle(toggle => toggle
						.setValue(false)
						.onChange(v => { deleteBuckets = v; }));

				new Setting(confirmModal.contentEl)
					.addButton(btn => btn.setButtonText('Cancel').onClick(() => finish(false)))
					.addButton(btn => btn.setButtonText('Destroy').setWarning().onClick(() => finish(true)));
			};
			confirmModal.onClose = () => finish(false);
			confirmModal.open();
		});
	}

	/**
	 * Reset a profile's infrastructure/auth/comment state to the clean, undeployed
	 * default. Called once teardown has confirmed every stack is gone.
	 */
	private async resetInfrastructureState(profile: PublishingProfile): Promise<void> {
		// No spread — clears cognitoAuth/passwordAuth/comment and intent.
		profile.infrastructureState = { status: 'none', useRoute53: false, originAccessMethod: 'oac' };
		profile.readGate = undefined;
		profile.cognitoAuth = undefined;
		profile.commenting = undefined;
		await this.saveSettings();
	}

	/**
	 * Disconnect a profile from its AWS backend WITHOUT deleting anything in AWS
	 * and WITHOUT touching the profile's local publish state.
	 *
	 * This is the recovery path for a profile stuck with a partial/broken backend
	 * link (e.g. left over from an older, buggy import): it clears every field that
	 * is re-derivable from AWS on a fresh import/deploy — the whole
	 * infrastructureState, the read-gate/Cognito/commenting intent, baseUrl, and the
	 * awsSettings resource pointers (bucketName, cloudFrontDistributionId) — so the
	 * user can immediately re-run the import (or redeploy) against the same or a new
	 * backend.
	 *
	 * Deliberately PRESERVED: the AWS account coordinates (awsProfile/region/
	 * awsAccountId) to pre-fill re-import and to keep deferred edge cleanup working;
	 * `pendingEdgeCleanup` (real orphaned resources awaiting deletion); and the
	 * entire on-disk `profiles/<id>/` tree (slug↔uid mappings, publish history,
	 * content index) — irreplaceable local work with no backend counterpart.
	 *
	 * Contrast: `destroyInfrastructure` deletes the CloudFormation stacks; deleting
	 * the profile loses the local mapping data. Unlink does neither — it makes no
	 * AWS API calls and no on-disk changes; it only invalidates in-memory SDK client
	 * caches so a later re-import/deploy rebuilds them cleanly.
	 */
	async unlinkInfrastructure(profile: PublishingProfile): Promise<void> {
		await this.resetInfrastructureState(profile);   // infrastructureState + readGate/cognito/comment; saves once
		if (profile.awsSettings) {
			this.awsSdkManager.invalidateClients(profile.id);
			this.cloudFormationManager.invalidateClients(profile.id, profile.awsSettings.awsProfile);
			profile.awsSettings.bucketName = '';
			profile.awsSettings.cloudFrontDistributionId = undefined;
		}
		profile.baseUrl = '';
		// pendingEdgeCleanup + the on-disk profiles/<id>/ tree are intentionally left intact.
		await this.saveSettings();
	}

	/**
	 * Tear down a profile's deployed infrastructure: delete its CloudFormation
	 * stacks in dependency order, polling each to completion. Shared by the
	 * `destroy-infrastructure` command and the Settings "Danger Zone" button.
	 *
	 * Callers are expected to have already confirmed with the user (see
	 * `confirmDestroyInfrastructure`) and to have checked the `none`/`imported`
	 * guards; those guards are re-asserted here defensively.
	 *
	 * `onEvent` receives per-resource CloudFormation events (same shape the deploy
	 * flow uses) so the UI can stream live progress.
	 *
	 * By default this is a "polite" teardown — a plain delete that RETAINS the S3
	 * buckets. When `opts.deleteBuckets` is set, it also empties and removes the
	 * otherwise-RETAINed buckets (published content + comments) once their owning
	 * stack is confirmed gone. A Lambda@Edge auth stack commonly lands in
	 * DELETE_FAILED here because CloudFront removes its edge replicas asynchronously
	 * (can take hours). Rather than wipe local state (which used to strand the
	 * leftover under the same deterministic name and break the next deploy with
	 * "stack already exists"), we PRESERVE the state and mark it `failed` whenever
	 * any stack survives (or a requested bucket delete fails), so the Settings
	 * "Force-clean leftover infrastructure" action can finish the job.
	 *
	 * Returns `{ fullyDestroyed, leftoverStacks, authStackRetryNeeded }`.
	 */
	async destroyInfrastructure(
		profile: PublishingProfile,
		opts: { deleteBuckets: boolean },
		onEvent?: (event: StackEvent) => void,
	): Promise<{ fullyDestroyed: boolean; leftoverStacks: string[]; authStackRetryNeeded: boolean }> {
		const state = profile.infrastructureState;
		if (!state || state.status === 'none') {
			throw new Error('No infrastructure deployed for this profile.');
		}
		if (state.imported) {
			throw new Error('Imported stacks cannot be destroyed from the plugin. Manage them via CDK.');
		}

		state.status = 'destroying';
		await this.saveSettings();

		const leftoverStacks: string[] = [];
		let authStackRetryNeeded = false;
		// Stacks confirmed removed (DELETE_COMPLETE or already gone) — a retained
		// bucket may only be deleted once its owning stack is in this set.
		const removedStacks = new Set<string>();

		// Delete a stack and wait for CloudFormation to finish removing it. Once a
		// stack is fully gone, DescribeStacks by name raises a ValidationError
		// ("Stack ... does not exist") rather than reporting DELETE_COMPLETE — treat
		// that as success. A DELETE_FAILED result or an unexpected error records the
		// stack as a leftover (never throws, so remaining stacks still get attempted).
		const deleteAndWait = async (stackName: string, region: string | undefined, isAuthStack: boolean): Promise<void> => {
			try {
				await this.cloudFormationManager.deleteStack(stackName, profile, region);
				const finalStatus = await this.cloudFormationManager.pollStackUntilComplete(
					stackName,
					profile,
					(event) => onEvent?.(event),
					region,
				);
				if (finalStatus === 'DELETE_FAILED') {
					leftoverStacks.push(stackName);
					if (isAuthStack) authStackRetryNeeded = true;
				} else {
					removedStacks.add(stackName);
				}
			} catch (err: unknown) {
				const message = errorMessage(err);
				if (/does not exist/i.test(message)) { removedStacks.add(stackName); return; } // Already gone — success.
				Logger.warn(`Failed to delete stack ${stackName}:`, err);
				leftoverStacks.push(stackName);
				if (isAuthStack) authStackRetryNeeded = true;
			}
		};

		if (state.comment?.stackName) {
			// Delete the comment stack before the site stack so the /comments/*
			// origin's referenced bucket policy is gone first.
			await deleteAndWait(state.comment.stackName, state.region, false);
		}
		if (state.fullStackName) {
			await deleteAndWait(state.fullStackName, state.region, false);
		}
		if (state.certStackName && !state.certificateReused) {
			// Never delete a certificate we reused rather than created — it is owned
			// outside this profile's stacks. (A reused cert also leaves certStackName
			// unset; this is belt-and-suspenders.)
			await deleteAndWait(state.certStackName, 'us-east-1', false);
		}
		if (state.cognitoAuth?.stackName) {
			// Lambda@Edge replica-removal caveat — first delete often DELETE_FAILED.
			await deleteAndWait(state.cognitoAuth.stackName, 'us-east-1', true);
		}
		if (state.passwordAuth?.stackName) {
			await deleteAndWait(state.passwordAuth.stackName, 'us-east-1', true);
		}

		// When opted in, remove the retained, fixed-name buckets (they survive stack
		// deletion via deletionPolicy: RETAIN). Only delete a bucket once its OWNING
		// stack is confirmed gone — deleting it while the stack lingers in
		// DELETE_FAILED would drop data out from under a stack that still references
		// it. A bucket that can't be emptied/deleted keeps the run from being clean.
		let bucketCleanupFailed = false;
		if (opts.deleteBuckets) {
			const bucketTargets: Array<{ bucket: string; ownerStack?: string }> = [];
			if (profile.awsSettings?.bucketName) {
				bucketTargets.push({ bucket: profile.awsSettings.bucketName, ownerStack: state.fullStackName });
			}
			if (state.comment?.bucketName) {
				bucketTargets.push({ bucket: state.comment.bucketName, ownerStack: state.comment.stackName });
			}
			for (const { bucket, ownerStack } of bucketTargets) {
				// If we know the owning stack and it wasn't removed, skip — the stack
				// is already recorded as a leftover, so the run is not fully clean.
				if (ownerStack && !removedStacks.has(ownerStack)) continue;
				try {
					await this.cloudFormationManager.deleteBucket(bucket, profile);
				} catch (err) {
					Logger.warn(`Could not delete bucket ${bucket}:`, err);
					bucketCleanupFailed = true;
				}
			}
		}

		if (leftoverStacks.length === 0 && !bucketCleanupFailed) {
			await this.resetInfrastructureState(profile);
			return { fullyDestroyed: true, leftoverStacks: [], authStackRetryNeeded: false };
		}

		// Leftovers remain — keep every stack reference so they stay trackable and
		// the force-clean action can find them; don't strand them under 'none'.
		state.status = 'failed';
		await this.saveSettings();
		return { fullyDestroyed: false, leftoverStacks, authStackRetryNeeded };
	}

	/**
	 * Finish tearing down leftover stacks a polite destroy could not remove
	 * (commonly Lambda@Edge auth stacks stuck in DELETE_FAILED). Force-deletes each
	 * still-present stack via `forceDeleteStack` (which uses DeletionMode
	 * FORCE_DELETE_STACK to orphan resources it can't delete yet — e.g. a
	 * still-replicating edge function and its role — and drain the stack). Those
	 * orphaned resources are parked in `profile.pendingEdgeCleanup` for a deferred,
	 * retry-until-success deletion. When `opts.deleteBuckets` is set, also empties and
	 * removes the otherwise-RETAINed S3 buckets (published content + comments) so a
	 * redeploy of a fixed-name bucket doesn't collide.
	 *
	 * Only ever invoked from the Settings action after an explicit confirm. Resets
	 * the profile to the clean default when every targeted stack is gone; otherwise
	 * leaves `status: 'failed'` and reports which stacks remain. `orphanedEdgeCount`
	 * tells the caller how many edge resources were scheduled for deferred cleanup.
	 */
	async forceCleanInfrastructure(
		profile: PublishingProfile,
		opts: { deleteBuckets: boolean },
		onEvent?: (event: StackEvent) => void,
	): Promise<{ fullyCleaned: boolean; leftoverStacks: string[]; orphanedEdgeCount: number }> {
		const state = profile.infrastructureState;
		if (!state) {
			throw new Error('No infrastructure state for this profile.');
		}
		if (state.imported) {
			throw new Error('Imported stacks cannot be destroyed from the plugin. Manage them via CDK.');
		}

		const cf = this.cloudFormationManager;
		const leftoverStacks: string[] = [];
		// Stacks confirmed removed (DELETE_COMPLETE or already gone) — a retained
		// bucket may only be deleted once its owning stack is in this set.
		const removedStacks = new Set<string>();
		// Lambda@Edge resources orphaned to drain a stuck stack — parked on the profile
		// for deferred deletion once CloudFront removes their replicas.
		const orphanedEdge: OrphanedEdgeResource[] = [];

		// Force-delete a stack if it is still present, retaining any resources
		// CloudFormation can't remove (e.g. a still-replicating Lambda@Edge fn).
		const forceClean = async (stackName: string, region: string | undefined): Promise<void> => {
			const status = await cf.getStackStatusSafe(stackName, profile, region);
			if (status === null) { removedStacks.add(stackName); return; } // Already gone.

			const { status: finalStatus, orphaned } = await cf.forceDeleteStack(stackName, profile, region, onEvent);
			// Orphaned edge resources are collected whether or not the stack fully
			// drained — they exist in AWS and must be cleaned up regardless.
			orphanedEdge.push(...orphaned);
			if (finalStatus === 'DELETE_COMPLETE') {
				removedStacks.add(stackName);
			} else {
				leftoverStacks.push(stackName);
			}
		};

		if (state.comment?.stackName) await forceClean(state.comment.stackName, state.region);
		if (state.fullStackName) await forceClean(state.fullStackName, state.region);
		if (state.certStackName && !state.certificateReused) await forceClean(state.certStackName, 'us-east-1');
		if (state.cognitoAuth?.stackName) await forceClean(state.cognitoAuth.stackName, 'us-east-1');
		if (state.passwordAuth?.stackName) await forceClean(state.passwordAuth.stackName, 'us-east-1');

		// Remove the retained, fixed-name buckets (they survive stack deletion via
		// deletionPolicy: RETAIN and are what collide on redeploy). Only delete a
		// bucket once its OWNING stack is confirmed gone — deleting it while the
		// stack lingers in DELETE_FAILED would drop data out from under a stack that
		// still references it. A bucket that can't be emptied/deleted is a leftover.
		let bucketCleanupFailed = false;
		if (opts.deleteBuckets) {
			const bucketTargets: Array<{ bucket: string; ownerStack?: string }> = [];
			if (profile.awsSettings?.bucketName) {
				bucketTargets.push({ bucket: profile.awsSettings.bucketName, ownerStack: state.fullStackName });
			}
			if (state.comment?.bucketName) {
				bucketTargets.push({ bucket: state.comment.bucketName, ownerStack: state.comment.stackName });
			}
			for (const { bucket, ownerStack } of bucketTargets) {
				// If we know the owning stack and it wasn't removed, skip — the stack
				// is already recorded as a leftover, so the run is not fully clean.
				if (ownerStack && !removedStacks.has(ownerStack)) continue;
				try {
					await cf.deleteBucket(bucket, profile);
				} catch (err) {
					Logger.warn(`Could not delete bucket ${bucket}:`, err);
					bucketCleanupFailed = true;
				}
			}
		}

		// Park any orphaned edge resources for deferred cleanup BEFORE the possible
		// resetInfrastructureState below — the reset wipes infrastructureState, but
		// pendingEdgeCleanup lives on the profile and must survive it. Kick off an
		// opportunistic cleanup attempt too (most will be still-replicating and get
		// left for a later retry).
		if (orphanedEdge.length > 0) {
			profile.pendingEdgeCleanup = [...(profile.pendingEdgeCleanup || []), ...orphanedEdge];
			await this.saveSettings();
			void this.cleanupOrphanedEdgeResources(profile);
		}

		if (leftoverStacks.length === 0 && !bucketCleanupFailed) {
			await this.resetInfrastructureState(profile);
			return { fullyCleaned: true, leftoverStacks: [], orphanedEdgeCount: orphanedEdge.length };
		}

		state.status = 'failed';
		await this.saveSettings();
		return { fullyCleaned: false, leftoverStacks, orphanedEdgeCount: orphanedEdge.length };
	}

	/**
	 * Delete Lambda@Edge functions (and their execution roles) that a force-clean
	 * had to orphan to drain a stuck stack. These can't be deleted until CloudFront
	 * finishes removing their edge replicas (up to a few hours), so this is a
	 * retry-until-success pass: a still-replicating function is left in
	 * `pendingEdgeCleanup` for a later attempt; an already-gone or successfully
	 * deleted resource is cleared. Safe to call repeatedly (on load, or from the
	 * Settings button). Returns how many resources were cleaned vs. still pending.
	 */
	async cleanupOrphanedEdgeResources(
		profile: PublishingProfile,
	): Promise<{ cleaned: number; stillPending: number }> {
		const pending = profile.pendingEdgeCleanup;
		if (!pending || pending.length === 0) return { cleaned: 0, stillPending: 0 };

		let cleaned = 0;
		const remaining: OrphanedEdgeResource[] = [];

		for (const entry of pending) {
			const next: OrphanedEdgeResource = { ...entry };

			// Delete the function first. A "replicated function" error means CloudFront
			// hasn't finished removing replicas yet — leave it (and its role) for a
			// later retry so we don't strand the role behind a still-present function.
			if (next.functionName) {
				const outcome = await this.deleteOrphanedFunction(profile, next.region, next.functionName);
				if (outcome === 'deleted' || outcome === 'gone') {
					cleaned += 1;
					next.functionName = undefined;
				} else {
					// still-replicating — keep the whole entry as-is for next time.
					remaining.push(entry);
					continue;
				}
			}

			if (next.roleName) {
				const outcome = await this.deleteOrphanedRole(profile, next.region, next.roleName);
				if (outcome === 'deleted' || outcome === 'gone') {
					cleaned += 1;
					next.roleName = undefined;
				}
				// A role delete rarely fails transiently; if it did, we keep it below.
			}

			// Keep the entry only if something still needs deleting.
			if (next.functionName || next.roleName) remaining.push(next);
		}

		profile.pendingEdgeCleanup = remaining.length > 0 ? remaining : undefined;
		await this.saveSettings();

		const stillPending = remaining.reduce(
			(n, e) => n + (e.functionName ? 1 : 0) + (e.roleName ? 1 : 0),
			0,
		);
		return { cleaned, stillPending };
	}

	/** Delete one orphaned Lambda@Edge function. Returns 'gone' if it no longer
	 * exists, 'deleted' on success, or 'replicating' if CloudFront hasn't cleared
	 * its replicas yet (retry later). Unexpected errors are logged and treated as
	 * 'replicating' so the entry is retried rather than silently dropped. */
	private async deleteOrphanedFunction(
		profile: PublishingProfile,
		region: string,
		functionName: string,
	): Promise<'deleted' | 'gone' | 'replicating'> {
		const client = this.awsSdkManager.getLambdaClient(profile, region);
		try {
			await client.send(new DeleteFunctionCommand({ FunctionName: functionName }));
			Logger.info(`Deleted orphaned Lambda@Edge function ${functionName}`);
			return 'deleted';
		} catch (err: unknown) {
			const name = errorCode(err);
			if (name === 'ResourceNotFoundException') return 'gone';
			// CloudFront still has replicas — the canonical "not ready yet" error.
			if (name === 'InvalidParameterValueException' || /replicated function/i.test(errorMessage(err))) {
				Logger.info(`Lambda@Edge ${functionName} still replicating; will retry later.`);
				return 'replicating';
			}
			Logger.warn(`Could not delete orphaned Lambda function ${functionName}:`, err);
			return 'replicating';
		}
	}

	/** Delete one orphaned edge-function execution role: detach its managed policies
	 * (the stack attaches AWSLambdaBasicExecutionRole) then delete it. Returns 'gone'
	 * if it no longer exists, 'deleted' on success, or 'failed' otherwise. */
	private async deleteOrphanedRole(
		profile: PublishingProfile,
		region: string,
		roleName: string,
	): Promise<'deleted' | 'gone' | 'failed'> {
		const client = this.awsSdkManager.getIamClient(profile, region);
		try {
			const attached = await client.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
			for (const policy of attached.AttachedPolicies || []) {
				if (policy.PolicyArn) {
					await client.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: policy.PolicyArn }));
				}
			}
			await client.send(new DeleteRoleCommand({ RoleName: roleName }));
			Logger.info(`Deleted orphaned edge-fn role ${roleName}`);
			return 'deleted';
		} catch (err: unknown) {
			const name = errorCode(err);
			if (name === 'NoSuchEntityException') return 'gone';
			Logger.warn(`Could not delete orphaned IAM role ${roleName}:`, err);
			return 'failed';
		}
	}

	async loadSettings() {
		const saved = (await this.loadData()) as Partial<CommonplaceNotesSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
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
						void this.frontmatterManager.togglePublishContext(activeFile, profile.id);
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
			if (profile.publishContentIndex || profile.chat?.enabled) {
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
					if (profile.publishContentIndex) {
						await this.contentIndexManager.queueUpdate(profile.id, uid, title, indexRaw);
					}
					if (profile.chat?.enabled) {
						await this.kbCorpusManager.queueUpdate(profile.id, uid, title, indexRaw);
					}
				}
			}
		}

		// apply queued updates
		await this.contentIndexManager.applyQueuedUpdates(profile.id);
		await this.kbCorpusManager.applyQueuedUpdates(profile.id);
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
		const stringifyArray = (arr: unknown[]): string =>
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
					currentContexts: (this.frontmatterManager.getFrontmatterValue(file, 'cpn-publish-contexts') as string[] | undefined) || [],
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
				const currentContexts = (this.frontmatterManager.getFrontmatterValue(file, 'cpn-publish-contexts') as string[] | undefined) || [];
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