import { TFile, SuggestModal, App } from 'obsidian';
import CommonplaceNotesPlugin from '../main';
import { PublishingProfile, NoteConnection, CloudFrontInvalidationScheme } from '../types';
import { pushLocalJsonsToS3, deleteNoteHashesFromS3, deleteKbCorpusFromS3, pushMappingAndIndexToS3, createCloudFrontInvalidation } from './awsUpload';
import { publishLocalNotes } from './local';
import { PathUtils } from '../utils/path';
import { Logger, errorMessage } from '../utils/logging';
import { NoticeManager } from '../utils/notice';
import { restrictedPrefix } from '../utils/access';
import { UID_KEY } from '../utils/uidResolver';
import {
	auditPublishedUids,
	describePublishedUid,
	formatUidAudit,
	type AuditVaultNote,
	type PublishedUid,
	type UidAuditReport,
} from '../utils/uidAudit';

class ProfileSuggestModal extends SuggestModal<PublishingProfile> {
	profiles: PublishingProfile[];
	onChoose: (profile: PublishingProfile) => void;

	constructor(app: App, profiles: PublishingProfile[], onChoose: (profile: PublishingProfile) => void) {
		super(app);
		this.profiles = profiles;
		this.onChoose = onChoose;
	}

	getSuggestions(query: string): PublishingProfile[] {
		return this.profiles.filter(profile => 
			profile.name.toLowerCase().includes(query.toLowerCase())
		);
	}

	renderSuggestion(profile: PublishingProfile, el: HTMLElement) {
		el.createEl("div", { text: profile.name });
	}

	onChooseSuggestion(profile: PublishingProfile, evt: MouseEvent | KeyboardEvent) {
		this.onChoose(profile);
	}
}

class NoteSuggestModal extends SuggestModal<PublishedUid> {
	entries: PublishedUid[];
	onChoose: (entry: PublishedUid) => void;

	constructor(app: App, entries: PublishedUid[], placeholder: string, onChoose: (entry: PublishedUid) => void) {
		super(app);
		this.entries = entries;
		this.onChoose = onChoose;
		this.setPlaceholder(placeholder);
	}

	getSuggestions(query: string): PublishedUid[] {
		const q = query.toLowerCase();
		return this.entries.filter(entry =>
			entry.label.toLowerCase().includes(q)
			|| entry.uid.toLowerCase().includes(q)
			|| (entry.title ?? '').toLowerCase().includes(q)
		);
	}

	renderSuggestion(entry: PublishedUid, el: HTMLElement) {
		el.createEl("div", { text: entry.label });
		const detail = describePublishedUid(entry);
		el.createEl("small", { text: detail ? `${entry.uid} · ${detail}` : entry.uid, cls: 'suggestion-note' });
	}

	onChooseSuggestion(entry: PublishedUid, evt: MouseEvent | KeyboardEvent) {
		this.onChoose(entry);
	}
}

class ConfirmSuggestModal extends SuggestModal<string> {
	options: string[];
	onChoose: (choice: string) => void;

	constructor(app: App, slug: string, onChoose: (choice: string) => void) {
		super(app);
		this.options = ['No', 'Yes'];
		this.onChoose = onChoose;
		this.setPlaceholder(`Type 'yes' to confirm deletion of: ${slug}`);
	}

	getSuggestions(query: string): string[] {
		return this.options.filter(opt =>
			opt.toLowerCase().includes(query.toLowerCase())
		);
	}

	renderSuggestion(option: string, el: HTMLElement) {
		el.createEl("div", { text: option });
	}

	onChooseSuggestion(option: string, evt: MouseEvent | KeyboardEvent) {
		this.onChoose(option);
	}
}

