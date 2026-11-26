#!/usr/bin/env npx tsx
/**
 * Attachment local-state unit test (attachment spec P2 §10, test-attachment-state.ts).
 *
 * For src/utils/attachmentState.ts, against real files in a temp directory
 * and an in-memory TextStore:
 *   1. attachments.json completeness on creation: true with an empty history;
 *      true when the probe finds nothing; false when it finds something;
 *      a failed probe still creates the file, incomplete, which keeps its refs,
 *      and a later probe of an empty bucket doesn't turn it true.
 *   2. Hash cache hit and miss on size, mtime and ctime: a rewrite that keeps
 *      size and restores mtime with utimes still misses.
 *   3. Eviction (upload mismatch, rename, delete) drops the entry.
 *   4. A write during hashing: the stat taken first no longer matches, so the
 *      next lookup re-hashes.
 *   5. The streamed hash matches crypto.subtle.digest on the same bytes.
 *   6. Two machine IDs use two cache files, and neither reads the other's.
 *  6b. Concurrent first load: the file is read once, and a lookup made while
 *      it loads waits for it, so its entry isn't overwritten by the load.
 *   7. Machine ID: reused when stored, created and saved otherwise.
 *   8. staged-attachments.json round-trip, ignoring malformed entries.
 *   9. Rebuild (P3 §3): `refs` is a union with the local file; `uploaded`
 *      equals the bucket listing, so a local entry for a key no longer in the
 *      bucket is dropped; the result is complete.
 *  10. A file created after a failed probe makes the next sweep rebuild first;
 *      a complete file never rebuilds; a failed rebuild leaves it incomplete.
 *  11. Reading the bucket (fake S3): notes/ and restricted/<g>/notes/ listed
 *      with paging, hashes already known locally aren't read, index.json is
 *      read for its `hash`, pre-feature note JSON records nothing, a note
 *      deleted between list and read is skipped.
 *
 * Run: npx tsx e2e/scripts/test-attachment-state.ts
 */

