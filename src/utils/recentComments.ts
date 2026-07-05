import { TFile, requestUrl } from 'obsidian';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type CommonplaceNotesPlugin from '../main';
import type { PublishingProfile } from '../types';
import { refreshCredentials } from '../publish/awsCredentials';
import { Logger } from './logging';

/**
 * Recent Comments panel data layer (author-facing Phase 2). Two-tier sourcing:
 *
 *   Tier 1 — "what's new" (paid, rare): a single DynamoDB Query on the recency
 *     GSI (GSI1PK='ACTIVITY', newest-first) returns the newest-N comments
 *     site-wide. Incurred only on manual refresh or an >=8h-stale panel open.
 *   Tier 2 — "full context" (CDN-cached, ~free): for each distinct note in the
 *     Tier 1 result, GET the already-exported /comments/{uid}.json so each
 *     recent comment renders within its note's complete thread (replies nested
 *     one level under their root — matching the published site).
 *
 * See the "Recent comments activity side panel" idea note.
 */

/** Index name + partition value must match infrastructure/lib/comment-stack.ts. */
const ACTIVITY_INDEX = 'GSI1';
const ACTIVITY_PK = 'ACTIVITY';
const DEFAULT_FEED_LIMIT = 25;

/** AWS error names that mean "credentials are stale/invalid" — trigger a refresh + retry. */
const AUTH_ERR = /Expired|UnrecognizedClient|AccessDenied|CredentialsProviderError|InvalidSignature/i;

/**
 * One comment as stored in DynamoDB and mirrored in the exported per-note JSON
 * (Phase 1 schema; see comment-write.js / comment-reexport.js buildView). Bodies
 * are raw Markdown; a deleted comment is a tombstone with `body: null`.
 */
export interface CommentItem {
	commentUid: string;
	noteUid: string;
	noteHash?: string;
	parentCommentUid?: string | null;
	authorId?: string;   // present on the GSI item; not rendered (we show authorName)
	authorName?: string; // denormalized display name
	body: string | null; // null when status === 'deleted'
	createdAt: number;   // unix seconds
	updatedAt?: number;
	status: 'active' | 'deleted';
	quote?: { text: string; lineStart?: number; lineEnd?: number } | null;
}

/** One note's recent activity plus its full thread for context. */
export interface RecentActivityGroup {
	noteUid: string;
	noteTitle?: string;         // resolved locally if the note is in the vault
	localPath?: string;         // vault path if resolvable (for click-to-open)
	recent: CommentItem[];      // this note's comments that appeared in the feed (newest-first)
	thread: CommentItem[];      // full note thread (chronological) for one-level nesting
	recentUids: Set<string>;    // commentUids that are newly-arrived (for highlighting)
}

export interface RecentFeed {
	groups: RecentActivityGroup[]; // ordered by newest recent comment first
	fetchedAt: number;             // epoch ms
}

/** Shape of the exported /comments/{uid}.json envelope. */
interface CommentExport {
	version: number;
	comments: CommentItem[];
}

/**
 * Tier 1: query the recency GSI for the newest-N comments site-wide. On an
 * auth error, refresh the profile's credentials once (which invalidates the
 * cached DynamoDB client) and retry.
 */
async function queryRecent(
	plugin: CommonplaceNotesPlugin,
	profile: PublishingProfile,
	limit: number,
): Promise<CommentItem[]> {
	const tableName = profile.infrastructureState?.comment?.tableName;
	if (!tableName) throw new Error('Commenting is not deployed for this profile');

	const run = async (): Promise<CommentItem[]> => {
		const doc = plugin.awsSdkManager.getDynamoDBClient(profile);
		const res = await doc.send(new QueryCommand({
			TableName: tableName,
			IndexName: ACTIVITY_INDEX,
			KeyConditionExpression: 'GSI1PK = :a',
			ExpressionAttributeValues: { ':a': ACTIVITY_PK },
			ScanIndexForward: false, // newest first
			Limit: limit,
		}));
		return (res.Items ?? []) as CommentItem[];
	};

	try {
		return await run();
	} catch (e: any) {
		if (AUTH_ERR.test(e?.name ?? '')) {
			Logger.debug('Recent comments query hit an auth error; refreshing credentials and retrying once');
			await refreshCredentials(plugin, profile.id); // invalidates the cached DDB client
			return run();                                  // getDynamoDBClient rebuilds with fresh creds
		}
		throw e;
	}
}

