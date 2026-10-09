#!/usr/bin/env npx tsx
/**
 * UID Resolver + Audit Unit Test
 *
 * Exercises the pure cores behind note identity, with no Obsidian runtime:
 *
 *   - UidResolver (src/utils/uidResolver.ts): replays the race that published
 *     one note under two UIDs. A UID is minted, "written", and looked up again
 *     while the fake metadata cache still shows no UID; the resolver must keep
 *     returning the first UID and never mint a second.
 *   - uidFromRaw / isYamlAmbiguous / generateUID (src/utils/uid.ts).
 *   - auditPublishedUids (src/utils/uidAudit.ts): classifies a ledger with a
 *     stale UID and its live twin, a note that stopped publishing, a UID shared
 *     by two notes, and a YAML-coerced UID.
 *
 * Run: npx tsx e2e/scripts/test-uid-resolver.ts
 */

import * as resolverModule from '../../src/utils/uidResolver';
import * as uidModule from '../../src/utils/uid';
import * as auditModule from '../../src/utils/uidAudit';

// Under tsx's ESM/CJS interop, named exports from src/ modules can land under
// `.default` (same idiom as test-obscure-wikilinks.ts).
function pick<T>(mod: unknown, name: string): T {
	const m = mod as Record<string, unknown> & { default?: Record<string, unknown> };
	return (m[name] ?? m.default?.[name]) as T;
}

type ResolverModule = typeof import('../../src/utils/uidResolver');
type UidModule = typeof import('../../src/utils/uid');
type AuditModule = typeof import('../../src/utils/uidAudit');

const UidResolver = pick<ResolverModule['UidResolver']>(resolverModule, 'UidResolver');
const uidFromRaw = pick<ResolverModule['uidFromRaw']>(resolverModule, 'uidFromRaw');
const generateUID = pick<UidModule['generateUID']>(uidModule, 'generateUID');
const isYamlAmbiguous = pick<UidModule['isYamlAmbiguous']>(uidModule, 'isYamlAmbiguous');
const auditPublishedUids = pick<AuditModule['auditPublishedUids']>(auditModule, 'auditPublishedUids');
const formatUidAudit = pick<AuditModule['formatUidAudit']>(auditModule, 'formatUidAudit');
const homeUidsOf = pick<AuditModule['homeUidsOf']>(auditModule, 'homeUidsOf');

const NO_HOME = { notePath: null, note: null, publishedUid: null };

// ---------------------------------------------------------------------------
// Tiny assertion helpers
// ---------------------------------------------------------------------------

let failures = 0;
let total = 0;

function check(name: string, ok: boolean, detail = ''): void {
	total++;
	if (ok) {
		console.log(`PASS  ${name}`);
	} else {
		failures++;
		console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
	}
}

function eq(name: string, got: unknown, expected: unknown): void {
	const g = JSON.stringify(got);
	const e = JSON.stringify(expected);
	check(name, g === e, `expected ${e}\n        got      ${g}`);
}

// ---------------------------------------------------------------------------
// Fake vault: files are plain objects; `indexed` plays the metadata cache.
// ---------------------------------------------------------------------------

interface FakeFile { name: string; contexts: string[] }

function makeHarness() {
	const indexed = new Map<FakeFile, unknown>();
	const minted: Array<{ file: string; uid: string }> = [];
	const warnings: string[] = [];
	let counter = 0;
	const resolver = new UidResolver<FakeFile>({
		readIndexedUid: (f) => indexed.get(f),
		canMint: (f) => f.contexts.length > 0,
		mint: () => `MINT${String(++counter).padStart(4, '0')}`,
		onMint: (f, uid) => minted.push({ file: f.name, uid }),
		name: (f) => f.name,
		log: { debug: () => {}, warn: (m) => warnings.push(m) },
	});
	return { resolver, indexed, minted, warnings };
}

// ---------------------------------------------------------------------------
// UidResolver
// ---------------------------------------------------------------------------

