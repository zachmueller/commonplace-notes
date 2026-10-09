/**
 * Compare a profile's local publish ledger with the vault to find UIDs that
 * are live on the site but no longer belong to any note. No Obsidian
 * dependency, so it can be unit-tested under plain Node.
 *
 * The typical finding is a note published under two UIDs: the stale one stays
 * in `uid-to-hash.json` (and so on the site, and in search) after the note's
 * `cpn-uid` changed, because publishing only ever adds UIDs to the ledger.
 *
 * The site's home page UID is never flagged: the site opens its home page by
 * UID, so deleting it breaks the front page. Home note problems are reported
 * separately, as things to fix rather than delete.
 */

import { normalizeUID } from './uidResolver';

/** One vault note, as the audit needs it. */
export interface AuditVaultNote {
	path: string;
	/** The note's UID as CPN resolves it, or null when it has none. */
	uid: string | null;
	/** The raw `cpn-uid` value is not a string (YAML read it as a number, list, ...). */
	nonStringUid: boolean;
	/** The note publishes to the audited profile (lists it, and is not in an excluded folder). */
	publishable: boolean;
}

/** The profile's home note, as the audit needs it. */
export interface AuditHome {
	/** The profile's home note setting, or null when none is set. */
	notePath: string | null;
	/** The vault note at {@link notePath}, or null when there is no such note. */
	note: AuditVaultNote | null;
	/** The home UID last pushed to the site, or null when none was. */
	publishedUid: string | null;
}

/** The profile's local ledger files. */
export interface AuditLedger {
	slugToUid: Record<string, string>;
	uidToHash: Record<string, string>;
	contentIndex: Record<string, { title?: unknown }>;
}

/** A UID the ledger says is published. */
export interface PublishedUid {
	uid: string;
	/** Slug, else published title, else the UID itself. */
	label: string;
	slug: string | null;
	title: string | null;
	/** Vault notes carrying this UID. */
	carriers: string[];
	/** The site's home page (now, or after the next publish). Never flagged, never deletable. */
	home: boolean;
	/** No vault note carries this UID: a stale copy, or a note deleted from the vault. */
	orphan: boolean;
	/** Carried, but no carrying note publishes to this profile any more. */
	unpublishedInVault: boolean;
	/** For orphans: live published UIDs with the same title (the likely current copy). */
	twins: string[];
}

export interface UidAuditReport {
	/** Every published UID: orphans first, then unpublished-in-vault, then the home page, then the rest by label. */
	published: PublishedUid[];
	orphans: PublishedUid[];
	unpublishedInVault: PublishedUid[];
	/** UIDs carried by more than one vault note. */
	sharedUids: Array<{ uid: string; paths: string[] }>;
	/** Notes whose `cpn-uid` YAML reads as something other than a string. */
	nonStringUids: string[];
	/** Live published UIDs whose length differs from the UID length setting (informational). */
	lengthMismatch: string[];
	/** Problems with the profile's home note, each saying what to fix (informational; never offered for deletion). */
	homeIssues: string[];
}

/**
 * The UIDs the site's home page uses, normalized: the one last pushed to the
 * site (what the live home page opens now) and the vault home note's (what
 * the next publish pushes). Deleting either breaks the home page.
 */
export function homeUidsOf(home: AuditHome): string[] {
	const uids = [home.publishedUid, home.note?.uid ?? null]
		.filter((uid): uid is string => uid !== null && normalizeUID(uid) !== '')
		.map((uid) => normalizeUID(uid));
	return [...new Set(uids)];
}

