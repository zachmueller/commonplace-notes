import { ItemView, WorkspaceLeaf, Notice, setIcon } from 'obsidian';
import type CommonplaceNotesPlugin from '../main';
import type { PublishingProfile } from '../types';
import { NoticeManager } from '../utils/notice';
import { buildRecentFeed, RecentFeed, RecentActivityGroup, CommentItem } from '../utils/recentComments';

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
		if (!ts) return 'Never refreshed';
		const mins = Math.floor((Date.now() - ts) / 60000);
		if (mins < 1) return 'Last refreshed just now';
		if (mins < 60) return `Last refreshed ${mins}m ago`;
		const hours = Math.floor(mins / 60);
		if (hours < 24) return `Last refreshed ${hours}h ago`;
		return `Last refreshed ${Math.floor(hours / 24)}d ago`;
	}

	private renderGroup(list: HTMLElement, group: RecentActivityGroup): void {
		const card = list.createDiv({ cls: 'cpn-recent-comments-card' });

		const title = card.createDiv({ cls: 'cpn-recent-comments-note-title' });
		title.setText(group.noteTitle ?? group.noteUid);
		if (group.localPath) {
			title.addClass('cpn-recent-comments-clickable');
			title.addEventListener('click', () => this.openLocalNote(group));
		} else {
			title.addClass('cpn-recent-comments-unresolved');
		}

		if (group.threadStale) {
			card.createDiv({ cls: 'cpn-recent-comments-stale', text: 'context updating…' });
		}

		// The recent comments (from Tier 1) for this note, newest-first.
		for (const comment of group.recent) {
			this.renderComment(card, comment, group);
		}
	}

	private renderComment(card: HTMLElement, comment: CommentItem, group: RecentActivityGroup): void {
		const el = card.createDiv({ cls: 'cpn-recent-comments-comment' });

		const meta = el.createDiv({ cls: 'cpn-recent-comments-meta' });
		meta.createSpan({ cls: 'cpn-recent-comments-author', text: comment.authorName || 'Anonymous' });
		meta.createSpan({
			cls: 'cpn-recent-comments-time',
			text: new Date(comment.createdAt * 1000).toLocaleString(),
		});

		// Body as PLAIN TEXT (v1). Bodies are attacker-influenced raw Markdown; using
		// setText escapes it. A later increment can swap in the site's hardened
		// safe-subset Markdown renderer.
		const body = el.createDiv({ cls: 'cpn-recent-comments-body' });
		if (comment.status === 'deleted' || comment.body == null) {
			body.addClass('cpn-recent-comments-deleted');
			body.setText('(comment deleted)');
		} else {
			body.setText(comment.body);
		}
	}

	/** Open the local source note for a group; notice fallback when unresolved. */
	private async openLocalNote(group: RecentActivityGroup): Promise<void> {
		if (!group.localPath) {
			NoticeManager.showNotice('Source note not found locally');
			return;
		}
		const file = this.plugin.app.vault.getFileByPath(group.localPath);
		if (!file) {
			NoticeManager.showNotice('Source note not found locally');
			return;
		}
		await this.plugin.app.workspace.getLeaf(false).openFile(file);
	}
}