function testCapturedRace(): void {
	const { resolver, indexed, minted } = makeHarness();
	const note: FakeFile = { name: 'Family Secret.md', contexts: ['default'] };

	// queueNote: first lookup mints.
	const first = resolver.resolve(note);
	// Link resolution for another note in the same batch.
	const again = resolver.resolve(note);
	// process(): the write lands on disk and CPN remembers it, but the
	// metadata cache has not re-indexed the file yet.
	resolver.remember(note, first!);
	// commitPendingNotes -> backlinks: this is where the second UID used to be minted.
	const afterWrite = resolver.resolve(note);
	const peekAfterWrite = resolver.peek(note);
	// Next publish, still before the cache catches up.
	const nextPublish = resolver.resolve(note);
	// The cache re-indexes the file and fires `changed`.
	indexed.set(note, first);
	resolver.confirm(note, first);
	const afterIndex = resolver.resolve(note);

	eq('Race: exactly one UID minted for the note', minted.length, 1);
	eq('Race: every lookup returns the first UID',
		[again, afterWrite, peekAfterWrite, nextPublish, afterIndex],
		[first, first, first, first, first]);
	check('Race: pending UID released once indexed', !resolver.hasPending(note));
}

function testNoMintWithoutContexts(): void {
	const { resolver, minted } = makeHarness();
	const note: FakeFile = { name: 'Private.md', contexts: [] };
	eq('No publish context: resolve returns null', resolver.resolve(note), null);
	eq('No publish context: nothing minted', minted.length, 0);
}

function testPeekNeverMints(): void {
	const { resolver, minted } = makeHarness();
	const note: FakeFile = { name: 'New.md', contexts: ['default'] };
	eq('Peek on a note without a UID returns null', resolver.peek(note), null);
	eq('Peek mints nothing', minted.length, 0);
}

function testExistingValuesKept(): void {
	const { resolver, indexed, minted } = makeHarness();
	const str: FakeFile = { name: 'Str.md', contexts: ['default'] };
	const num: FakeFile = { name: 'Num.md', contexts: ['default'] };
	indexed.set(str, 'AB12CD34');
	indexed.set(num, 12345678); // unquoted all-digit UID: YAML reads a number
	eq('Existing string UID returned as-is', resolver.resolve(str), 'AB12CD34');
	eq('YAML-coerced numeric UID resolves as before (String(value))', resolver.resolve(num), '12345678');
	eq('No mint for notes that already have a UID', minted.length, 0);
}

function testDiskWinsOverPending(): void {
	const { resolver, indexed, warnings } = makeHarness();
	const note: FakeFile = { name: 'Synced.md', contexts: ['default'] };
	const minted = resolver.resolve(note);
	// Another device's UID arrives through sync before CPN's write.
	indexed.set(note, 'SYNCED01');
	eq('On-disk UID wins over a pending one', resolver.peek(note), 'SYNCED01');
	check('Divergence is logged', warnings.some((w) => w.includes('SYNCED01') && w.includes(minted!)));
	check('Pending UID dropped after divergence', !resolver.hasPending(note));
}

function testFileIdentity(): void {
	const { resolver, minted } = makeHarness();
	const original: FakeFile = { name: 'Same Path.md', contexts: ['default'] };
	const recreated: FakeFile = { name: 'Same Path.md', contexts: ['default'] };
	const a = resolver.resolve(original);
	const b = resolver.resolve(recreated);
	check('A new file at the same path does not inherit a pending UID', a !== b && minted.length === 2,
		`a=${a} b=${b} minted=${minted.length}`);
}

// ---------------------------------------------------------------------------
// uidFromRaw / isYamlAmbiguous / generateUID
// ---------------------------------------------------------------------------

function testUidFromRaw(): void {
	eq('uidFromRaw: absent and empty values are no UID',
		[undefined, null, '', '   ', 0, false].map(uidFromRaw),
		[null, null, null, null, null, null]);
	eq('uidFromRaw: values CPN has always used stay the same',
		['AB12CD34', 12345678, Infinity].map(uidFromRaw),
		['AB12CD34', '12345678', 'Infinity']);
}

function testYamlAmbiguity(): void {
	eq('isYamlAmbiguous: number-shaped UIDs',
		['12345678', '00123456', '12E45678', '0E123456'].map(isYamlAmbiguous),
		[true, true, true, true]);
	eq('isYamlAmbiguous: ordinary UIDs',
		['AB12CD34', 'E1234567', '1234567E', '12E4E678'].map(isYamlAmbiguous),
		[false, false, false, false]);
}