import { mkdtempSync, writeFileSync, utimesSync, statSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { webcrypto } from 'crypto';
import * as stateModule from '../../src/utils/attachmentState';
import * as s3Module from '../../src/publish/attachmentS3';
import { fakeBucket } from './fake-s3-bucket';

const st: typeof import('../../src/utils/attachmentState') =
	(stateModule as any).AttachmentHashCache ? stateModule : (stateModule as any).default;

const s3m: typeof import('../../src/publish/attachmentS3') =
	(s3Module as any).listForRebuild ? s3Module : (s3Module as any).default;

const failures: string[] = [];
let checks = 0;
function check(name: string, ok: boolean, detail: unknown = ''): void {
	checks++;
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures.push(name);
		console.log(`FAIL  ${name}${detail !== '' ? `\n        ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
	}
}

function memoryStore(): import('../../src/utils/attachmentState').TextStore & { files: Map<string, string> } {
	const files = new Map<string, string>();
	return {
		files,
		read: async p => files.get(p) ?? null,
		write: async (p, t) => { files.set(p, t); },
	};
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), 'cpn-att-state-'));
	try {
		// 1. Completeness ---------------------------------------------------------
		{
			const store = memoryStore();
			let probed = false;
			const r = await st.loadOrCreateAttachmentState(store, 'p/attachments.json', {
				historyEmpty: true, probeHasAttachments: async () => { probed = true; return true; },
			});
			check('empty history → complete, no probe', r.created && r.state?.complete === true && !probed);
			check('file exists after load (before commitPendingNotes)', store.files.has('p/attachments.json'));
		}
		{
			const store = memoryStore();
			const r = await st.loadOrCreateAttachmentState(store, 'a.json', { historyEmpty: false, probeHasAttachments: async () => false });
			check('non-empty history, probe finds nothing → complete', r.state?.complete === true);
		}
		{
			const store = memoryStore();
			const r = await st.loadOrCreateAttachmentState(store, 'a.json', { historyEmpty: false, probeHasAttachments: async () => true });
			check('probe finds an attachment in some area → incomplete', r.state?.complete === false);
		}
		{
			const store = memoryStore();
			const r = await st.loadOrCreateAttachmentState(store, 'a.json', {
				historyEmpty: false, probeHasAttachments: async () => { throw new Error('ExpiredToken'); },
			});
			check('probe fails → file still created, incomplete', r.created && r.state?.complete === false && !!r.probeError
				&& store.files.has('a.json'));
			st.recordRefs(r.state!, 'NOTEHASH', ['k2', 'k1', 'k1']);
			st.recordRefs(r.state!, 'EMPTY', []);
			await st.saveAttachmentState(store, 'a.json', r.state!);
			const again = await st.loadOrCreateAttachmentState(store, 'a.json', { historyEmpty: false, probeHasAttachments: async () => false });
			check('failed-probe file keeps its refs', JSON.stringify(again.state?.refs) === JSON.stringify({ NOTEHASH: ['k1', 'k2'] }), again.state);
			check('later probe of an empty bucket doesn\'t turn it complete', !again.created && again.state?.complete === false);
		}
		{
			const store = memoryStore();
			const r = await st.loadOrCreateAttachmentState(store, 'a.json', null);
			check('mode off and no file: nothing created', r.state === null && !store.files.has('a.json'));
			const s = st.emptyAttachmentState(true);
			st.recordUploaded(s, '', 'k');
			st.recordUploaded(s, '', 'k');
			check('recordUploaded / isUploaded', st.isUploaded(s, '', 'k') && !st.isUploaded(s, 'restricted/x/', 'k') && s.uploaded[''].length === 1);
		}

		// 2. Hash cache keys -------------------------------------------------------
		const file = join(dir, 'song.mp3');
		writeFileSync(file, 'AAAA-original-bytes');
		// Whole-second mtime, so utimes can restore it exactly below.
		utimesSync(file, 1_700_000_000, 1_700_000_000);
		const store = memoryStore();
		const cachePath = st.hashCachePath('plugin', 'machine-1');
		const cache = new st.AttachmentHashCache(store, cachePath);
		const h1 = await cache.hashOf('Media/song.mp3', file);
		const s1 = statSync(file);
		check('first lookup hashes and records the stat', !!h1 && h1.size === s1.size && cache.has('Media/song.mp3'));
		check('second lookup is a hit', cache.peek('Media/song.mp3', { size: s1.size, mtimeMs: s1.mtimeMs, ctimeMs: s1.ctimeMs }) === h1!.sha256);

		await sleep(20);
		const before = statSync(file);
		writeFileSync(file, 'BBBB-original-bytes'); // same size
		utimesSync(file, before.atime, before.mtime); // restore mtime
		const s2 = statSync(file);
		check('tag-editor rewrite keeps size and mtime', s2.size === before.size && s2.mtimeMs === before.mtimeMs, { s2: s2.mtimeMs, before: before.mtimeMs });
		check('…but ctime moved, so the cache misses', cache.peek('Media/song.mp3', { size: s2.size, mtimeMs: s2.mtimeMs, ctimeMs: s2.ctimeMs }) === null);
		const h2 = await cache.hashOf('Media/song.mp3', file);
		check('…and the re-hash sees the new bytes', h2!.sha256 !== h1!.sha256);
		check('size mismatch misses', cache.peek('Media/song.mp3', { size: s2.size + 1, mtimeMs: s2.mtimeMs, ctimeMs: s2.ctimeMs }) === null);
		check('mtime mismatch misses', cache.peek('Media/song.mp3', { size: s2.size, mtimeMs: s2.mtimeMs + 1, ctimeMs: s2.ctimeMs }) === null);

		// 3. Eviction ----------------------------------------------------------------
		cache.evict('Media/song.mp3');
		check('eviction on an upload mismatch drops the entry', !cache.has('Media/song.mp3'));
		await cache.hashOf('Media/song.mp3', file);
		cache.evict('Media/song.mp3'); // rename: old path
		check('rename drops the old path', !cache.has('Media/song.mp3'));
		await cache.hashOf('Media/song.mp3', file);
		cache.evict('Media/song.mp3'); // delete
		check('delete drops the path', !cache.has('Media/song.mp3'));
		check('missing file → null and evicted', (await cache.hashOf('Media/nope.mp3', join(dir, 'nope.mp3'))) === null);

		// 4. Write during hashing --------------------------------------------------
		{
			const big = join(dir, 'big.wav');
			writeFileSync(big, Buffer.alloc(4 * 1024 * 1024, 1));
			const c = new st.AttachmentHashCache(memoryStore(), 'c.json');
			const pending = c.hashOf('big.wav', big);
			await sleep(1);
			writeFileSync(big, Buffer.alloc(4 * 1024 * 1024, 2));
			const torn = await pending;
			const now = statSync(big);
			const hit = c.peek('big.wav', { size: now.size, mtimeMs: now.mtimeMs, ctimeMs: now.ctimeMs });
			check('write during hashing: recorded stat no longer matches', hit === null, { torn: torn?.ctime, now: now.ctimeMs });
			const fresh = await c.hashOf('big.wav', big);
			const expected = Buffer.from(await webcrypto.subtle.digest('SHA-256', readFileSync(big))).toString('hex');
			check('…so the next lookup re-hashes the final bytes', fresh!.sha256 === expected);
		}

		// 5. Streamed hash = subtle.digest ---------------------------------------------
		{
			const p = join(dir, 'blob.bin');
			const bytes = Buffer.alloc(3 * 1024 * 1024 + 17);
			for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
			writeFileSync(p, bytes);
			const streamed = await st.hashFileStream(p);
			const digest = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
			check('streamed hash matches crypto.subtle.digest', streamed === digest);
		}

		// 6. Two machines -------------------------------------------------------------
		{
			const shared = memoryStore();
			const m1 = new st.AttachmentHashCache(shared, st.hashCachePath('plugin', 'm1'));
			const m2 = new st.AttachmentHashCache(shared, st.hashCachePath('plugin', 'm2'));
			await m1.hashOf('Media/song.mp3', file);
			await m1.save();
			await m2.load();
			check('two machine IDs → two cache files', st.hashCachePath('plugin', 'm1') !== st.hashCachePath('plugin', 'm2')
				&& shared.files.has('plugin/attachment-hash-cache.m1.json'));
			check('machine 2 doesn\'t read machine 1\'s entries', !m2.has('Media/song.mp3'));
			await m2.hashOf('Media/other.mp3', file);
			await m2.save();
			const m1again = new st.AttachmentHashCache(shared, st.hashCachePath('plugin', 'm1'));
			await m1again.load();
			check('…and machine 1 doesn\'t read machine 2\'s', m1again.has('Media/song.mp3') && !m1again.has('Media/other.mp3'));
		}

		// 6b. Concurrent first load ---------------------------------------------------
		{
			const slow = memoryStore();
			const slowPath = 'plugin/attachment-hash-cache.slow.json';
			slow.files.set(slowPath, JSON.stringify({ 'Media/known.mp3': { size: 1, mtime: 1, ctime: 1, sha256: 'k' } }));
			let reads = 0;
			const read = slow.read;
			slow.read = async p => { reads++; await sleep(50); return read(p); };
			const c = new st.AttachmentHashCache(slow, slowPath);
			const [, hashed] = await Promise.all([c.load(), c.hashOf('Media/song.mp3', file), c.load()]);
			check('concurrent first load reads the file once', reads === 1, reads);
			check('a lookup during the first load keeps its entry', !!hashed && c.has('Media/song.mp3'));
			check('…and the loaded entries are there too', c.has('Media/known.mp3'));
		}

		// 7. Machine ID -----------------------------------------------------------------
		{
			const ls = new Map<string, unknown>();
			const id1 = st.getOrCreateMachineId(k => ls.get(k), (k, v) => ls.set(k, v), () => 'a1b2c3d4-0000-4000-8000-000000000001');
			const id2 = st.getOrCreateMachineId(k => ls.get(k), (k, v) => ls.set(k, v), () => 'never-used-0000');
			check('machine ID created once, then reused', id1 === id2 && ls.get(st.MACHINE_ID_KEY) === id1);
			ls.set(st.MACHINE_ID_KEY, '../../etc');
			const id3 = st.getOrCreateMachineId(k => ls.get(k), (k, v) => ls.set(k, v), () => 'fresh-id-12345678');
			check('a malformed stored ID is replaced', id3 === 'fresh-id-12345678');
		}

		// 8. staged-attachments.json ------------------------------------------------------
		{
			const s = memoryStore();
			const entry = { area: '', key: 'k', vaultPath: 'M/a.mp3', sha256: 'h', fileName: 'a.mp3', size: 1 };
			await st.saveStagedAttachments(s, 'staged.json', [entry]);
			check('staged round-trip', JSON.stringify(await st.loadStagedAttachments(s, 'staged.json')) === JSON.stringify([entry]));
			s.files.set('bad.json', JSON.stringify([entry, { area: 1 }, null]));
			check('malformed staged entries ignored', (await st.loadStagedAttachments(s, 'bad.json')).length === 1);
			check('missing staged file → []', (await st.loadStagedAttachments(s, 'none.json')).length === 0);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	// 9. Rebuild merge (P3 §3) -------------------------------------------------
	{
		const k = (c: string, n: string) => `${c.repeat(64)}/${n}`;
		const local = st.emptyAttachmentState(false);
		local.refs = { h1: [k('a', 'x.mp3')], h2: [k('b', 'y.png')] };
		local.uploaded = { '': [k('a', 'x.mp3'), k('z', 'gone.pdf')], 'restricted/old/': [k('b', 'y.png')] };
		const bucket = {
			refs: { h2: [k('b', 'y.png')], h3: [k('c', 'z.wav')] },
			uploaded: { '': [k('a', 'x.mp3')], 'restricted/fam/': [k('c', 'z.wav')] },
		};
		const merged = st.mergeRebuiltState(local, bucket);
		check('rebuild: refs is the union of local and bucket',
			JSON.stringify(Object.keys(merged.refs).sort()) === '["h1","h2","h3"]' && JSON.stringify(merged.refs.h2) === JSON.stringify([k('b', 'y.png')]), merged.refs);
		check('rebuild: uploaded equals the bucket listing (local-only key and area dropped)',
			JSON.stringify(merged.uploaded) === JSON.stringify(bucket.uploaded), merged.uploaded);
		check('rebuild: result is complete', merged.complete === true);
		check('rebuild: no local file still works', JSON.stringify(st.mergeRebuiltState(null, bucket).refs) === JSON.stringify(bucket.refs));
	}

	// 10. Failed probe → rebuild at the next sweep ------------------------------
	{
		const store = memoryStore();
		const created = await st.loadOrCreateAttachmentState(store, 'a.json', {
			historyEmpty: false, probeHasAttachments: async () => { throw new Error('offline'); },
		});
		const state = created.state!;
		st.recordRefs(state, 'mine', ['m'.repeat(64) + '/mine.mp3']);
		let rebuilds = 0;
		const failing = await st.ensureCompleteState(store, 'a.json', state, async () => { rebuilds++; throw new Error('still offline'); })
			.then(() => 'resolved', (e: Error) => e.message);
		check('failed rebuild: throws, file stays incomplete', failing === 'still offline' && state.complete === false && rebuilds === 1);
		const r = await st.ensureCompleteState(store, 'a.json', state, async () => {
			rebuilds++;
			return { refs: { theirs: ['t'.repeat(64) + '/t.png'] }, uploaded: { '': ['t'.repeat(64) + '/t.png'] } };
		});
		check('file created after a failed probe: the next sweep rebuilds first', r.rebuilt && rebuilds === 2 && state.complete === true);
		check('…keeping this publish’s refs and adding the bucket’s', 'mine' in state.refs && 'theirs' in state.refs, state.refs);
		check('…and saving the rebuilt file', JSON.parse(store.files.get('a.json')!).complete === true);
		const again = await st.ensureCompleteState(store, 'a.json', state, async () => { rebuilds++; return { refs: {}, uploaded: {} }; });
		check('a complete file never rebuilds', !again.rebuilt && rebuilds === 2);
	}

	// 11. Reading the bucket ---------------------------------------------------
	{
		const P = 'pre/';
		const att = (c: string, n: string) => `${c.repeat(64)}/${n}`;
		const nj = (hash: string, keys: string[] | null) => JSON.stringify({ hash, ...(keys ? { attachments: keys.map(key => ({ key, name: key.slice(65), size: 1 })) } : {}) });
		const bucket = fakeBucket({
			[`${P}notes/h1.json`]: nj('h1', [att('a', 'x.mp3')]),
			[`${P}notes/h2.json`]: nj('h2', null),                    // pre-feature revision
			[`${P}notes/known.json`]: nj('known', [att('k', 'k.png')]),
			[`${P}notes/index.json`]: nj('h1', [att('a', 'x.mp3')]),  // home copy
			[`${P}notes/sub/odd.json`]: nj('odd', [att('o', 'o.png')]),
			[`${P}restricted/fam/notes/h3.json`]: nj('h3', [att('c', 'z.wav'), 'not-a-key']),
			[`${P}restricted/fam/notes/h1.json`]: nj('h1', [att('a', 'x.mp3')]),
			[`${P}restricted/fam/attachments/${att('c', 'z.wav')}`]: 'bytes',
			[`${P}restricted/fam/static/mapping/uid-to-hash.json`]: '{}',
			[`${P}restricted/empty/static/mapping/uid-to-hash.json`]: '{}',
			[`${P}attachments/${att('a', 'x.mp3')}`]: 'bytes',
			[`${P}attachments/${att('q', 'stray.pdf')}`]: 'bytes',
			[`other/attachments/${att('w', 'w.png')}`]: 'bytes',
		});
		const listed = await s3m.listForRebuild(bucket, 'b', P, new Set(['known']));
		const hashes = listed.notes.map(n => n.hash);
		check('rebuild listing: one read per hash, known hashes skipped, index.json read for its hash',
			JSON.stringify(hashes) === JSON.stringify(['h1', 'h2', 'h3', null]), listed.notes);
		check('rebuild listing: nested keys under notes/ ignored', !hashes.includes('odd'));
		check('rebuild listing: uploaded from every area’s attachments/, other prefixes ignored',
			JSON.stringify(listed.uploaded) === JSON.stringify({ '': [att('a', 'x.mp3'), att('q', 'stray.pdf')], 'restricted/fam/': [att('c', 'z.wav')] }), listed.uploaded);
		const reads = await Promise.all(listed.notes.map(n => s3m.readNoteAttachments(bucket, 'b', n)));
		check('read: attachments keys under the note hash', JSON.stringify(reads[0]) === JSON.stringify({ hash: 'h1', keys: [att('a', 'x.mp3')] }), reads[0]);
		check('read: pre-feature note JSON records nothing', reads[1]?.keys.length === 0);
		check('read: malformed keys dropped', JSON.stringify(reads[2]?.keys) === JSON.stringify([att('c', 'z.wav')]), reads[2]);
		check('read: index.json uses its hash field', reads[3]?.hash === 'h1');
		bucket.store.delete(`${P}notes/h2.json`);
		check('read: a note deleted between list and read is skipped', await s3m.readNoteAttachments(bucket, 'b', { key: `${P}notes/h2.json`, hash: 'h2' }) === null);
		const areas = await s3m.listAreas(bucket, 'b', P);
		check('areas: public plus each restricted/<g>/', JSON.stringify(areas) === JSON.stringify(['', 'restricted/empty/', 'restricted/fam/']), areas);
		const failing = fakeBucket({}, { failCommand: 'ListObjectsV2Command' });
		const err = await s3m.listForRebuild(failing, 'b', P, new Set()).then(() => null, (e: Error) => e.message);
		check('rebuild listing: a failed list throws (the sweep then skips its deletes)', err === 'ListObjectsV2Command failed');
	}

	console.log('');
	if (failures.length === 0) {
		console.log(`All ${checks} attachment-state checks passed.`);
		process.exit(0);
	}
	console.log(`${failures.length}/${checks} attachment-state checks FAILED.`);
	process.exit(1);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
