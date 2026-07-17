import { ItemView, WorkspaceLeaf, Component, MarkdownRenderer, Keymap, PaneType, TFile, setIcon } from 'obsidian';
import type CommonplaceNotesPlugin from '../main';
import type { PublishingProfile, CommentsPanelMode } from '../types';
import { NoticeManager } from '../utils/notice';
import {
	buildRecentFeed,
	getThread,
	getCachedThread,
	STALE_MS,
	RecentFeed,
	RecentActivityGroup,
	CommentItem,
} from '../utils/recentComments';
import { rewriteCommentWikilinks } from '../utils/commentWikilinks';

export const RECENT_COMMENTS_VIEW = 'cpn-recent-comments';

/**
 * Author-facing comments side panel. Two modes (persisted): "Recent" shows the
 * site-wide recency feed; "Active note" shows the active editor note's thread.
 * Read-only. Refresh is manual (button) plus, in Recent mode only, an
 * opportunistic >=8h-stale refresh on panel activation — never an idle timer
 * (DynamoDB cost governance). Active-note mode never auto-fetches; it renders
 * from the plugin-wide shared thread cache and pulls only on manual Refresh.
 */
export class RecentCommentsView extends ItemView {
	private plugin: CommonplaceNotesPlugin;
	private feed: RecentFeed | null = null;
	private activeProfileId: string | null = null;
	private isRefreshing = false;
	// Persisted view mode; seeded from settings in onOpen.
	private mode: CommentsPanelMode = 'recent';
	// Active-note mode: which publish context's export to show. Session-only and
	// independent of activeProfileId (which drives Recent) so note navigation
	// never clobbers the Recent profile selection.
	private activeNoteContextId: string | null = null;
	// Active-note mode: path of the note last rendered, so the active-leaf-change
	// follower can skip re-renders that aren't an actual note change (e.g. focusing
	// the panel itself).
	private activeNotePath: string | null = null;
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
	getDisplayText(): string { return 'Comments'; }
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
		this.mode = this.plugin.settings.commentsPanelMode ?? 'recent';
		const profile = this.currentProfile();
		if (profile) this.activeProfileId = profile.id;
		this.render();

		// Opportunistic auto-refresh: Recent mode only, and only when the active
		// profile's feed is stale. Active-note mode never auto-fetches.
		if (this.mode === 'recent' && profile) {
			const stale = Date.now() - (profile.commentsLastRefreshed ?? 0) > STALE_MS;
			if (stale) await this.refresh();
		}