function testGenerateUID(): void {
	const crockford = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/;
	let bad = 0;
	for (let i = 0; i < 2000; i++) {
		const uid = generateUID(8);
		if (uid.length !== 8 || !crockford.test(uid) || isYamlAmbiguous(uid)) bad++;
	}
	eq('generateUID: 2000 draws are 8-char Crockford and never number-shaped', bad, 0);

	// Force an all-zero first draw ("00000000", number-shaped) to prove the re-draw.
	const cryptoObj = globalThis.crypto as Crypto;
	const real = cryptoObj.getRandomValues.bind(cryptoObj);
	let calls = 0;
	Object.defineProperty(cryptoObj, 'getRandomValues', {
		configurable: true,
		value: <T extends ArrayBufferView | null>(array: T): T => {
			calls++;
			if (calls === 1 && array) {
				new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0);
				return array;
			}
			return real(array as never) as T;
		},
	});
	try {
		const uid = generateUID(8);
		check('generateUID: a number-shaped draw is replaced', uid !== '00000000' && calls >= 2,
			`uid=${uid} calls=${calls}`);
	} finally {
		delete (cryptoObj as unknown as Record<string, unknown>).getRandomValues;
	}
}

// ---------------------------------------------------------------------------
// auditPublishedUids
// ---------------------------------------------------------------------------

function testAudit(): void {
	const report = auditPublishedUids(
		{
			slugToUid: { 'Notes/Dup': 'NEW00001', Gone: 'GONE0001', Drop: 'DROP0001' },
			uidToHash: {
				OLD00001: 'h1', NEW00001: 'h2', GONE0001: 'h3', DROP0001: 'h4',
				SHARED01: 'h5', TENCHARS10: 'h6',
			},
			contentIndex: {
				OLD00001: { title: 'Dup' },
				NEW00001: { title: 'Dup' },
				GONE0001: { title: 'Gone' },
			},
		},
		[
			{ path: 'Notes/Dup.md', uid: 'NEW00001', nonStringUid: false, publishable: true },
			{ path: 'Drop.md', uid: 'DROP0001', nonStringUid: false, publishable: false },
			{ path: 'A.md', uid: 'SHARED01', nonStringUid: false, publishable: true },
			{ path: 'B.md', uid: 'shared01 ', nonStringUid: false, publishable: true },
			{ path: 'Num.md', uid: '12345678', nonStringUid: true, publishable: true },
			{ path: 'Ten.md', uid: 'TENCHARS10', nonStringUid: false, publishable: true },
			{ path: 'NoUid.md', uid: null, nonStringUid: false, publishable: true },
		],
		8,
		NO_HOME,
	);

	eq('Audit: orphans (stale UID and deleted note), sorted by label',
		report.orphans.map((e) => [e.uid, e.label]), [['OLD00001', 'Dup'], ['GONE0001', 'Gone']]);
	eq('Audit: stale UID names its live twin', report.orphans[0].twins, ['NEW00001']);
	eq('Audit: deleted note has no twin', report.orphans[1].twins, []);
	eq('Audit: note that stopped publishing', report.unpublishedInVault.map((e) => e.uid), ['DROP0001']);
	eq('Audit: flagged entries listed first',
		report.published.slice(0, 3).map((e) => e.uid), ['OLD00001', 'GONE0001', 'DROP0001']);
	eq('Audit: UID shared by two notes (case/space-insensitive)',
		report.sharedUids, [{ uid: 'SHARED01', paths: ['A.md', 'B.md'] }]);
	eq('Audit: YAML-coerced UID reported', report.nonStringUids, ['Num.md']);
	eq('Audit: live UID length mismatch reported', report.lengthMismatch, ['TENCHARS10']);
	const lines = formatUidAudit(report).join('\n');
	check('Audit: console report names the stale UID and its twin',
		lines.includes('OLD00001 "Dup": no vault note; current copy is likely NEW00001'), lines);
	eq('Audit: no home note set, no home issues', report.homeIssues, []);
}

