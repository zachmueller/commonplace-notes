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
 *   7. Machine ID: reused when stored, created and saved otherwise.
 *   8. staged-attachments.json round-trip, ignoring malformed entries.
 *
 * Run: npx tsx e2e/scripts/test-attachment-state.ts
 */

import { mkdtempSync, writeFileSync, utimesSync, statSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { webcrypto } from 'crypto';
import * as stateModule from '../../src/utils/attachmentState';

const st: typeof import('../../src/utils/attachmentState') =
	(stateModule as any).AttachmentHashCache ? stateModule : (stateModule as any).default;

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
