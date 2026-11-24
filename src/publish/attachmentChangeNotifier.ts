import { Notice, TFile, type TAbstractFile } from 'obsidian';
import type CommonplaceNotesPlugin from '../main';
import { Logger } from '../utils/logging';
import { NoticeManager } from '../utils/notice';
import { busyMessage, profileLockHolder } from '../utils/publishLock';
import { extensionOf, filterAttachment } from '../utils/attachments';
import {
	AttachmentChangeWatcher,
	changeNoticeTail,
	runRepublish,
	type ChangeNotice,
	type PublishedNote,
} from '../utils/attachmentChangeNotice';

/**
 * Obsidian side of the attachment change notice (attachment spec phase 4).
 * The rules live in the pure src/utils/attachmentChangeNotice.ts; this class
 * supplies the vault, the hash cache, the publisher and the Notice.
 */
export class AttachmentChangeNotifier {
	private plugin: CommonplaceNotesPlugin;
	readonly watcher: AttachmentChangeWatcher;
	/** `${profileId}\n${vaultPath}` → the notice on screen, replaced by a newer one. */
	private notices = new Map<string, Notice>();

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
		const am = () => plugin.attachmentManager;
		this.watcher = new AttachmentChangeWatcher({
			profiles: () => plugin.settings.publishingProfiles,
			hasHashEntry: async (path) => (await am().hashCache()).has(path),
			eligible: async (profileId, path) => {
				const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
				if (!profile || !am().isActive(profile)) return false;
				const stat = await am().stat(path);
				if (!stat) return false;
				return filterAttachment({ path, ext: extensionOf(path), size: stat.size }, am().settingsFor(profile),
					p => plugin.publisher.isPathExcluded(p, profile)) === 'ok';
			},
			currentHash: async (path) => {
				const hash = await am().currentHash(path);
				// The next publish reuses the hash instead of reading the file again.
				await am().saveHashCache().catch(e => Logger.warn('Could not save the attachment hash cache:', e));
				return hash;
			},
			notify: (notice) => this.show(notice),
			warn: (message, error) => Logger.warn(message, error),
			timers: {
				set: (fn, ms) => window.setTimeout(fn, ms),
				clear: (handle) => window.clearTimeout(handle as number),
			},
		});
	}

	/** After a successful upload: the uploaded notes and the files they use. */
	recordPublished(profileId: string, notes: readonly PublishedNote[]): void {
		this.watcher.index.record(profileId, notes);
	}

	/** A note was deleted from a profile's site. */
	forgetUid(profileId: string, uid: string): void {
		this.watcher.index.forgetUid(profileId, uid);
	}

	onModify(file: TAbstractFile): void {
		if (file instanceof TFile) this.watcher.onModify(file.path);
	}

	onRename(file: TAbstractFile, oldPath: string): void {
		if (file instanceof TFile && file.extension.toLowerCase() === 'md') this.watcher.index.renameNote(oldPath, file.path);
	}

	onDelete(file: TAbstractFile): void {
		if (file instanceof TFile && file.extension.toLowerCase() === 'md') this.watcher.index.forgetNote(file.path);
	}

	unload(): void {
		this.watcher.stop();
		for (const notice of this.notices.values()) notice.hide();
		this.notices.clear();
	}

	/** "`song.mp3` changed. 3 published notes use it." with **Republish them**. */
	private show(change: ChangeNotice): void {
		const key = `${change.profileId}\n${change.vaultPath}`;
		this.notices.get(key)?.hide();
		let notice: Notice | null = null;
		const fragment = createFragment(frag => {
			const text = frag.createDiv({ cls: 'cpn-attachment-change-notice' });
			text.createEl('code', { text: change.fileName });
			text.appendText(changeNoticeTail(change.notePaths.length, change.nameProfile ? change.profileName : undefined));
			const button = frag.createDiv().createEl('button', { text: 'Republish them', cls: 'mod-cta' });
			button.addEventListener('click', (evt) => {
				// Clicking a notice closes it; the button decides for itself.
				evt.stopPropagation();
				void this.republish(change, () => {
					notice?.hide();
					if (this.notices.get(key) === notice) this.notices.delete(key);
				});
			});
		});
		notice = new Notice(fragment, 0);
		this.notices.set(key, notice);
	}

	private async republish(change: ChangeNotice, dismiss: () => void): Promise<void> {
		const profile = this.plugin.settings.publishingProfiles.find(p => p.id === change.profileId);
		if (!profile) { dismiss(); return; }
		const publisher = this.plugin.publisher;
		const outcome = await runRepublish<TFile>(change, {
			lockHolder: profileLockHolder,
			showBusy: (heldBy) => NoticeManager.showNotice(busyMessage(profile.name, heldBy)),
			resolve: async (path) => {
				const file = this.plugin.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile) || publisher.isFileExcluded(file, profile)) return null;
				return (await publisher.getPublishContextsForFile(file)).includes(profile.id) ? file : null;
			},
			publish: (files) => publisher.republishNotes(files, profile),
			dismiss,
		});
		if (outcome === 'none') {
			NoticeManager.showNotice(`None of the notes that use ${change.fileName} publish on ${profile.name} any more.`);
		}
	}
}