export class Publisher {
	private plugin: CommonplaceNotesPlugin;

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
	}

	async getPublishContextsForFile(file: TFile): Promise<string[]> {
		return this.plugin.frontmatterManager.normalizePublishContexts(file);
	}

	async promptForProfile(availableProfiles?: string[]): Promise<PublishingProfile | null> {
		// default to grabbing all profiles in plugin settings
		if (!availableProfiles) {
			availableProfiles = this.plugin.settings.publishingProfiles.map(p => p.id);
		}
		
		return new Promise((resolve) => {
			const profiles = this.plugin.settings.publishingProfiles.filter(
				p => availableProfiles.includes(p.id)
			);

			if (profiles.length === 0) {
				NoticeManager.showNotice('No valid publishing profiles available');
				resolve(null);
				return;
			}

			if (profiles.length === 1) {
				resolve(profiles[0]);
				return;
			}

			new ProfileSuggestModal(this.plugin.app, profiles, (profile) => {
				resolve(profile);
			}).open();
		});
	}

	public isFileExcluded(file: TFile, profile: PublishingProfile): boolean {
		const filePath = file.path;
		return profile.excludedDirectories.some(dir => 
			filePath.startsWith(dir) || filePath.includes('/' + dir + '/')
		);
	}

	// TODO::extend this to allow for no filtering by profileId::
	async getConnectedNotes(file: TFile, profileId: string): Promise<NoteConnection[]> {
		const resolvedLinks = this.plugin.app.metadataCache.resolvedLinks;
		const connections = new Map<string, NoteConnection>();
		const profile = this.plugin.settings.publishingProfiles.find(p => p.id === profileId);

		if (!profile) {
			Logger.error(`No profile found with id ${profileId}`);
			return [];
		}

		// Process outgoing links
		const outgoing = resolvedLinks[file.path] || {};
		for (const path of Object.keys(outgoing)) {
			const connectedFile = this.plugin.app.vault.getAbstractFileByPath(path);
			if (connectedFile instanceof TFile && !this.isFileExcluded(connectedFile, profile)) {
				const contexts = await this.getPublishContextsForFile(connectedFile);
				if (contexts.includes(profileId)) {
					// Peek, never mint. Minting here runs after the batch's frontmatter
					// was written and before Obsidian re-indexed it, which is how one
					// note used to get a second UID. A connected note without a UID is
					// still returned, so "Publish active and connected notes" includes it.
					const uid = this.plugin.frontmatterManager.peekNoteUID(connectedFile);
					// A note that can't publish (e.g. undefined access group) is not
					// on the site, so it's not a connection either.
					const access = this.plugin.noteManager.resolveNoteAccess(connectedFile, profile);
					if (!access.ok) continue;
					connections.set(path, {
						file: connectedFile,
						isBacklink: false,
						isOutgoingLink: true,
						uid,
						slug: PathUtils.slugifyFilePath(connectedFile.path),
						title: this.plugin.frontmatterManager.getNoteTitle(connectedFile),
						access: access.groups,
					});
				}
			}
		}

		// Process incoming links (backlinks)
		for (const [sourcePath, links] of Object.entries(resolvedLinks)) {
			if (links[file.path]) {
				const connectedFile = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
				if (connectedFile instanceof TFile && !this.isFileExcluded(connectedFile, profile)) {
					const contexts = await this.getPublishContextsForFile(connectedFile);
					if (contexts.includes(profileId)) {
						const uid = this.plugin.frontmatterManager.peekNoteUID(connectedFile);
						const access = this.plugin.noteManager.resolveNoteAccess(connectedFile, profile);
						if (!access.ok) continue;
						if (connections.has(sourcePath)) {
							// Update existing connection to mark it as both incoming and outgoing
							connections.get(sourcePath)!.isBacklink = true;
						} else {
							connections.set(sourcePath, {
								file: connectedFile,
								isBacklink: true,
								isOutgoingLink: false,
								uid,
								slug: PathUtils.slugifyFilePath(connectedFile.path),
								title: this.plugin.frontmatterManager.getNoteTitle(connectedFile),
								access: access.groups,
							});
						}
					}
				}
			}
		}

		return Array.from(connections.values());
	}

	async publishNotes(
		files: TFile[],
		profile: PublishingProfile,
		updatePublishTimestamp: boolean = false,
		triggerCloudFrontInvalidation: boolean = false
	) {
		try {
			await NoticeManager.showProgress(
				`Processing ${files.length} notes`,
				(async () => {
					// Ensure all required directories exist before processing
					await this.plugin.profileManager.initializeProfileDirectories(profile.id);

					// Load existing mappings and content index for profile
					await this.plugin.mappingManager.loadProfileMappings(profile.id);
					await this.plugin.contentIndexManager.loadIndex(profile.id);
					// Last-published access groups (re-read from disk, so a failed
					// earlier run's unsaved transitions are recomputed).
					await this.plugin.accessManager.load(profile.id);

					// Discover + compile parser stages once per batch (vault overrides
					// + built-in scaffolds). markdownToHtml then assembles a per-note
					// pipeline from these cached, compiled stages.
					await this.plugin.parserExtensionManager.loadExtensions(profile.id);

					// Start from a clean slate: drop notes an earlier, failed publish
					// queued but never committed, and write any frontmatter it minted
					// but never wrote. Those UIDs were never published, and a note
					// that has since got a UID on disk keeps it.
					this.plugin.noteManager.discardQueued(profile.id);
					if (this.plugin.frontmatterManager.hasUpdates()) {
						await this.plugin.frontmatterManager.process();
					}

					// Queue all notes for processing
					for (const file of files) {
						await this.plugin.noteManager.queueNote(file, profile.id);
					}

					Logger.debug(`${files.length} notes processed`);
				})(),
				`${files.length} notes processed`
			);

			// Commit frontmatter + write queued notes to staging, with a loading Notice
			// covering the (potentially long) per-note JSON write-out loop.
			const staging = await NoticeManager.showProgress(
				`Writing ${files.length} notes to staging`,
				(async () => {
					// Commit any pending frontmatter updates
					if (this.plugin.frontmatterManager.hasUpdates()) {
						Logger.debug(`Processing frontmatter updates`);
						const { uidConflicts } = await this.plugin.frontmatterManager.process();
						if (uidConflicts.length > 0) {
							// A note got a different cpn-uid on disk (sync, a hand edit)
							// after this batch minted one for it. Publishing now would put
							// the note on the site under the minted UID while the vault
							// keeps the other one, so stop before anything is staged.
							this.plugin.noteManager.discardQueued(profile.id);
							throw new Error(
								`The cpn-uid of ${uidConflicts.join(', ')} changed while publishing. Nothing was published; publish again.`,
							);
						}
					}

					// Commit all queued notes to staging
					await this.plugin.noteManager.commitPendingNotes(profile.id);

					// Staging only looks UIDs up, so nothing should be queued now. If
					// something was, write it rather than leave it for a later publish.
					if (this.plugin.frontmatterManager.hasUpdates()) {
						Logger.warn('Frontmatter edits were queued while staging notes; writing them now');
						await this.plugin.frontmatterManager.process();
					}
				})(),
				`${files.length} notes staged`
			);
			if (!staging.success) {
				throw staging.error ?? new Error('Note staging failed');
			}

			// Upload to destination
			let uploadSuccess = false;
			if (profile.publishMechanism === 'AWS') {
				uploadSuccess = await pushLocalJsonsToS3(this.plugin, profile.id, triggerCloudFrontInvalidation);
			} else if (profile.publishMechanism === 'Local') {
				uploadSuccess = await publishLocalNotes(this.plugin, profile.id);
				// Local has no partitions (gated notes can't publish there); just
				// persist the access map.
				if (uploadSuccess) {
					this.plugin.accessManager.consumeTransitions(profile.id);
					this.plugin.accessManager.consumeHomeRemoved(profile.id);
					await this.plugin.accessManager.save(profile.id);
				}
			}

			// TODO::instead should prompt user whether to delete local copies of processed notes::
			// (for now just stopping here to not delete anything)
			if (!uploadSuccess) {
				NoticeManager.showNotice('Publishing failed. Staged files preserved for retry.');
				return;
			}

			// Clean up staged files
			await this.cleanupStagedFiles(profile.id);

			// Update timestamp for full publishes
			if (updatePublishTimestamp) {
				const profileIndex = this.plugin.settings.publishingProfiles
					.findIndex(p => p.id === profile.id);
				if (profileIndex !== -1) {
					this.plugin.settings.publishingProfiles[profileIndex]
						.lastFullPublishTimestamp = Date.now();
					await this.plugin.saveSettings();
				}
			}

			NoticeManager.showNotice(`Successfully published ${files.length} note(s)`);

			// Auto-trigger KB ingestion so the freshly-published kb/ corpus becomes
			// queryable. Best-effort: ingestion lag is expected, so a failure here
			// must not fail the publish. Manual-sync profiles skip this (button/command).
			if (profile.publishMechanism === 'AWS'
				&& profile.chat?.enabled
				&& (profile.chat.sync ?? 'auto') === 'auto') {
				try {
					const jobId = await this.plugin.cloudFormationManager.startChatIngestion(profile);
					if (jobId) NoticeManager.showNotice('Chat knowledge base ingestion started');
				} catch (e) {
					Logger.warn('KB ingestion trigger failed (publish still succeeded):', e);
				}
			}
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			NoticeManager.showNotice(`Error during publishing: ${err.message}`);
			Logger.error('Publishing error:', err);

			// Move staged files to error directory
			await this.handlePublishError(profile.id, err);
		}
	}

	private async cleanupStagedFiles(profileId: string) {
		const stagedDir = this.plugin.profileManager.getStagedNotesDir(profileId);
		await new PathUtils().deleteFilesInDirectory(this.plugin, stagedDir);
		// Gated copies live in staged-notes/restricted/<group>/.
		const restrictedDir = `${stagedDir}/restricted`;
		if (await this.plugin.app.vault.adapter.exists(restrictedDir)) {
			await this.plugin.app.vault.adapter.rmdir(restrictedDir, true);
		}
	}

	private async handlePublishError(profileId: string, error: Error) {
		const stagedDir = this.plugin.profileManager.getStagedNotesDir(profileId);
		const errorDir = this.plugin.profileManager.getStagedErrorDir(profileId);

		// Create timestamp for error session
		const errorTimestamp = Date.now();
		const errorSessionDir = `${errorDir}/${errorTimestamp}`;

		try {
			// Ensure error session directory exists
			await PathUtils.ensureDirectory(this.plugin, errorSessionDir);

			// Move staged files to error directory (gated copies keep their
			// restricted/<group>/ subpath)
			const adapter = this.plugin.app.vault.adapter;
			const copyDir = async (from: string, to: string) => {
				const listing = await adapter.list(from);
				for (const file of listing.files) {
					await adapter.copy(file, `${to}/${file.split('/').pop()}`);
				}
				for (const folder of listing.folders) {
					const sub = `${to}/${folder.split('/').pop()}`;
					await PathUtils.ensureDirectory(this.plugin, sub);
					await copyDir(folder, sub);
				}
			};
			await copyDir(stagedDir, errorSessionDir);

			// Write error details
			await this.plugin.app.vault.adapter.write(
				`${errorSessionDir}/error.json`,
				JSON.stringify({
					timestamp: errorTimestamp,
					error: error.message,
					stack: error.stack
				})
			);

			// Clean up staged directory
			await this.cleanupStagedFiles(profileId);

			NoticeManager.showNotice(`Publish failed. Error details saved to ${errorSessionDir}`);
		} catch (moveError) {
			Logger.error('Error handling publish failure:', moveError);
			NoticeManager.showNotice('Failed to save error details. Check console for more information.');
		}
	}

	async getAllPublishableNotes(profileId: string): Promise<TFile[]> {
		const files: TFile[] = [];
		const profile = this.plugin.settings.publishingProfiles.find(p => p.id === profileId);

		if (!profile) {
			Logger.error(`No profile found with id ${profileId}`);
			return files;
		}

		const allFiles = this.plugin.app.vault.getMarkdownFiles();
		for (const file of allFiles) {
			if (file.extension === 'md' && !this.isFileExcluded(file, profile)) {
				const contexts = await this.getPublishContextsForFile(file);
				if (contexts.includes(profileId)) {
					files.push(file);
				}
			}
		}

		return files;
	}

	async getUpdatedNotes(profileId: string): Promise<TFile[]> {
		const profile = this.plugin.settings.publishingProfiles.find(p => p.id === profileId);
		if (!profile) return [];

		const allPublishable = await this.getAllPublishableNotes(profileId);
		return allPublishable.filter(file => 
			file.stat.mtime > (profile.lastFullPublishTimestamp || 0)
		);
	}

	private shouldInvalidateCloudFront(profile: PublishingProfile, publishType: CloudFrontInvalidationScheme): boolean {
		if (!profile.awsSettings?.cloudFrontDistributionId) return false;
		if (profile.awsSettings.cloudFrontInvalidationScheme === 'manual') return false;
		
		// Define hierarchy of publish types
		const hierarchyLevels = {
			'individual': 1,
			'connected': 2,
			'sinceLast': 3,
			'all': 4,
			'manual': 5,
		};

		// Get the level of the current publish type
		const currentLevel = hierarchyLevels[publishType];
		
		// Get the level set in the profile settings
		const configuredLevel = hierarchyLevels[profile.awsSettings.cloudFrontInvalidationScheme];

		// Return true if the current publish level is at or above the configured level
		return currentLevel >= configuredLevel;
	}

	async publishSingle(file: TFile) {
		const contexts = await this.getPublishContextsForFile(file);
		if (contexts.length === 0) {
			NoticeManager.showNotice('No publishing contexts defined for this note');
			return;
		}

		const profile = await this.promptForProfile(contexts);
		if (!profile) return;

		if (this.isFileExcluded(file, profile)) {
			Logger.debug(`Note ${file.path} is in an excluded directory and cannot be published`);
			return;
		}

		const triggerInvalidation = this.shouldInvalidateCloudFront(profile, 'individual');
		await this.publishNotes([file], profile, false, triggerInvalidation);
	}

	async publishConnected(file: TFile) {
		const contexts = await this.getPublishContextsForFile(file);
		if (contexts.length === 0) {
			NoticeManager.showNotice('No publishing contexts defined for this note');
			return;
		}

		const profile = await this.promptForProfile(contexts);
		if (!profile) return;

		if (this.isFileExcluded(file, profile)) {
			NoticeManager.showNotice('This note is in an excluded directory and cannot be published');
			return;
		}

		const connections = await this.getConnectedNotes(file, profile.id);
		const connectedFiles = connections.map(conn => conn.file);
		connectedFiles.push(file); // Include the active note

		const triggerInvalidation = this.shouldInvalidateCloudFront(profile, 'connected');
		await this.publishNotes(connectedFiles, profile, false, triggerInvalidation);
	}

	async publishUpdates() {
		const profile = await this.promptForProfile();
		if (!profile) return;

		const updatedNotes = await this.getUpdatedNotes(profile.id);
		if (updatedNotes.length === 0) {
			NoticeManager.showNotice('No updates found since last full publish');
			return;
		}

		const triggerInvalidation = this.shouldInvalidateCloudFront(profile, 'sinceLast');
		await this.publishNotes(updatedNotes, profile, true, triggerInvalidation);
	}

	async publishAll() {
		const profile = await this.promptForProfile();
		if (!profile) return;

		const allNotes = await this.getAllPublishableNotes(profile.id);
		if (allNotes.length === 0) {
			NoticeManager.showNotice('No publishable notes found for this profile');
			return;
		}

		const triggerInvalidation = this.shouldInvalidateCloudFront(profile, 'all');
		await this.publishNotes(allNotes, profile, true, triggerInvalidation);
	}

	/**
	 * Every UID this profile's local ledger says is published, checked against
	 * the vault. Reads local files only (no S3 calls).
	 */
	async auditUids(profile: PublishingProfile): Promise<UidAuditReport> {
		await this.plugin.mappingManager.loadProfileMappings(profile.id);
		const contentIndex = await this.plugin.contentIndexManager.loadIndex(profile.id);
		const fm = this.plugin.frontmatterManager;
		const vault: AuditVaultNote[] = this.plugin.app.vault.getMarkdownFiles().map((file) => {
			const raw = fm.getFrontmatterValue(file, UID_KEY);
			return {
				path: file.path,
				uid: fm.peekNoteUID(file),
				nonStringUid: raw !== null && raw !== undefined && typeof raw !== 'string',
				publishable: !this.isFileExcluded(file, profile)
					&& fm.normalizePublishContexts(file).includes(profile.id),
			};
		});
		return auditPublishedUids(
			{
				slugToUid: this.plugin.mappingManager.getSlugToUidMap(profile.id),
				uidToHash: this.plugin.mappingManager.getUidToHashMap(profile.id),
				contentIndex,
			},
			vault,
			this.plugin.settings.uidLength ?? 8,
		);
	}

	/**
	 * "Audit published notes": report published UIDs that no vault note
	 * carries (typically a stale copy left after a note's UID changed), UIDs
	 * whose note stopped publishing, and UIDs shared by several notes. Details
	 * go to the console; on AWS profiles the delete picker then opens on the
	 * flagged UIDs.
	 */
	async auditPublishedNotes(): Promise<void> {
		const profile = await this.promptForProfile();
		if (!profile) return;

		const report = await this.auditUids(profile);
		Logger.info(`Audit of published notes for profile '${profile.id}':\n${formatUidAudit(report).join('\n')}`);

		const flagged = report.orphans.length + report.unpublishedInVault.length;
		const summary = [
			`Audit of "${profile.name}": ${report.published.length} published UID(s).`,
			`${report.orphans.length} with no vault note.`,
			`${report.unpublishedInVault.length} whose note no longer publishes here.`,
			`${report.sharedUids.length} UID(s) shared by more than one note.`,
			'Details are in the developer console.',
		];
		const canDelete = profile.publishMechanism === 'AWS' && !!profile.awsSettings;
		if (flagged > 0 && !canDelete) {
			summary.push('Deleting published notes is only supported for AWS profiles.');
		}
		NoticeManager.showNotice(summary.join('\n'), 15000);

		if (flagged > 0 && canDelete) {
			await this.deletePublishedNote(profile, true);
		}
	}

	/**
	 * "Delete a published note": pick a published UID and remove it from the
	 * site. The list comes from the local ledger, not just the slug map, so a
	 * stale UID left behind by a UID change can be picked too. With
	 * `flaggedOnly`, only UIDs the audit flagged are listed.
	 */
	async deletePublishedNote(preselected?: PublishingProfile, flaggedOnly = false) {
		// Step 1: Select profile
		const profile = preselected ?? await this.promptForProfile();
		if (!profile) return;

		if (profile.publishMechanism !== 'AWS' || !profile.awsSettings) {
			NoticeManager.showNotice('Delete is only supported for AWS publishing profiles');
			return;
		}

		// Step 2: List published UIDs (flagged ones first) and pick one
		const report = await this.auditUids(profile);
		const entries = flaggedOnly
			? report.published.filter(e => e.orphan || e.unpublishedInVault)
			: report.published;

		if (entries.length === 0) {
			NoticeManager.showNotice(flaggedOnly
				? 'No stale published UIDs found for this profile'
				: 'No published notes found for this profile');
			return;
		}

		const selectedNote = await new Promise<PublishedUid | null>((resolve) => {
			new NoteSuggestModal(
				this.plugin.app,
				entries,
				flaggedOnly
					? 'Pick a stale published UID to delete (Esc to close)...'
					: 'Search for a published note to delete...',
				(entry) => resolve(entry),
			).open();
		});
		if (!selectedNote) return;

		// Step 3: Confirmation
		const confirmed = await new Promise<boolean>((resolve) => {
			new ConfirmSuggestModal(this.plugin.app, `${selectedNote.label} (${selectedNote.uid})`, (choice) => {
				resolve(choice === 'Yes');
			}).open();
		});
		if (!confirmed) {
			NoticeManager.showNotice('Deletion cancelled');
			return;
		}

		await this.deletePublishedUid(profile, selectedNote.uid, selectedNote.label);
	}

	/**
	 * Remove one published UID from an AWS profile's site: every revision in
	 * every partition, its chat corpus object, and its entries in the local
	 * mappings, access map and content index (then re-push those). Publish
	 * history is kept. Returns true on success.
	 */
	async deletePublishedUid(profile: PublishingProfile, uid: string, label: string = uid): Promise<boolean> {
		if (profile.publishMechanism !== 'AWS' || !profile.awsSettings) {
			NoticeManager.showNotice('Delete is only supported for AWS publishing profiles');
			return false;
		}
		const selectedNote = { uid, label };
		await this.plugin.mappingManager.loadProfileMappings(profile.id);
		try {
			// Step 4: Collect all hashes to delete
			const history = await this.plugin.noteManager.loadPublishHistory(profile.id);
			const hashSet = new Set<string>();

			// Add all historical hashes
			const historyHashes = history[selectedNote.uid] || [];
			for (const h of historyHashes) {
				hashSet.add(h);
			}

			// Add current hash from uid-to-hash mapping (in case it diverges from history)
			const currentHash = this.plugin.mappingManager.getPriorHash(profile.id, selectedNote.uid);
			if (currentHash) {
				hashSet.add(currentHash);
			}

			if (hashSet.size === 0) {
				Logger.warn(`No hashes found for UID ${selectedNote.uid}, skipping S3 deletes`);
			} else {
				// Step 5: Delete from S3 (stop on permission error): the public
				// partition plus every access-group partition the note may be in
				// (deleting a missing key is a no-op).
				await this.plugin.accessManager.load(profile.id);
				const partitions = [...new Set([
					'',
					...this.plugin.accessManager.getGroups(profile.id, selectedNote.uid).map(g => restrictedPrefix(g)),
					...Object.keys(profile.accessGroups || {}).map(g => restrictedPrefix(g)),
				])];
				for (const prefix of partitions) {
					const deleteSuccess = await NoticeManager.showProgress(
						`Deleting ${hashSet.size} note version(s) from ${prefix || 'notes/'}`,
						deleteNoteHashesFromS3(this.plugin, profile.id, [...hashSet], prefix),
						`Note versions deleted from ${prefix || 'notes/'}`,
						`Failed to delete note versions from S3`
					);

					if (!deleteSuccess.success || !deleteSuccess.result) {
						// Permission error or failure — stop without modifying local files
						return false;
					}
				}
			}

			// Step 6: Update local mapping files (keep publish-history.json intact)
			this.plugin.mappingManager.removeUidFromMappings(profile.id, selectedNote.uid);
			await this.plugin.mappingManager.saveMappings();
			this.plugin.accessManager.remove(profile.id, selectedNote.uid);
			await this.plugin.accessManager.save(profile.id);

			// Step 7: Update content index
			await this.plugin.contentIndexManager.removeEntry(profile.id, selectedNote.uid);

			// Step 7b: Prune the chat corpus artifact (local + S3). Unlike the
			// content index, the per-UID kb/{uid}.md object is not orphan-removed
			// by the Step 8 re-push, so delete it explicitly.
			if (profile.chat?.enabled) {
				await this.plugin.kbCorpusManager.removeEntry(profile.id, selectedNote.uid);
				const kbDeleteSuccess = await deleteKbCorpusFromS3(this.plugin, profile.id, selectedNote.uid);
				if (!kbDeleteSuccess) {
					// Credential error — stop before re-pushing / invalidating.
					return false;
				}
			}

			// Step 8: Push updated mappings and content index to S3
			await pushMappingAndIndexToS3(this.plugin, profile.id);

			// Step 9: Trigger CloudFront invalidation
			await createCloudFrontInvalidation(this.plugin, profile.id);

			NoticeManager.showNotice(`Successfully deleted published note: ${selectedNote.label}`);
			return true;
		} catch (error) {
			Logger.error('Error deleting published note:', error);
			NoticeManager.showNotice(`Error deleting note: ${errorMessage(error)}`);
			return false;
		}
	}
}