		// Follow the editor in active-note mode: re-render (never fetch) when the
		// user navigates to a different note, so an already-cached note swaps in
		// instantly and an uncached one falls to the refresh prompt. registerEvent
		// auto-unregisters on view close.
		this.registerEvent(
			this.plugin.app.workspace.on('active-leaf-change', () => {
				if (this.mode !== 'active-note') return;
				const path = this.plugin.app.workspace.getActiveFile()?.path ?? null;
				// Skip focusing the panel itself (same path) and null (no file-backed
				// leaf) — the latter keeps the last thread visible rather than blanking.
				if (path === null || path === this.activeNotePath) return;
				this.render();
			}),
		);
	}

	async onClose(): Promise<void> {
		// Nothing to tear down — the view holds no timers (deliberately unlike the
		// URL-stack countdown). The DynamoDB client is owned/disposed by AwsSdkManager.
	}

	/**
	 * Public entry point for the layout-ready stale check in main.ts: refresh
	 * only if the active profile's feed is >=8h stale. Safe to call repeatedly.
	 * Recent mode only — active-note mode never auto-fetches (a panel restored in
	 * active-note mode must not spend a DynamoDB query at startup).
	 */
	async refreshIfStale(): Promise<void> {
		if (this.mode !== 'recent') return;
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

	/**
	 * Switch panel mode and persist it. Re-renders, then runs the stale check —
	 * self-gating, so entering Recent behaves like opening it (a >=8h-stale feed
	 * refreshes) while entering Active-note fetches nothing.
	 */
	private async setMode(mode: CommentsPanelMode): Promise<void> {
		this.mode = mode;
		this.plugin.settings.commentsPanelMode = mode;
		await this.plugin.saveSettings();
		this.render();
		await this.refreshIfStale();
	}

	/** Manual refresh for active-note mode: a single CDN GET, no DynamoDB. */
	async refreshActiveNote(): Promise<void> {
		if (this.isRefreshing) return;
		const file = this.plugin.app.workspace.getActiveFile();
		if (!file) return;
		const contexts = this.activeNoteContexts(file);
		if (contexts.length === 0) return;
		const profile = this.currentNoteContext(contexts);
		// Pure read — NOT getNoteUID, which mints/queues a cpn-uid as a side effect.
		const noteUid = this.plugin.frontmatterManager.getFrontmatterValue(file, 'cpn-uid') as string | undefined;
		if (!noteUid) return;

		this.isRefreshing = true;
		this.render(); // reflect the refreshing state in the header
		// getThread writes the plugin-wide shared cache (reused by Recent mode too);
		// force bypasses the freshness window. On a network error it throws (cache
		// untouched) and showProgress reports the failure, so the refresh prompt
		// lets the user retry rather than caching a transient failure as "no comments".
		await NoticeManager.showProgress(
			'Loading comments for this note',
			getThread(this.plugin, profile, noteUid, { force: true }),
			'Comments updated',
			'Failed to load comments',
		);
		this.isRefreshing = false;
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

		if (this.mode === 'active-note') {
			this.renderActiveNote(container);
			return;
		}

		if (!this.feed || this.feed.groups.length === 0) {
			const empty = container.createDiv({ cls: 'cpn-recent-comments-empty' });
			empty.setText(this.feed ? 'No recent comments.' : 'Refresh to load recent comments.');
			return;
		}

		const list = container.createDiv({ cls: 'cpn-recent-comments-list' });
		for (const group of this.feed.groups) this.renderGroup(list, group);
	}

	/**
	 * Active-note render branch: show the active editor note's cached thread, or
	 * the appropriate empty state. Never fetches — the shared cache is populated
	 * only by the manual Refresh button (refreshActiveNote) or a Recent refresh.
	 */
	private renderActiveNote(container: HTMLElement): void {
		const file = this.plugin.app.workspace.getActiveFile();
		this.activeNotePath = file?.path ?? null;

		const empty = (text: string) =>
			container.createDiv({ cls: 'cpn-recent-comments-empty' }).setText(text);

		if (!file) return empty('Open a note to see its comments.');
		const contexts = this.activeNoteContexts(file);
		if (contexts.length === 0) {
			return empty("This note isn't published to a commenting-enabled site.");
		}
		const profile = this.currentNoteContext(contexts);
		// Pure read — NOT getNoteUID, which mints/queues a cpn-uid as a side effect.
		const noteUid = this.plugin.frontmatterManager.getFrontmatterValue(file, 'cpn-uid') as string | undefined;
		if (!noteUid) return empty('Publish this note first to load its comments.');

		const cached = getCachedThread(this.plugin, profile.id, noteUid);
		if (!cached) return empty('Refresh to load comments for this note.');
		if (cached.items.length === 0) return empty('No comments yet.');

		const list = container.createDiv({ cls: 'cpn-recent-comments-list' });
		this.renderGroup(list, {
			noteUid,
			noteTitle: this.plugin.frontmatterManager.getNoteTitle(file),
			localPath: file.path,
			recent: [],
			thread: cached.items,
			recentUids: new Set<string>(), // no "new" highlight in active-note mode
		});
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

		// (1) Mode toggle — always shown.
		const modes = header.createDiv({ cls: 'cpn-recent-comments-modes' });
		const mkModeBtn = (label: string, m: CommentsPanelMode) => {
			const btn = modes.createEl('button', { cls: 'cpn-recent-comments-mode-btn', text: label });
			if (this.mode === m) btn.addClass('is-active');
			btn.addEventListener('click', () => { if (this.mode !== m) void this.setMode(m); });
		};
		mkModeBtn('Recent', 'recent');
		mkModeBtn('Active note', 'active-note');

		// (2) Mode-specific selector.
		if (this.mode === 'recent') {
			// Profile selector (skipped when there's only one commenting profile).
			if (profiles.length > 1) {
				const select = header.createEl('select', { cls: 'cpn-recent-comments-profile' });
				for (const p of profiles) {
					const opt = select.createEl('option', { text: p.name, value: p.id });
					if (p.id === this.activeProfileId) opt.selected = true;
				}
				select.addEventListener('change', () => {
					void (async () => {
						this.activeProfileId = select.value;
						this.feed = null; // feed is per-profile; drop the old one
						this.render();
						await this.refreshIfStale();
					})();
				});
			}
		} else {
			// Publish-context selector: only the commenting contexts the active note
			// is actually published to. Skipped when there's 0 or 1.
			const file = this.plugin.app.workspace.getActiveFile();
			const contexts = this.activeNoteContexts(file);
			if (contexts.length > 1) {
				const current = this.currentNoteContext(contexts);
				const select = header.createEl('select', { cls: 'cpn-recent-comments-context' });
				for (const p of contexts) {
					const opt = select.createEl('option', { text: p.name, value: p.id });
					if (p.id === current.id) opt.selected = true; // reflect the resolved context
				}
				select.addEventListener('change', () => {
					// Switching context shows that context's cache/prompt — never fetches.
					this.activeNoteContextId = select.value;
					this.render();
				});
			}
		}

		// (3) Refresh button — dispatches on mode.
		const refreshBtn = header.createEl('button', { cls: 'cpn-recent-comments-refresh' });
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.createSpan({ text: this.isRefreshing ? ' Refreshing…' : ' Refresh' });
		refreshBtn.disabled = this.isRefreshing;
		refreshBtn.addEventListener('click', () => {
			void (this.mode === 'recent' ? this.refresh() : this.refreshActiveNote());
		});

		// (4) Freshness label — per-source, per-mode.
		const label = header.createDiv({ cls: 'cpn-recent-comments-lastrefreshed' });
		label.setText(this.mode === 'recent'
			? this.lastRefreshedLabel(this.currentProfile())
			: this.activeNoteLoadedLabel());
	}

	private lastRefreshedLabel(profile: PublishingProfile | null): string {
		const ts = profile?.commentsLastRefreshed;
		// Absolute timestamp: correct permanently, so it's set once at render with
		// no interval to keep a relative "N ago" label current.
		if (!ts) return 'Never refreshed';
		return `Last refreshed ${new Date(ts).toLocaleString()}`;
	}

	/** Freshness label for active-note mode: when this note's thread was loaded. */
	private activeNoteLoadedLabel(): string {
		const file = this.plugin.app.workspace.getActiveFile();
		if (!file) return '';
		const contexts = this.activeNoteContexts(file);
		if (contexts.length === 0) return '';
		const profile = this.currentNoteContext(contexts);
		const noteUid = this.plugin.frontmatterManager.getFrontmatterValue(file, 'cpn-uid') as string | undefined;
		if (!noteUid) return '';
		const cached = getCachedThread(this.plugin, profile.id, noteUid);
		if (!cached) return 'Not loaded';
		return `Loaded ${new Date(cached.fetchedAt).toLocaleString()}`;
	}

	/**
	 * Commenting-enabled publish contexts the active note actually belongs to:
	 * commentingProfiles() ∩ the note's cpn-publish-contexts. Uses the sync,
	 * side-effect-free normalizePublishContexts (never getNoteUID).
	 */
	private activeNoteContexts(file: TFile | null): PublishingProfile[] {
		if (!file) return [];
		const ctx = this.plugin.frontmatterManager.normalizePublishContexts(file);
		return this.commentingProfiles().filter((p) => ctx.includes(p.id));
	}

	/** The selected active-note context, falling back to the first available. */
	private currentNoteContext(contexts: PublishingProfile[]): PublishingProfile {
		return contexts.find((p) => p.id === this.activeNoteContextId) ?? contexts[0];
	}

	private renderGroup(list: HTMLElement, group: RecentActivityGroup): void {
		const card = list.createDiv({ cls: 'cpn-recent-comments-card' });

		const title = card.createDiv({ cls: 'cpn-recent-comments-note-title' });
		title.setText(group.noteTitle ?? group.noteUid);
		if (group.localPath) {
			title.addClass('cpn-recent-comments-clickable');
			// Plain click → active pane; Cmd/Ctrl+click → new tab (Keymap.isModEvent
			// returns a PaneType|boolean suited for getLeaf); middle-click → new tab.
			title.addEventListener('click', (evt) => {
				void this.openLocalNote(group, Keymap.isModEvent(evt));
			});
			title.addEventListener('auxclick', (evt) => {
				if (evt.button === 1) {
					evt.preventDefault();
					void this.openLocalNote(group, 'tab');
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
			const uid = this.plugin.frontmatterManager.getFrontmatterValue(f, 'cpn-uid') as string | undefined;
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
