/**
 * Pure helpers for per-note access groups (`cpn-access-groups` frontmatter).
 *
 * No Obsidian imports, so the rules can be unit-tested directly
 * (e2e/scripts/test-access-partition.ts).
 *
 * Model:
 *   - A note with no groups publishes to the PUBLIC partition (`notes/`, the
 *     site-wide mappings, search, chat). It inherits the site-wide read gate.
 *   - A note with groups [a, b] publishes ONLY to the `restricted/a/` and
 *     `restricted/b/` partitions (OR semantics: any listed group grants access).
 *     It never appears in any public aggregate file.
 *   - The edge function enforces `/restricted/<group>/*` by the token's
 *     `cognito:groups` claim (infrastructure/assets/lambda/auth-edge.js).
 */
import type { PublishingProfile } from '../types';

/** Frontmatter key holding a note's access groups (YAML list of names). */
export const ACCESS_GROUPS_KEY = 'cpn-access-groups';

/** Valid group name. Must match GROUP_NAME_RE in auth-edge.js. */
export const GROUP_NAME_RE = /^[a-z0-9-]{1,40}$/;

/** S3 key prefix (under the profile's s3Prefix) of a group's partition. */
export function restrictedPrefix(group: string): string {
	return `restricted/${group}/`;
}

/** Site path the SPA calls to learn the viewer's groups. */
export const WHOAMI_PATH = '/restricted/whoami';

/** A partition is a group name, or `null` for the public partition. */
export type Partition = string | null;

export interface NormalizedGroups {
	/** Valid, lowercased, de-duplicated, sorted group names. */
	groups: string[];
	/** Raw entries that are not valid group names (as written). */
	invalid: string[];
	/** True when the frontmatter value wasn't a list (a bare string is accepted). */
	notAList: boolean;
}

/**
 * Normalize a raw frontmatter value. Accepts a YAML list (preferred) or a single
 * string; anything else is treated as "no groups" but flagged.
 */
export function normalizeGroupList(raw: unknown): NormalizedGroups {
	if (raw === null || raw === undefined || raw === '') {
		return { groups: [], invalid: [], notAList: false };
	}
	let items: unknown[];
	let notAList = false;
	if (Array.isArray(raw)) {
		items = raw;
	} else if (typeof raw === 'string') {
		items = [raw];
		notAList = true;
	} else {
		return { groups: [], invalid: [String(raw)], notAList: true };
	}
	const groups = new Set<string>();
	const invalid: string[] = [];
	for (const item of items) {
		if (item === null || item === undefined) continue;
		const name = String(item).trim().toLowerCase();
		if (!name) continue;
		if (GROUP_NAME_RE.test(name)) groups.add(name);
		else invalid.push(String(item));
	}
	return { groups: [...groups].sort(), invalid, notAList };
}

/** Normalize a group name typed in settings; null if it can't be made valid. */
export function normalizeGroupName(name: string): string | null {
	const n = name.trim().toLowerCase().replace(/\s+/g, '-');
	return GROUP_NAME_RE.test(n) ? n : null;
}

/** Normalize a members list (emails): trim, lowercase, de-duplicate, sort. */
export function normalizeMembers(members: string[]): string[] {
	const out = new Set<string>();
	for (const m of members) {
		const e = m.trim().toLowerCase();
		if (e) out.add(e);
	}
	return [...out].sort();
}

