import { ItemView, WorkspaceLeaf, Component, MarkdownRenderer, Keymap, PaneType, TFile, setIcon } from 'obsidian';
import type CommonplaceNotesPlugin from '../main';
import type { PublishingProfile } from '../types';
import { NoticeManager } from '../utils/notice';
import { buildRecentFeed, RecentFeed, RecentActivityGroup, CommentItem } from '../utils/recentComments';
import { rewriteCommentWikilinks } from '../utils/commentWikilinks';

export const RECENT_COMMENTS_VIEW = 'cpn-recent-comments';

/** Auto-refresh threshold on panel open: only re-query if the feed is older than this. */
const STALE_MS = 8 * 60 * 60 * 1000; // 8h

/**
 * Author-facing side panel showing recent reader comments across a published
 * site. Read-only. Refresh is manual (button) plus an opportunistic >=8h-stale
 * refresh on panel activation — never an idle timer (DynamoDB cost governance).
 */
export class RecentCommentsView extends ItemView {
	private plugin: CommonplaceNotesPlugin;
	private feed: RecentFeed | null = null;
	private activeProfileId: string | null = null;
	private isRefreshing = false;
	// Owns the lifecycle of event handlers created while rendering comment
	// Markdown; replaced on each render so handlers don't accumulate.
	private feedComponent: Component | null = null;
	// UID → local note file, rebuilt once per render() so [[UID]] comment links
	// resolve to the note's current title + a working internal link.
	private uidToFile: Map<string, TFile> = new Map();

	constructor(leaf: WorkspaceLeaf, plugin: CommonplaceNotesPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return RECENT_COMMENTS_VIEW; }
	getDisplayText(): string { return 'Recent comments'; }
	getIcon(): string { return 'message-square'; }

	/** Profiles that have commenting enabled and a deployed comment table. */
	private commentingProfiles(): PublishingProfile[] {
		return this.plugin.settings.publishingProfiles.filter(
			(p) => p.commenting?.enabled && p.infrastructureState?.comment?.tableName,
		);
	}

	private currentProfile(): PublishingProfile | null {
		const profiles = this.commentingProfiles();
		if (profiles.length === 0) return null;
		const match = profiles.find((p) => p.id === this.activeProfileId);
		return match ?? profiles[0];
	}

	async onOpen(): Promise<void> {
		const profile = this.currentProfile();
		if (profile) this.activeProfileId = profile.id;
		this.render();

		// Opportunistic auto-refresh: only when the active profile's feed is stale.
		if (profile) {
			const stale = Date.now() - (profile.commentsLastRefreshed ?? 0) > STALE_MS;
			if (stale) await this.refresh();
		}
	}

	async onClose(): Promise<void> {
		// Nothing to tear down — the view holds no timers (deliberately unlike the
		// URL-stack countdown). The DynamoDB client is owned/disposed by AwsSdkManager.
	}

	/**
	 * Public entry point for the layout-ready stale check in main.ts: refresh
	 * only if the active profile's feed is >=8h stale. Safe to call repeatedly.
	 */
	async refreshIfStale(): Promise<void> {
		const profile = this.currentProfile();
		if (!profile) return;
		if (Date.now() - (profile.commentsLastRefreshed ?? 0) > STALE_MS) {
			await this.refresh();
		}
	}

	/** Manual/unconditional refresh: Tier 1 query + Tier 2 enrichment. */
	async refresh(): Promise<void> {
		const profile = this.currentProfile();
		if (!profile || this.isRefreshing) return;

		this.isRefreshing = true;
		this.render(); // reflect the refreshing state in the header
		const { success, result } = await NoticeManager.showProgress(
			'Loading recent comments',
			buildRecentFeed(this.plugin, profile),
			'Recent comments updated',
			'Failed to load recent comments',
		);
		this.isRefreshing = false;

		if (success && result) {
			this.feed = result;
			profile.commentsLastRefreshed = Date.now();
			await this.plugin.saveSettings();
		}
		this.render();
	}

	// ---- Rendering --------------------------------------------------------

