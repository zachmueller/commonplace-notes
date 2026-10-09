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

console.log('');
if (failures === 0) {
	console.log(`All ${total} UID resolver/audit checks passed.`);
	process.exit(0);
} else {
	console.log(`${failures}/${total} UID resolver/audit checks FAILED.`);
	process.exit(1);
}