/** Loose email check for settings validation (membership is matched exactly). */
export function looksLikeEmail(s: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** The partitions a note with `groups` publishes to. */
export function partitionsFor(groups: string[]): Partition[] {
	return groups.length > 0 ? [...groups] : [null];
}

/** Partitions in `from` that are not in `to` (where old copies must be deleted). */
export function removedPartitions(from: Partition[], to: Partition[]): Partition[] {
	const keep = new Set(to.map((p) => p ?? ''));
	return from.filter((p) => !keep.has(p ?? ''));
}

/**
 * Whether a note with `targetGroups` may be shown (as a link or backlink) in a
 * copy published to `partition`: public notes are visible everywhere; a gated
 * note only inside a partition of one of its own groups.
 */
export function visibleInPartition(partition: Partition, targetGroups: string[]): boolean {
	if (targetGroups.length === 0) return true;
	return partition !== null && targetGroups.includes(partition);
}

/**
 * Whether a link from a note with `sourceGroups` to a note with `targetGroups`
 * may be resolved in the source's rendered HTML. The HTML is shared by every
 * partition copy of the source, so the target must be visible in ALL of them.
 */
export function linkVisibleFrom(sourceGroups: string[], targetGroups: string[]): boolean {
	return partitionsFor(sourceGroups).every((p) => visibleInPartition(p, targetGroups));
}

export type GatedPublishCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether this profile can publish gated notes at all. Gated notes need an edge
 * function that enforces `/restricted/<group>/*`:
 *   - `cognito`: the built-in whole-site gate, on the upgraded separate edge
 *     stack with the membership trigger;
 *   - `none`: a public site that opted in (`publicSiteAccessGroups`) and runs the
 *     same edge fn in public-reads mode (only restricted paths need sign-in);
 *   - `byo`: a custom edge function the author has explicitly vouched for.
 * Every other state fails closed.
 */
export function canPublishGated(profile: PublishingProfile): GatedPublishCheck {
	if (profile.publishMechanism !== 'AWS') {
		return { ok: false, reason: 'access groups require the AWS publish mechanism' };
	}
	const state = profile.infrastructureState;
	const mode = state?.readGateMode ?? 'none';
	const c = state?.cognitoAuth;
	// The site must actually run the group-aware edge fn. A hand-set ARN (via
	// "Auth Lambda@Edge → Update") could be anything, so fail closed.
	const runsCurrentEdge = !!state?.authLambdaEdgeArn && state.authLambdaEdgeArn === c?.edgeFunctionVersionArn;
	if (mode === 'cognito') {
		if (!c?.edgeStackName || !c.accessGroupsKey) {
			return { ok: false, reason: 'the Cognito gate needs the one-time upgrade (Settings → Infrastructure → Upgrade Cognito gate)' };
		}
		if (c.edgePublicReads) {
			// A public-reads build on a whole-site gate would silently open the site.
			return { ok: false, reason: 'the Cognito edge function was built for a public site (re-run "Upgrade Cognito gate")' };
		}
		if (!runsCurrentEdge) {
			return { ok: false, reason: 'the site is not using the Cognito gate\'s current edge function (re-run "Upgrade Cognito gate")' };
		}
		return { ok: true };
	}
	if (mode === 'none') {
		if (!profile.publicSiteAccessGroups) {
			return { ok: false, reason: 'access groups are not turned on for this public site (Access groups → Gate notes on this public site)' };
		}
		if (!c?.stackName) {
			return { ok: false, reason: 'access groups need the Cognito sign-in pool; re-run the deployment wizard with "Gate individual notes with access groups" on' };
		}
		if (!c.edgeStackName || !c.accessGroupsKey || c.edgePublicReads !== true) {
			return { ok: false, reason: 'the access-groups edge function is not deployed (Settings → Infrastructure → Deploy access-groups edge function)' };
		}
		if (!runsCurrentEdge) {
			return { ok: false, reason: 'the site is not using the access-groups edge function (Settings → Infrastructure → Deploy access-groups edge function)' };
		}
		return { ok: true };
	}
	if (mode === 'byo') {
		return profile.byoEnforcesAccessGroups
			? { ok: true }
			: { ok: false, reason: 'the custom edge function has not been marked as enforcing /restricted/<group>/ paths' };
	}
	return { ok: false, reason: `the site's read gate is "${mode}"; access groups need Cognito sign-in` };
}

/**
 * Whether the viewer-request function `arn` would enforce `/restricted/<group>/*`
 * for this profile: the upgraded Cognito edge fn (either mode), or a BYO fn the
 * author vouched for. Used to refuse attaching anything else (including '' =
 * no edge fn) while gated notes exist, which would make them world-readable.
 */
export function edgeEnforcesGroups(profile: PublishingProfile, arn: string | undefined): boolean {
	if (!arn) return false;
	const c = profile.infrastructureState?.cognitoAuth;
	if (c?.edgeStackName && c.edgeFunctionVersionArn && arn === c.edgeFunctionVersionArn) return true;
	return profile.infrastructureState?.readGateMode === 'byo' && !!profile.byoEnforcesAccessGroups;
}

/**
 * Whether a specific note may publish with `groups`. Absent/empty groups are
 * always fine (site-wide default). Otherwise fail closed on any problem.
 */
export function validateNoteAccess(
	profile: PublishingProfile,
	normalized: NormalizedGroups,
	isHomeNote: boolean,
): GatedPublishCheck {
	if (normalized.invalid.length > 0) {
		return { ok: false, reason: `invalid group name(s): ${normalized.invalid.join(', ')} (use lowercase letters, digits, and hyphens)` };
	}
	if (normalized.groups.length === 0) return { ok: true };
	if (isHomeNote) {
		return { ok: false, reason: 'the home note must be public' };
	}
	const defined = profile.accessGroups || {};
	const undefinedGroups = normalized.groups.filter((g) => !defined[g]);
	if (undefinedGroups.length > 0) {
		return { ok: false, reason: `group(s) not defined in this profile's settings: ${undefinedGroups.join(', ')}` };
	}
	return canPublishGated(profile);
}

/** Stable membership file for the pre-token trigger: `{ version, groups }`. */
export function buildGroupsJson(profile: PublishingProfile): string {
	const groups: Record<string, string[]> = {};
	for (const name of Object.keys(profile.accessGroups || {}).sort()) {
		groups[name] = normalizeMembers(profile.accessGroups![name].members || []);
	}
	return JSON.stringify({ version: 1, groups });
}

/**
 * Split a uid-keyed record into the public view and one view per group.
 * `accessOf(uid)` returns the uid's groups ([] = public).
 */
export function partitionRecord<T>(
	record: Record<string, T>,
	accessOf: (uid: string) => string[],
	groupNames: string[],
): { publicView: Record<string, T>; groupViews: Record<string, Record<string, T>> } {
	const publicView: Record<string, T> = {};
	const groupViews: Record<string, Record<string, T>> = {};
	for (const g of groupNames) groupViews[g] = {};
	for (const [uid, value] of Object.entries(record)) {
		const groups = accessOf(uid);
		if (groups.length === 0) {
			publicView[uid] = value;
			continue;
		}
		for (const g of groups) {
			if (!groupViews[g]) groupViews[g] = {};
			groupViews[g][uid] = value;
		}
	}
	return { publicView, groupViews };
}

/** Same as partitionRecord for slug → uid maps (keyed by slug, filtered by uid). */
export function partitionSlugMap(
	slugToUid: Record<string, string>,
	accessOf: (uid: string) => string[],
	groupNames: string[],
): { publicView: Record<string, string>; groupViews: Record<string, Record<string, string>> } {
	const publicView: Record<string, string> = {};
	const groupViews: Record<string, Record<string, string>> = {};
	for (const g of groupNames) groupViews[g] = {};
	for (const [slug, uid] of Object.entries(slugToUid)) {
		const groups = accessOf(uid);
		if (groups.length === 0) {
			publicView[slug] = uid;
			continue;
		}
		for (const g of groups) {
			if (!groupViews[g]) groupViews[g] = {};
			groupViews[g][slug] = uid;
		}
	}
	return { publicView, groupViews };
}