	private render(): void {
		const container = this.contentEl;
		container.empty();
		container.addClass('cpn-recent-comments');

		// Reset the child component that owns rendered-Markdown handlers, so they
		// don't accumulate across re-renders. addChild auto-unloads on view close.
		if (this.feedComponent) this.removeChild(this.feedComponent);
		this.feedComponent = new Component();
		this.addChild(this.feedComponent);

		// Rebuild the UID → file map once per render (fresh each time; used to
		// resolve [[UID]] links in comment bodies). One vault scan per render pass
		// beats a scan per link token.
		this.uidToFile = this.buildUidToFileMap();

		const profiles = this.commentingProfiles();
		if (profiles.length === 0) {
			this.renderEmptyState(container);
			return;
		}

		this.renderChrome(container, profiles);

		if (!this.feed || this.feed.groups.length === 0) {
			const empty = container.createDiv({ cls: 'cpn-recent-comments-empty' });
			empty.setText(this.feed ? 'No recent comments.' : 'Refresh to load recent comments.');
			return;
		}

		const list = container.createDiv({ cls: 'cpn-recent-comments-list' });
		for (const group of this.feed.groups) this.renderGroup(list, group);
	}

	private renderEmptyState(container: HTMLElement): void {
		const empty = container.createDiv({ cls: 'cpn-recent-comments-empty' });
		empty.createEl('p', {
			text: 'No commenting-enabled site found. Deploy commenting for a publishing '
				+ 'profile to see recent reader comments here.',
		});
	}

	private renderChrome(container: HTMLElement, profiles: PublishingProfile[]): void {
		const header = container.createDiv({ cls: 'cpn-recent-comments-header' });

		// Profile selector (skipped when there's only one commenting profile).
		if (profiles.length > 1) {
			const select = header.createEl('select', { cls: 'cpn-recent-comments-profile' });
			for (const p of profiles) {
				const opt = select.createEl('option', { text: p.name, value: p.id });
				if (p.id === this.activeProfileId) opt.selected = true;
			}
			select.addEventListener('change', async () => {
				this.activeProfileId = select.value;
				this.feed = null; // feed is per-profile; drop the old one
				this.render();
				await this.refreshIfStale();
			});
		}

		const refreshBtn = header.createEl('button', { cls: 'cpn-recent-comments-refresh' });
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.createSpan({ text: this.isRefreshing ? ' Refreshing…' : ' Refresh' });
		refreshBtn.disabled = this.isRefreshing;
		refreshBtn.addEventListener('click', () => this.refresh());

		const profile = this.currentProfile();
		const label = header.createDiv({ cls: 'cpn-recent-comments-lastrefreshed' });
		label.setText(this.lastRefreshedLabel(profile));
	}

	private lastRefreshedLabel(profile: PublishingProfile | null): string {
		const ts = profile?.commentsLastRefreshed;
		// Absolute timestamp: correct permanently, so it's set once at render with
		// no interval to keep a relative "N ago" label current.
		if (!ts) return 'Never refreshed';
		return `Last refreshed ${new Date(ts).toLocaleString()}`;
	}

	private renderGroup(list: HTMLElement, group: RecentActivityGroup): void {
		const card = list.createDiv({ cls: 'cpn-recent-comments-card' });

		const title = card.createDiv({ cls: 'cpn-recent-comments-note-title' });
		title.setText(group.noteTitle ?? group.noteUid);
		if (group.localPath) {
			title.addClass('cpn-recent-comments-clickable');
			// Plain click → active pane; Cmd/Ctrl+click → new tab (Keymap.isModEvent
			// returns a PaneType|boolean suited for getLeaf); middle-click → new tab.
			title.addEventListener('click', (evt) => this.openLocalNote(group, Keymap.isModEvent(evt)));
			title.addEventListener('auxclick', (evt) => {
				if (evt.button === 1) {
					evt.preventDefault();
					this.openLocalNote(group, 'tab');
				}
			});
		} else {
			title.addClass('cpn-recent-comments-unresolved');
		}

		// Render the full thread with one-level nesting (mirrors the published
		// site's buildThread/renderThreadInto): roots in chronological order, each
		// reply nested one level under its root. Replies never nest further.
		const byParent = new Map<string, CommentItem[]>();
		for (const c of group.thread) {
			const key = c.parentCommentUid || '__root__';
			if (!byParent.has(key)) byParent.set(key, []);
			byParent.get(key)!.push(c);
		}

		const roots = byParent.get('__root__') ?? [];
		for (const root of roots) {
			const replies = byParent.get(root.commentUid) ?? [];
			// A deleted root with no replies is dropped; kept as a tombstone only
			// when replies still hang off it (preserves threading context).
			if (root.status === 'deleted' && replies.length === 0) continue;

			this.renderComment(card, root, group);
			if (replies.length > 0) {
				const repliesEl = card.createDiv({ cls: 'cpn-recent-comments-replies' });
				for (const reply of replies) this.renderComment(repliesEl, reply, group);
			}
		}
	}

