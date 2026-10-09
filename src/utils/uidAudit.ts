/**
 * Compare a profile's local publish ledger with the vault to find UIDs that
 * are live on the site but no longer belong to any note. No Obsidian
 * dependency, so it can be unit-tested under plain Node.
 *
 * The typical finding is a note published under two UIDs: the stale one stays
 * in `uid-to-hash.json` (and so on the site, and in search) after the note's
 * `cpn-uid` changed, because publishing only ever adds UIDs to the ledger.
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
	/** No vault note carries this UID: a stale copy, or a note deleted from the vault. */
	orphan: boolean;
	/** Carried, but no carrying note publishes to this profile any more. */
	unpublishedInVault: boolean;
	/** For orphans: live published UIDs with the same title (the likely current copy). */
	twins: string[];
}

export interface UidAuditReport {
	/** Every published UID: orphans first, then unpublished-in-vault, then the rest by label. */
	published: PublishedUid[];
	orphans: PublishedUid[];
	unpublishedInVault: PublishedUid[];
	/** UIDs carried by more than one vault note. */
	sharedUids: Array<{ uid: string; paths: string[] }>;
	/** Notes whose `cpn-uid` YAML reads as something other than a string. */
	nonStringUids: string[];
	/** Live published UIDs whose length differs from the UID length setting (informational). */
	lengthMismatch: string[];
}

export function auditPublishedUids(
	ledger: AuditLedger,
	vault: AuditVaultNote[],
	uidLength: number,
): UidAuditReport {
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
		published.push({
			uid,
			label: slug ?? title ?? uid,
			slug,
			title,
			carriers: notes.map((n) => n.path),
			orphan: notes.length === 0,
			unpublishedInVault: notes.length > 0 && !notes.some((n) => n.publishable),
			twins: [],
		});
	}

	for (const entry of published) {
		if (!entry.orphan || entry.title === null) continue;
		entry.twins = published
			.filter((other) => !other.orphan && other.title === entry.title)
			.map((other) => other.uid);
	}

	const rank = (e: PublishedUid) => (e.orphan ? 0 : e.unpublishedInVault ? 1 : 2);
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
	};
}

/** One-line description of a flagged entry, for the picker and the console report. */
export function describePublishedUid(entry: PublishedUid): string {
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
	return lines;
}