/**
 * Tier 2: fetch a note's exported thread from the CDN. Uses Obsidian's
 * `requestUrl` (not `fetch`) to avoid a CORS preflight against the CloudFront
 * origin. 403/404 both mean "no export yet" (S3 OAC returns 403 for a missing
 * object) — treated as "no thread available", not an error. Exported comments
 * are already chronologically sorted and carry `parentCommentUid`.
 */
async function fetchThread(profile: PublishingProfile, noteUid: string): Promise<CommentItem[] | null> {
	const base = profile.baseUrl.replace(/\/?$/, '/');
	const url = `${base}comments/${encodeURIComponent(noteUid)}.json`;
	try {
		const r = await requestUrl({ url, throw: false });
		if (r.status >= 400) return null; // 403/404 = no export yet; other errors = no thread
		const json = r.json as CommentExport | CommentItem[] | undefined;
		if (!json) return null;
		return Array.isArray(json) ? json : (json.comments ?? null);
	} catch (e) {
		Logger.debug(`Failed to fetch thread for ${noteUid}:`, e);
		return null;
	}
}

/** Read-only reverse lookup: comment noteUid -> local vault file (if published here). */
function resolveLocalNote(plugin: CommonplaceNotesPlugin, noteUid: string): TFile | null {
	// Pure metadataCache read — do NOT use FrontmatterManager.getNoteUID, which
	// mints/queues a cpn-uid as a side effect for notes with publish contexts.
	return plugin.app.vault.getMarkdownFiles().find(
		(f) => plugin.frontmatterManager.getFrontmatterValue(f, 'cpn-uid') === noteUid,
	) ?? null;
}

/**
 * Merge any recent items missing from the exported thread (export lag) so a
 * just-posted comment/reply is never dropped while the export catches up.
 * Returns a chronologically-sorted thread.
 */
function mergeThread(thread: CommentItem[], recent: CommentItem[]): CommentItem[] {
	const byUid = new Map<string, CommentItem>();
	for (const c of thread) byUid.set(c.commentUid, c);
	for (const c of recent) if (!byUid.has(c.commentUid)) byUid.set(c.commentUid, c);
	return [...byUid.values()].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Build the recent-activity feed: query the recency GSI for the newest-N
 * comments site-wide, group by note (newest-first order preserved), fetch each
 * distinct note's full exported thread for one-level reply nesting, and resolve
 * each note's local source file for click-to-open.
 */
export async function buildRecentFeed(
	plugin: CommonplaceNotesPlugin,
	profile: PublishingProfile,
	limit: number = profile.commentsFeedLimit ?? DEFAULT_FEED_LIMIT,
): Promise<RecentFeed> {
	const recent = await queryRecent(plugin, profile, limit);

	// Group by noteUid, preserving newest-first first-appearance order.
	const order: string[] = [];
	const byNote = new Map<string, CommentItem[]>();
	for (const item of recent) {
		if (!byNote.has(item.noteUid)) {
			byNote.set(item.noteUid, []);
			order.push(item.noteUid);
		}
		byNote.get(item.noteUid)!.push(item);
	}

	// Tier 2: fetch each distinct note's thread in parallel (bounded by `limit`).
	const threads = await Promise.all(
		order.map(async (noteUid) => ({ noteUid, thread: await fetchThread(profile, noteUid) })),
	);
	const threadByNote = new Map(threads.map((t) => [t.noteUid, t.thread]));

	const groups: RecentActivityGroup[] = order.map((noteUid) => {
		const recentForNote = byNote.get(noteUid)!;
		// Fall back to the recent items when the export lags/404s so brand-new
		// comments still show (just without older context).
		const fetched = threadByNote.get(noteUid) ?? [];
		const thread = mergeThread(fetched, recentForNote);
		const file = resolveLocalNote(plugin, noteUid);
		return {
			noteUid,
			noteTitle: file
				? (plugin.frontmatterManager.getFrontmatterValue(file, 'cpn-title') ?? file.basename)
				: undefined,
			localPath: file?.path,
			recent: recentForNote,
			thread,
			recentUids: new Set(recentForNote.map((c) => c.commentUid)),
		};
	});

	return { groups, fetchedAt: Date.now() };
}