	private renderComment(card: HTMLElement, comment: CommentItem, group: RecentActivityGroup): void {
		const el = card.createDiv({ cls: 'cpn-recent-comments-comment' });
		// Highlight newly-arrived comments within the full thread.
		if (group.recentUids.has(comment.commentUid)) el.addClass('cpn-recent-comments-new');

		const meta = el.createDiv({ cls: 'cpn-recent-comments-meta' });
		meta.createSpan({ cls: 'cpn-recent-comments-author', text: comment.authorName || 'Anonymous' });
		meta.createSpan({
			cls: 'cpn-recent-comments-time',
			text: new Date(comment.createdAt * 1000).toLocaleString(),
		});

		const body = el.createDiv({ cls: 'cpn-recent-comments-body' });
		if (comment.status === 'deleted' || comment.body == null) {
			body.addClass('cpn-recent-comments-deleted');
			body.setText('(comment deleted)');
			return;
		}

		// Bodies are Markdown; render via Obsidian's native renderer (matches
		// formatting.ts). The feedComponent owns any handlers the render creates.
		// Fall back to plain text on error.
		//
		// First rewrite [[UID]] note-links: a resolvable UID becomes
		// [[<linktext>|<Title>]] so it displays the note's current title and, once
		// rendered, is a working internal link that opens the right note (Obsidian's
		// own internal-link handling — no custom click wiring). Unresolvable UIDs
		// degrade to plain UID text.
		const md = rewriteCommentWikilinks(comment.body, (uid) => {
			const file = this.uidToFile.get(uid);
			if (!file) return null;
			return {
				linktext: this.plugin.app.metadataCache.fileToLinktext(file, group.localPath ?? '', true),
				title: this.plugin.frontmatterManager.getNoteTitle(file),
			};
		});
		try {
			void MarkdownRenderer.render(this.plugin.app, md, body, group.localPath ?? '', this.feedComponent!);
		} catch {
			body.setText(md);
		}
	}

	/** Scan the vault once for cpn-uid → file (first file wins on duplicate UID). */
	private buildUidToFileMap(): Map<string, TFile> {
		const map = new Map<string, TFile>();
		for (const f of this.plugin.app.vault.getMarkdownFiles()) {
			// Pure metadataCache read — NOT getNoteUID, which mints/queues a UID as
			// a side effect (see resolveLocalNote in recentComments.ts).
			const uid = this.plugin.frontmatterManager.getFrontmatterValue(f, 'cpn-uid');
			if (uid && !map.has(uid)) map.set(uid, f);
		}
		return map;
	}

	/** Open the local source note for a group; notice fallback when unresolved. */
	private async openLocalNote(group: RecentActivityGroup, newLeaf: PaneType | boolean = false): Promise<void> {
		if (!group.localPath) {
			NoticeManager.showNotice('Source note not found locally');
			return;
		}
		const file = this.plugin.app.vault.getFileByPath(group.localPath);
		if (!file) {
			NoticeManager.showNotice('Source note not found locally');
			return;
		}
		await this.plugin.app.workspace.getLeaf(newLeaf).openFile(file);
	}
}
