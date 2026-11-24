#!/usr/bin/env npx tsx
/**
 * Attachment change notice unit test (attachment spec P4 §1, §2).
 *
 *   I  AttachmentReferenceIndex: record replaces a note's refs, a note
 *      without refs drops out, notes outside a batch keep theirs, a UID at a
 *      new path drops the old path, renameNote / forgetNote / forgetUid.
 *   D  Several modify events within 5 s produce one notice, 5 s after the
 *      last; different files debounce separately; stop() cancels.
 *   N  No notice for a file no published note references (no timer either),
 *      for notes (.md), without a hash-cache entry, when the file can't be
 *      read, or when every note already published the current bytes.
 *   P  One notice per profile, naming the profile when several are
 *      configured; a profile where the file no longer publishes (mode off,
 *      excluded, not allowed) gets none; only notes with other bytes count.
 *   R  Republish them publishes exactly the referencing notes that still
 *      publish; while the profile's lock is held it shows the busy notice,
 *      keeps the change notice and publishes nothing.
 *   T  Notice wording.
 *
 * The Obsidian wiring (vault events, the Notice, the publisher) runs in the
 * live e2e, attachment-change-notice-live-e2e.ts.
 *
 * Run: npx tsx e2e/scripts/test-attachment-change-notice.ts
 */

import * as noticeModule from '../../src/utils/attachmentChangeNotice';
import * as lockModule from '../../src/utils/publishLock';

const m: typeof import('../../src/utils/attachmentChangeNotice') =
	(noticeModule as any).AttachmentChangeWatcher ? noticeModule : (noticeModule as any).default;
const lock: typeof import('../../src/utils/publishLock') =
	(lockModule as any).withProfileLock ? lockModule : (lockModule as any).default;

type ChangeNotice = import('../../src/utils/attachmentChangeNotice').ChangeNotice;

const failures: string[] = [];
let checks = 0;
function check(name: string, ok: boolean, detail = ''): void {
	checks++;
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures.push(name);
		console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
	}
}
const j = (v: unknown) => JSON.stringify(v);