export function auditPublishedUids(
	ledger: AuditLedger,
	vault: AuditVaultNote[],
	uidLength: number,
	home: AuditHome,
): UidAuditReport {
	const homeUids = new Set(homeUidsOf(home));

	const carriers = new Map<string, AuditVaultNote[]>();
	for (const note of vault) {
		if (note.uid === null) continue;
		const key = normalizeUID(note.uid);
		const list = carriers.get(key);
		if (list) list.push(note);
		else carriers.set(key, [note]);
	}

	const slugByUid = new Map<string, string>();
	for (const [slug, uid] of Object.entries(ledger.slugToUid)) {
		if (!slugByUid.has(uid)) slugByUid.set(uid, slug);
	}

	const uids = new Set<string>([
		...Object.keys(ledger.uidToHash),
		...Object.keys(ledger.contentIndex),
		...Object.values(ledger.slugToUid),
	]);

	const published: PublishedUid[] = [];
	for (const uid of uids) {
		const notes = carriers.get(normalizeUID(uid)) ?? [];
		const rawTitle = ledger.contentIndex[uid]?.title;
		const title = typeof rawTitle === 'string' && rawTitle !== '' ? rawTitle : null;
		const slug = slugByUid.get(uid) ?? null;
		const isHome = homeUids.has(normalizeUID(uid));
		published.push({
			uid,
			label: slug ?? title ?? uid,
			slug,
			title,
			carriers: notes.map((n) => n.path),
			home: isHome,
			// The home page is reported under homeIssues instead: deleting it
			// would break the site's front page, whatever the vault says.
			orphan: !isHome && notes.length === 0,
			unpublishedInVault: !isHome && notes.length > 0 && !notes.some((n) => n.publishable),
			twins: [],
		});
	}

	for (const entry of published) {
		if (!entry.orphan || entry.title === null) continue;
		entry.twins = published
			.filter((other) => !other.orphan && other.title === entry.title)
			.map((other) => other.uid);
	}

	const rank = (e: PublishedUid) => (e.orphan ? 0 : e.unpublishedInVault ? 1 : e.home ? 2 : 3);
	published.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));

	const sharedUids = [...carriers.entries()]
		.filter(([, notes]) => notes.length > 1)
		.map(([, notes]) => ({ uid: notes[0].uid!, paths: notes.map((n) => n.path) }));

	return {
		published,
		orphans: published.filter((e) => e.orphan),
		unpublishedInVault: published.filter((e) => e.unpublishedInVault),
		sharedUids,
		nonStringUids: vault.filter((n) => n.nonStringUid).map((n) => n.path),
		lengthMismatch: published
			.filter((e) => !e.orphan && e.uid.length !== uidLength)
			.map((e) => e.uid),
		homeIssues: auditHome(home, new Set([...uids].map((uid) => normalizeUID(uid)))),
	};
}

function auditHome(home: AuditHome, publishedUids: Set<string>): string[] {
	const issues: string[] = [];
	const { notePath, note, publishedUid } = home;
	if (notePath !== null && note === null) {
		issues.push(`Home note "${notePath}" is not in the vault (renamed or deleted?). Update the profile's home note setting, then publish.`);
	}
	if (note !== null && note.uid === null) {
		issues.push(`Home note "${note.path}" has no cpn-uid yet. Publish it.`);
	}
	if (note !== null && !note.publishable) {
		issues.push(`Home note "${note.path}" does not publish to this profile (check its cpn-publish-contexts and the excluded directories). Its published UID is kept.`);
	}
	const vaultUid = note?.uid ?? null;
	if (publishedUid !== null && normalizeUID(publishedUid) !== normalizeUID(vaultUid)) {
		issues.push(vaultUid !== null
			? `The site still opens ${publishedUid} as its home page. Publish to point it at ${vaultUid}.`
			: `The site still opens ${publishedUid} as its home page. It stays protected until the home note is fixed and published.`);
	}
	for (const uid of homeUidsOf(home)) {
		if (!publishedUids.has(uid)) {
			issues.push(`Home UID ${uid} is not in this profile's published ledger. Publish the home note.`);
		}
	}
	return issues;
}

/** One-line description of a flagged entry, for the picker and the console report. */
export function describePublishedUid(entry: PublishedUid): string {
	if (entry.home) return 'home page';
	if (entry.orphan) {
		return entry.twins.length > 0
			? `no vault note; current copy is likely ${entry.twins.join(', ')}`
			: 'no vault note';
	}
	if (entry.unpublishedInVault) {
		return `no longer published from ${entry.carriers.join(', ')}`;
	}
	return '';
}

/** Console report lines for an audit. */
export function formatUidAudit(report: UidAuditReport): string[] {
	const lines: string[] = [];
	const section = (heading: string, items: string[]) => {
		lines.push(`${heading} (${items.length})${items.length ? ':' : ''}`);
		for (const item of items) lines.push(`  ${item}`);
	};
	const show = (e: PublishedUid) => {
		const name = e.label === e.uid ? e.uid : `${e.uid} "${e.label}"`;
		return `${name}: ${describePublishedUid(e)}`;
	};
	section('Published UIDs with no vault note', report.orphans.map(show));
	section('Published UIDs whose note no longer publishes to this profile', report.unpublishedInVault.map(show));
	section('UIDs shared by more than one note', report.sharedUids.map((s) => `${s.uid}: ${s.paths.join(', ')}`));
	section('Notes whose cpn-uid YAML reads as a non-string', report.nonStringUids);
	section('Live UIDs whose length differs from the UID length setting', report.lengthMismatch);
	section('Home note issues', report.homeIssues);
	return lines;
}