function testAuditHome(): void {
	const ledger = {
		slugToUid: { Home: 'HOME0001', Other: 'OTHR0001' },
		uidToHash: { HOME0001: 'h1', OLDHOME1: 'h2', OTHR0001: 'h3', GONE0001: 'h4' },
		contentIndex: { HOME0001: { title: 'Home' }, OLDHOME1: { title: 'Home' } },
	};
	const other = { path: 'Other.md', uid: 'OTHR0001', nonStringUid: false, publishable: true };

	// The home note no longer lists the profile: previously flagged "no longer published".
	const homeNote = { path: 'Home.md', uid: 'HOME0001', nonStringUid: false, publishable: false };
	let report = auditPublishedUids(ledger, [homeNote, other], 8,
		{ notePath: 'Home.md', note: homeNote, publishedUid: 'HOME0001' });
	const home = report.published.find((e) => e.uid === 'HOME0001');
	eq('Audit home: home note that stopped publishing is not flagged',
		[home?.home, home?.unpublishedInVault, report.unpublishedInVault.map((e) => e.uid)], [true, false, []]);
	check('Audit home: reported as a home issue instead',
		report.homeIssues.some((i) => i.includes('"Home.md" does not publish to this profile')), JSON.stringify(report.homeIssues));
	eq('Audit home: other orphans still flagged, home sorts before unflagged',
		report.published.map((e) => e.uid), ['GONE0001', 'OLDHOME1', 'HOME0001', 'OTHR0001']);
	eq('Audit home: stale home UID names the live home as its twin',
		report.orphans.find((e) => e.uid === 'OLDHOME1')?.twins, ['HOME0001']);

	// The site still opens the old UID as home (home note's UID changed, not published since).
	const renewed = { path: 'Home.md', uid: 'HOME0001', nonStringUid: false, publishable: true };
	report = auditPublishedUids(ledger, [renewed, other], 8,
		{ notePath: 'Home.md', note: renewed, publishedUid: 'oldhome1' });
	eq('Audit home: both the pushed and the vault home UID are protected',
		[report.orphans.map((e) => e.uid), report.published.filter((e) => e.home).map((e) => e.uid).sort()],
		[['GONE0001'], ['HOME0001', 'OLDHOME1']]);
	check('Audit home: pushed home UID that differs is reported',
		report.homeIssues.some((i) => i.includes('still opens oldhome1') && i.includes('point it at HOME0001')), JSON.stringify(report.homeIssues));

	// The home note setting points at a missing note (renamed or deleted).
	report = auditPublishedUids(ledger, [renewed, other], 8,
		{ notePath: 'Old Home.md', note: null, publishedUid: 'HOME0001' });
	check('Audit home: missing home note path reported',
		report.homeIssues.some((i) => i.includes('"Old Home.md" is not in the vault')), JSON.stringify(report.homeIssues));
	check('Audit home: UID the site opens as home stays unflagged',
		!report.orphans.some((e) => e.uid === 'HOME0001') && report.published.some((e) => e.uid === 'HOME0001' && e.home));

	// A home note with a UID that was never published.
	const fresh = { path: 'New Home.md', uid: 'NEWHOME1', nonStringUid: false, publishable: true };
	report = auditPublishedUids(ledger, [fresh, other], 8,
		{ notePath: 'New Home.md', note: fresh, publishedUid: null });
	check('Audit home: unpublished home UID reported',
		report.homeIssues.some((i) => i.includes('NEWHOME1 is not in this profile')), JSON.stringify(report.homeIssues));

	eq('Audit home: homeUidsOf normalizes and de-duplicates',
		homeUidsOf({ notePath: 'Home.md', note: { ...renewed, uid: 'home0001 ' }, publishedUid: 'HOME0001' }), ['HOME0001']);
	eq('Audit home: homeUidsOf ignores empty values', homeUidsOf({ notePath: null, note: null, publishedUid: '' }), []);
	const lines = formatUidAudit(report).join('\n');
	check('Audit home: console report has a home section', lines.includes('Home note issues (1):'), lines);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

testCapturedRace();
testNoMintWithoutContexts();
testPeekNeverMints();
testExistingValuesKept();
testDiskWinsOverPending();
testFileIdentity();
testUidFromRaw();
testYamlAmbiguity();
testGenerateUID();
testAudit();
testAuditHome();

console.log('');
if (failures === 0) {
	console.log(`All ${total} UID resolver/audit checks passed.`);
	process.exit(0);
} else {
	console.log(`${failures}/${total} UID resolver/audit checks FAILED.`);
	process.exit(1);
}