/** A manual clock for the debouncer. */
class FakeClock {
	now = 0;
	private next = 1;
	private timers = new Map<number, { at: number; fn: () => void }>();
	readonly api = {
		set: (fn: () => void, ms: number) => { const id = this.next++; this.timers.set(id, { at: this.now + ms, fn }); return id; },
		clear: (h: unknown) => { this.timers.delete(h as number); },
	};
	advance(ms: number): void {
		const until = this.now + ms;
		for (;;) {
			const due = [...this.timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.timers.delete(due[0]);
			this.now = due[1].at;
			due[1].fn();
		}
		this.now = until;
	}
	get pending(): number { return this.timers.size; }
}

interface Rig {
	clock: FakeClock;
	watcher: InstanceType<typeof m.AttachmentChangeWatcher>;
	notices: ChangeNotice[];
	hashes: Map<string, string | null>;
	cached: Set<string>;
	ineligible: Set<string>; // `${profileId}:${path}`
	profiles: Array<{ id: string; name: string }>;
	hashCalls: string[];
}

function rig(profiles = [{ id: 'p1', name: 'Site One' }]): Rig {
	const clock = new FakeClock();
	const r: Partial<Rig> = { clock, notices: [], hashes: new Map(), cached: new Set(), ineligible: new Set(), profiles, hashCalls: [] };
	r.watcher = new m.AttachmentChangeWatcher({
		profiles: () => r.profiles!,
		hasHashEntry: async (p) => r.cached!.has(p),
		eligible: async (id, p) => !r.ineligible!.has(`${id}:${p}`),
		currentHash: async (p) => { r.hashCalls!.push(p); return r.hashes!.has(p) ? r.hashes!.get(p)! : null; },
		notify: (n) => r.notices!.push(n),
		warn: (msg, e) => console.log(`  warn: ${msg} ${e}`),
		timers: clock.api,
	});
	return r as Rig;
}

/** Advance past the debounce and let the async check finish. */
async function settle(r: Rig, ms = 5000): Promise<void> {
	r.clock.advance(ms);
	await r.watcher.lastCheck;
}

const SONG = 'Media/song.mp3';
const PIC = 'Media/pic.png';

async function main(): Promise<void> {
	// ---------------------------------------------------------------- I
	{
		const idx = new m.AttachmentReferenceIndex();
		idx.record('p1', [
			{ notePath: 'A.md', uid: 'A', refs: [{ vaultPath: SONG, sha256: 'h1' }, { vaultPath: PIC, sha256: 'p1' }] },
			{ notePath: 'B.md', uid: 'B', refs: [{ vaultPath: SONG, sha256: 'h1' }] },
		]);
		check('I1 referencing lists the notes using a file, sorted', j(idx.referencing('p1', SONG)) === j([
			{ notePath: 'A.md', uid: 'A', sha256: 'h1' }, { notePath: 'B.md', uid: 'B', sha256: 'h1' }]));
		idx.record('p1', [{ notePath: 'A.md', uid: 'A', refs: [{ vaultPath: PIC, sha256: 'p2' }] }]);
		check('I2 a republished note\'s refs replace its old ones; B (not in the batch) keeps its',
			j(idx.referencing('p1', SONG).map(n => n.notePath)) === j(['B.md']) && idx.referencing('p1', PIC)[0]?.sha256 === 'p2');
		idx.record('p1', [{ notePath: 'B.md', uid: 'B', refs: [] }]);
		check('I3 a note published without attachments drops out', !idx.references(SONG) && idx.references(PIC));
		idx.record('p1', [{ notePath: 'A2.md', uid: 'A', refs: [{ vaultPath: PIC, sha256: 'p3' }] }]);
		check('I4 a UID published from a new path drops the old path',
			j(idx.referencing('p1', PIC).map(n => n.notePath)) === j(['A2.md']));
		idx.renameNote('A2.md', 'Moved/A.md');
		check('I5 renameNote moves the entry', idx.referencing('p1', PIC)[0]?.notePath === 'Moved/A.md');
		idx.record('p2', [{ notePath: 'Moved/A.md', uid: 'A', refs: [{ vaultPath: PIC, sha256: 'p3' }] }]);
		check('I6 profilesReferencing lists each profile once', j(idx.profilesReferencing(PIC)) === j(['p1', 'p2']));
		idx.forgetUid('p1', 'A');
		check('I7 forgetUid drops the note on that profile only', j(idx.profilesReferencing(PIC)) === j(['p2']));
		idx.forgetNote('Moved/A.md');
		check('I8 forgetNote drops the note on every profile', !idx.references(PIC) && idx.profilesReferencing(PIC).length === 0);
	}

	// ---------------------------------------------------------------- D
	{
		const r = rig();
		r.watcher.index.record('p1', [{ notePath: 'A.md', uid: 'A', refs: [{ vaultPath: SONG, sha256: 'old' }] }]);
		r.cached.add(SONG);
		r.hashes.set(SONG, 'new');
		for (let i = 0; i < 5; i++) { r.watcher.onModify(SONG); r.clock.advance(1000); }
		check('D1 no notice while modify events keep coming', r.notices.length === 0 && r.hashCalls.length === 0);
		r.clock.advance(3999);
		await r.watcher.lastCheck;
		check('D2 still none 1 ms before 5 s after the last event', r.notices.length === 0);
		await settle(r, 1);
		check('D3 five modify events within 5 s produce one notice', r.notices.length === 1 && r.hashCalls.length === 1, j(r.notices));
		await settle(r, 60_000);
		check('D4 and nothing more afterwards', r.notices.length === 1 && r.clock.pending === 0);

		const r2 = rig();
		r2.watcher.index.record('p1', [{ notePath: 'A.md', uid: 'A', refs: [{ vaultPath: SONG, sha256: 'old' }, { vaultPath: PIC, sha256: 'old' }] }]);
		for (const p of [SONG, PIC]) { r2.cached.add(p); r2.hashes.set(p, 'new'); }
		r2.watcher.onModify(SONG);
		r2.clock.advance(2000);
		r2.watcher.onModify(PIC);
		await settle(r2, 3000);
		const first = r2.notices.map(n => n.fileName);
		await settle(r2, 2000);
		check('D5 different files debounce separately', j(first) === j(['song.mp3']) && j(r2.notices.map(n => n.fileName)) === j(['song.mp3', 'pic.png']), j(r2.notices));

		const r3 = rig();
		r3.watcher.index.record('p1', [{ notePath: 'A.md', uid: 'A', refs: [{ vaultPath: SONG, sha256: 'old' }] }]);
		r3.cached.add(SONG); r3.hashes.set(SONG, 'new');
		r3.watcher.onModify(SONG);
		r3.watcher.stop();
		await settle(r3, 10_000);
		check('D6 stop() cancels pending checks', r3.notices.length === 0 && r3.clock.pending === 0);
	}

	// ---------------------------------------------------------------- N
	{
		const r = rig();
		r.watcher.index.record('p1', [{ notePath: 'A.md', uid: 'A', refs: [{ vaultPath: SONG, sha256: 'old' }] }]);
		r.cached.add(SONG).add('Media/other.mp3');
		r.hashes.set(SONG, 'new').set('Media/other.mp3', 'x');
		r.watcher.onModify('Media/other.mp3');
		check('N1 a file no published note references starts no timer', r.clock.pending === 0);
		await settle(r);
		check('N2 and produces no notice', r.notices.length === 0 && r.hashCalls.length === 0);
		r.watcher.index.record('p1', [{ notePath: 'B.md', uid: 'B', refs: [{ vaultPath: 'Notes/C.md', sha256: 'x' }] }]);
		r.watcher.onModify('Notes/C.md');
		check('N3 notes (.md) are ignored', r.clock.pending === 0);

		r.cached.delete(SONG);
		r.watcher.onModify(SONG);
		await settle(r);
		check('N4 no hash-cache entry: no notice, not hashed', r.notices.length === 0 && r.hashCalls.length === 0);

		r.cached.add(SONG);
		r.hashes.set(SONG, null);
		r.watcher.onModify(SONG);
		await settle(r);
		check('N5 file unreadable: no notice', r.notices.length === 0);

		r.hashes.set(SONG, 'old');
		r.watcher.onModify(SONG);
		await settle(r);
		check('N6 bytes unchanged from what was published: no notice', r.notices.length === 0);
	}

	// ---------------------------------------------------------------- P
	{
		const r = rig([{ id: 'p1', name: 'Site One' }, { id: 'p2', name: 'Site Two' }, { id: 'p3', name: 'Site Three' }]);
		r.watcher.index.record('p1', [
			{ notePath: 'A.md', uid: 'A', refs: [{ vaultPath: SONG, sha256: 'old' }] },
			{ notePath: 'B.md', uid: 'B', refs: [{ vaultPath: SONG, sha256: 'old' }] },
			{ notePath: 'C.md', uid: 'C', refs: [{ vaultPath: SONG, sha256: 'new' }] },
			{ notePath: 'D.md', uid: 'D', refs: [{ vaultPath: PIC, sha256: 'old' }] },
		]);
		r.watcher.index.record('p2', [{ notePath: 'A.md', uid: 'A', refs: [{ vaultPath: SONG, sha256: 'old' }] }]);
		r.watcher.index.record('p3', [{ notePath: 'A.md', uid: 'A', refs: [{ vaultPath: SONG, sha256: 'old' }] }]);
		r.ineligible.add(`p3:${SONG}`);
		r.cached.add(SONG); r.hashes.set(SONG, 'new');
		r.watcher.onModify(SONG);
		await settle(r);
		const byProfile = Object.fromEntries(r.notices.map(n => [n.profileId, n]));
		check('P1 one notice per profile that still publishes the file (p3 ineligible)', j(r.notices.map(n => n.profileId)) === j(['p1', 'p2']), j(r.notices));
		check('P2 only notes that published other bytes count (C has the new bytes, D uses another file)',
			j(byProfile.p1?.notePaths) === j(['A.md', 'B.md']) && j(byProfile.p2?.notePaths) === j(['A.md']));
		check('P3 profile named when several profiles are configured',
			m.changeNoticeText(byProfile.p1) === 'song.mp3 changed. 2 published notes in Site One use it.'
			&& m.changeNoticeText(byProfile.p2) === 'song.mp3 changed. 1 published note in Site Two uses it.',
			r.notices.map(m.changeNoticeText).join(' | '));
		check('P4 the file is hashed once for all profiles', r.hashCalls.length === 1);

		r.ineligible.add(`p1:${SONG}`).add(`p2:${SONG}`);
		r.watcher.onModify(SONG);
		await settle(r);
		check('P5 no eligible profile: no notice, not hashed', r.notices.length === 2 && r.hashCalls.length === 1);

		const solo = rig();
		solo.watcher.index.record('p1', [{ notePath: 'A.md', uid: 'A', refs: [{ vaultPath: SONG, sha256: 'old' }] }]);
		solo.watcher.index.record('gone', [{ notePath: 'A.md', uid: 'A', refs: [{ vaultPath: SONG, sha256: 'old' }] }]);
		solo.cached.add(SONG); solo.hashes.set(SONG, 'new');
		solo.watcher.onModify(SONG);
		await settle(solo);
		check('P6 one profile configured: not named; a removed profile gets no notice',
			solo.notices.length === 1 && m.changeNoticeText(solo.notices[0]) === 'song.mp3 changed. 1 published note uses it.',
			solo.notices.map(m.changeNoticeText).join(' | '));
	}

	// ---------------------------------------------------------------- R
	{
		const notice: ChangeNotice = {
			profileId: 'rp', profileName: 'Site', nameProfile: false, vaultPath: SONG, fileName: 'song.mp3',
			notePaths: ['A.md', 'B.md', 'Excluded.md'],
		};
		const published: string[][] = [];
		const busy: string[] = [];
		let dismissed = 0;
		const deps = {
			lockHolder: lock.profileLockHolder,
			showBusy: (h: string) => busy.push(lock.busyMessage('Site', h)),
			resolve: async (p: string) => (p === 'Excluded.md' ? null : p),
			publish: async (files: string[]) => {
				// The real publisher takes the lock; mimic it so a nested request is refused.
				const res = await lock.withProfileLock('rp', 'publishing', async () => { published.push(files); });
				if (!res.ran) busy.push(lock.busyMessage('Site', res.heldBy));
			},
			dismiss: () => { dismissed++; },
		};

		let release!: () => void;
		const gate = new Promise<void>(res => { release = res; });
		const running = lock.withProfileLock('rp', 'publishing', () => gate);
		const refused = await m.runRepublish(notice, deps);
		check('R1 refused while a publish runs: busy notice, nothing published, change notice kept',
			refused === 'busy' && published.length === 0 && dismissed === 0
			&& busy[0] === 'Site is busy (publishing). Try again when it finishes.', `${refused} ${j(busy)} dismissed=${dismissed}`);
		release();
		await running;

		const ok = await m.runRepublish(notice, deps);
		check('R2 publishes exactly the referencing notes that still publish, in one batch',
			ok === 'published' && j(published) === j([['A.md', 'B.md']]) && dismissed === 1, `${ok} ${j(published)}`);

		const none = await m.runRepublish({ ...notice, notePaths: ['Excluded.md'] }, deps);
		check('R3 no note still publishes: nothing published', none === 'none' && published.length === 1);

		// End to end through the watcher: the notice's list is what gets published.
		const r = rig();
		r.watcher.index.record('rp', [
			{ notePath: 'A.md', uid: 'A', refs: [{ vaultPath: SONG, sha256: 'old' }] },
			{ notePath: 'Other.md', uid: 'O', refs: [{ vaultPath: PIC, sha256: 'old' }] },
		]);
		r.profiles = [{ id: 'rp', name: 'Site' }];
		r.cached.add(SONG); r.hashes.set(SONG, 'new');
		r.watcher.onModify(SONG);
		await settle(r);
		published.length = 0;
		await m.runRepublish(r.notices[0], deps);
		check('R4 the watcher\'s notice republishes only the notes using the file', j(published) === j([['A.md']]), j(published));
	}

	// ---------------------------------------------------------------- T
	{
		check('T1 wording', m.changeNoticeTail(3) === ' changed. 3 published notes use it.'
			&& m.changeNoticeTail(1) === ' changed. 1 published note uses it.'
			&& m.changeNoticeTail(2, 'Blog') === ' changed. 2 published notes in Blog use it.');
	}

	console.log(`\n${checks - failures.length}/${checks} passed`);
	if (failures.length > 0) {
		console.log(`Failed: ${failures.join(', ')}`);
		process.exit(1);
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
