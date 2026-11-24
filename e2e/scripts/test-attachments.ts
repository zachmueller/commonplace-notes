#!/usr/bin/env npx tsx
/**
 * Attachment rules unit test (attachment spec P2 §10, test-attachments.ts).
 *
 * For the pure module src/utils/attachments.ts:
 *   1. Settings defaults and the reference filter: mode, extensions, `*`,
 *      files without an extension, user-added types (html, canvas), excluded
 *      directories, size.
 *   2. Kind, MIME and disposition maps; RFC 5987 file names.
 *   3. Every active type maps to octet-stream + attachment even when allowed;
 *      svg gets attachment.
 *   4. Cache-Control per area and read gate.
 *   5. Keys for odd file names.
 *   6. The ::att= segment: order-independent, de-duplicated, absent with no refs;
 *      the note JSON list.
 *   7. Staged-entry merge across a failed batch.
 *   8. Re-check before upload: settings/vault drops, and hash mismatches
 *      (earlier batch dropped, this batch stops, then dropped next publish).
 *   9. The updated-since rule (§8).
 *  10. The large-file limiter: five queued, at most two at once.
 *
 * Run: npx tsx e2e/scripts/test-attachments.ts
 */

import * as attModule from '../../src/utils/attachments';
import * as exclModule from '../../src/utils/excludedDirectories';

const att: typeof import('../../src/utils/attachments') =
	(attModule as any).attachmentKind ? attModule : (attModule as any).default;
const compileExcludePatterns: typeof import('../../src/utils/excludedDirectories').compileExcludePatterns =
	(exclModule as any).compileExcludePatterns ?? (exclModule as any).default?.compileExcludePatterns;

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

const H = (c: string) => c.repeat(64);
const MB = 1024 * 1024;

async function main(): Promise<void> {
	// 1. Settings and filter -------------------------------------------------
	const defaults = att.resolveAttachmentSettings(undefined);
	check('absent settings ≡ off', defaults.mode === 'off');
	check('default cap 50 MB', defaults.maxFileSizeMB === 50);
	check('default allow-list', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'mp4', 'm4v', 'webm', 'mov', 'pdf']
		.every(e => defaults.allowedExtensions.includes(e)) && defaults.allowedExtensions.length === 20, defaults.allowedExtensions);
	check('cap clamps to 1–500', att.clampFileSizeMB(0) === 1 && att.clampFileSizeMB(900) === 500 && att.clampFileSizeMB('x') === 50);
	check('unknown mode → off', att.resolveAttachmentSettings({ mode: 'bogus' as any }).mode === 'off');
	check('parseExtensionList: spaces, commas, dots, case, dupes',
		JSON.stringify(att.parseExtensionList(' .PNG, mp3  html,png ,')) === JSON.stringify(['png', 'mp3', 'html']),
		att.parseExtensionList(' .PNG, mp3  html,png ,'));

	const on = att.resolveAttachmentSettings({ mode: 'embeds', allowedExtensions: ['png', 'mp3', 'html', 'canvas'], maxFileSizeMB: 10 });
	const excl = compileExcludePatterns(['**/private/', 'Archive/']);
	const f = (path: string, size = 1000) => att.filterAttachment({ path, ext: att.extensionOf(path), size }, on, excl);
	check('allowed ext ok', f('Media/a.png') === 'ok');
	check('ext case-insensitive', f('Media/A.PNG') === 'ok');
	check('not allowed ext', f('Media/a.zip') === 'extension');
	check('user-added html allowed', f('Media/page.html') === 'ok');
	check('user-added canvas allowed', f('Boards/x.canvas') === 'ok');
	check('markdown is a note, never an attachment', f('Notes/a.md') === 'markdown');
	check('no extension refused without *', f('Media/README') === 'extension');
	check('excluded anywhere (**/private/)', f('Projects/private/a.mp3') === 'excluded');
	check('excluded from root (Archive/)', f('Archive/a.mp3') === 'excluded' && f('Media/Archive/a.mp3') === 'ok');
	check('over cap', f('Media/big.mp3', 10 * MB + 1) === 'size');
	check('at cap ok', f('Media/big.mp3', 10 * MB) === 'ok');
	const all = att.resolveAttachmentSettings({ mode: 'embeds', allowedExtensions: ['*'], maxFileSizeMB: 10 });
	check('* allows any ext', att.filterAttachment({ path: 'a.zip', ext: 'zip', size: 1 }, all, () => false) === 'ok');
	check('* allows files without an extension', att.filterAttachment({ path: 'LICENSE', ext: '', size: 1 }, all, () => false) === 'ok');
	check('* still excludes markdown', att.filterAttachment({ path: 'a.md', ext: 'md', size: 1 }, all, () => false) === 'markdown');
	check('extensionOf: dotfile and nested dots', att.extensionOf('a/.hidden') === '' && att.extensionOf('a/b.tar.GZ') === 'gz' && att.extensionOf('x.y/z') === '');

	// 2. Kind / MIME / disposition --------------------------------------------
	check('kinds', att.attachmentKind('PNG') === 'image' && att.attachmentKind('svg') === 'image'
		&& att.attachmentKind('opus') === 'audio' && att.attachmentKind('mov') === 'video'
		&& att.attachmentKind('pdf') === 'file' && att.attachmentKind('canvas') === 'file' && att.attachmentKind('') === 'file');
	const mime: Record<string, string> = {
		png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
		svg: 'image/svg+xml', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg',
		opus: 'audio/opus', wav: 'audio/wav', flac: 'audio/flac', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
		mov: 'video/quicktime', pdf: 'application/pdf', zip: 'application/octet-stream', '': 'application/octet-stream',
	};
	const badMime = Object.entries(mime).filter(([e, t]) => att.contentTypeFor(e) !== t);
	check('MIME map', badMime.length === 0, badMime);
	check('pdf inline', att.contentDispositionFor('pdf', 'slides.pdf') === "inline; filename*=UTF-8''slides.pdf");
	check('mp3 inline', att.contentDispositionFor('mp3', 'a.mp3').startsWith('inline;'));
	check('unmapped downloads', att.contentDispositionFor('zip', 'a.zip').startsWith('attachment;'));
	check('RFC 5987 encoding', att.rfc5987FileName("my song (v2)'s #1?.mp3") === "UTF-8''my%20song%20%28v2%29%27s%20%231%3F.mp3",
		att.rfc5987FileName("my song (v2)'s #1?.mp3"));
	check('RFC 5987 Unicode', att.rfc5987FileName('café ♪.mp3') === "UTF-8''caf%C3%A9%20%E2%99%AA.mp3", att.rfc5987FileName('café ♪.mp3'));

	// 3. Active types ----------------------------------------------------------
	const active = ['html', 'htm', 'xhtml', 'xht', 'xml', 'xsl', 'xslt', 'js', 'mjs', 'cjs', 'wasm'];
	const activeBad = active.filter(e => att.contentTypeFor(e) !== att.OCTET_STREAM
		|| !att.contentDispositionFor(e, `x.${e}`).startsWith('attachment;')
		|| !att.ACTIVE_EXTENSIONS.includes(e));
	check('every active type → octet-stream + attachment', activeBad.length === 0, activeBad);
	check('active types case-insensitive', att.contentTypeFor('HTML') === att.OCTET_STREAM);
	check('active types stay so even when allowed', att.filterAttachment({ path: 'p.html', ext: 'html', size: 1 }, on, () => false) === 'ok'
		&& att.contentTypeFor('html') === att.OCTET_STREAM);
	check('svg downloads when opened directly', att.contentDispositionFor('svg', 'a.svg').startsWith('attachment;')
		&& att.contentTypeFor('svg') === 'image/svg+xml');

	// 4. Cache-Control ----------------------------------------------------------
	check('public site public area', att.attachmentCacheControl('', 'none', 12) === 'public, max-age=31536000, immutable');
	check('whole-site gate public area', ['cognito', 'password', 'byo'].every(g =>
		att.attachmentCacheControl('', g as any, 12) === 'private, max-age=31536000, immutable'));
	check('restricted area: one session', att.attachmentCacheControl('restricted/fam/', 'none', 12) === 'private, max-age=43200, immutable'
		&& att.attachmentCacheControl('restricted/fam/', 'cognito', 1) === 'private, max-age=3600, immutable');

	// 5. Keys -------------------------------------------------------------------
	const odd = 'a "b" <c> & #d ?e %f ü.mp3';
	const key = att.attachmentKey(H('a'), odd);
	check('key = <sha>/<fileName>', key === `${H('a')}/${odd}`);
	check('object key public', att.attachmentObjectKey('site/', '', key) === `site/attachments/${key}`);
	check('object key restricted', att.attachmentObjectKey('', 'restricted/fam/', key) === `restricted/fam/attachments/${key}`);
	const parsed = att.parseAttachmentKey(key);
	check('parseAttachmentKey round-trips odd names', parsed?.sha256 === H('a') && parsed?.fileName === odd, parsed);
	check('parseAttachmentKey rejects non-keys', att.parseAttachmentKey('abc/x.png') === null);

	// 6. Hash segment + note JSON -------------------------------------------------
	const r = (sha: string, fileName: string, size = 10): any => ({ sha256: sha, fileName, size, vaultPath: `M/${fileName}`, ext: 'mp3', mtime: 0, ctime: 0, kind: 'audio' });
	const refsA = [r(H('b'), 'b.mp3'), r(H('a'), 'a.mp3'), r(H('b'), 'b.mp3')];
	const refsB = [r(H('a'), 'a.mp3'), r(H('b'), 'b.mp3')];
	check('::att= order-independent and de-duplicated', att.attachmentHashSegment(refsA) === att.attachmentHashSegment(refsB)
		&& att.attachmentHashSegment(refsB) === `::att=${H('a')}/a.mp3,${H('b')}/b.mp3`, att.attachmentHashSegment(refsA));
	check('::att= absent without refs', att.attachmentHashSegment([]) === '');
	check('::att= distinguishes names over the same bytes', att.attachmentHashSegment([r(H('a'), 'x.mp3')]) !== att.attachmentHashSegment([r(H('a'), 'y.mp3')]));
	const nj = att.noteJsonAttachments(refsA);
	check('note JSON list sorted, de-duplicated', JSON.stringify(nj) === JSON.stringify([
		{ key: `${H('a')}/a.mp3`, name: 'a.mp3', size: 10 }, { key: `${H('b')}/b.mp3`, name: 'b.mp3', size: 10 }]), nj);
	check('note JSON list null when empty', att.noteJsonAttachments([]) === null);

	// 7. Staged-entry merge ------------------------------------------------------
	const se = (area: string, sha: string, name: string, vaultPath = `M/${name}`): any =>
		({ area, key: att.attachmentKey(sha, name), vaultPath, sha256: sha, fileName: name, size: 10 });
	const earlier = [se('', H('a'), 'a.mp3'), se('restricted/fam/', H('a'), 'a.mp3'), se('', H('c'), 'c.png')];
	const added = [se('', H('a'), 'a.mp3'), se('', H('d'), 'd.png')];
	const { merged, thisBatch } = att.mergeStagedAttachments(earlier, added);
	check('merge keeps earlier entries and adds new ones', merged.length === 4, merged.map((m: any) => m.area + m.fileName));
	check('merge keys by area + key', merged.filter((m: any) => m.key === att.attachmentKey(H('a'), 'a.mp3')).length === 2);
	check('thisBatch holds staged and merged-into ids', thisBatch.size === 2
		&& thisBatch.has(att.stagedId(se('', H('a'), 'a.mp3'))) && !thisBatch.has(att.stagedId(se('', H('c'), 'c.png'))));
	const forNote = att.stagedEntriesFor(['', 'restricted/fam/'], refsA);
	check('stagedEntriesFor: each key in each area, once', forNote.length === 4, forNote);

	// 8. Re-check ------------------------------------------------------------------
	type VaultFile = { size: number; sha: string };
	const runRecheck = (entries: any[], settings: any, vault: Record<string, VaultFile>, excluded: string[] = [], batch = new Set<string>()) =>
		att.recheckStagedAttachments(entries, {
			settings,
			isExcluded: compileExcludePatterns(excluded),
			sizeOf: async p => vault[p]?.size ?? null,
			currentHash: async p => vault[p].sha,
			thisBatch: batch,
		});
	const s10 = att.resolveAttachmentSettings({ mode: 'embeds', allowedExtensions: ['mp3', 'png', 'wav', 'pdf'], maxFileSizeMB: 10 });
	const vault: Record<string, VaultFile> = {
		'Media/a.mp3': { size: 10, sha: H('a') },
		'Takes/take1.wav': { size: 10, sha: H('1') },
		'Media/c.png': { size: 20 * MB, sha: H('c') },
		'Docs/scan.pdf': { size: 10, sha: H('5') },
	};
	const entries = [
		se('', H('a'), 'a.mp3', 'Media/a.mp3'),
		se('', H('1'), 'take1.wav', 'Takes/take1.wav'),
		se('', H('c'), 'c.png', 'Media/c.png'),
		se('', H('5'), 'scan.pdf', 'Docs/scan.pdf'),
		se('', H('9'), 'gone.mp3', 'Media/gone.mp3'),
	];
	const rc = await runRecheck(entries, { ...s10, allowedExtensions: ['mp3', 'png', 'wav'] }, vault, ['Takes/']);
	const reasons = Object.fromEntries(rc.dropped.map(d => [d.entry.fileName, d.reason]));
	check('re-check: folder excluded after staging → dropped', reasons['take1.wav'] === 'excluded', reasons);
	check('re-check: extension removed → dropped', reasons['scan.pdf'] === 'extension', reasons);
	check('re-check: over a lowered cap → dropped', reasons['c.png'] === 'size', reasons);
	check('re-check: moved or deleted → dropped', reasons['gone.mp3'] === 'missing', reasons);
	check('re-check: passing entry kept', rc.keep.length === 1 && rc.keep[0].fileName === 'a.mp3' && rc.stop === null);
	const offRc = await runRecheck(entries.slice(0, 1), { ...s10, mode: 'off' }, vault);
	check('re-check: mode off → dropped', offRc.keep.length === 0 && offRc.dropped[0]?.reason === 'mode-off');

	const changedVault = { ...vault, 'Media/a.mp3': { size: 10, sha: H('e') } };
	const a = entries[0];
	const earlierRc = await runRecheck([a, entries[3]], s10, changedVault);
	check('hash: earlier batch entry changed → dropped, publish continues',
		earlierRc.stop === null && earlierRc.dropped[0]?.reason === 'changed' && earlierRc.keep.length === 1, earlierRc);
	const ours = new Set([att.stagedId(a)]);
	const thisRc = await runRecheck([a, entries[3]], s10, changedVault, [], ours);
	check('hash: this batch entry changed → stop', thisRc.stop?.fileName === 'a.mp3', thisRc);
	const nextRc = await runRecheck([a], s10, changedVault, [], new Set());
	check('hash: same entry on the next publish → dropped, not stopped', nextRc.stop === null && nextRc.dropped[0]?.reason === 'changed');
	const { thisBatch: mergedBatch } = att.mergeStagedAttachments([a], [a]);
	const mergedRc = await runRecheck([a], s10, changedVault, [], mergedBatch);
	check('hash: earlier entry this batch merged into counts as this batch', mergedRc.stop?.fileName === 'a.mp3');
	let hashCalls = 0;
	await att.recheckStagedAttachments([a, { ...a, area: 'restricted/x/' }], {
		settings: s10, isExcluded: () => false, sizeOf: async () => 10,
		currentHash: async () => { hashCalls++; return H('a'); }, thisBatch: new Set(),
	});
	check('re-check hashes a vault path once across areas', hashCalls === 1, hashCalls);

	// 9. Updated-since ---------------------------------------------------------------
	check('ctime after timestamp counts as changed', att.changedSince({ mtimeMs: 100, ctimeMs: 300 }, 200));
	check('mtime after timestamp counts as changed', att.changedSince({ mtimeMs: 300, ctimeMs: 100 }, 200));
	check('both before → unchanged', !att.changedSince({ mtimeMs: 100, ctimeMs: 150 }, 200));

	// 10. Limiter ---------------------------------------------------------------------
	const limit = att.createLimiter(2);
	let active2 = 0;
	let peak = 0;
	const order: number[] = [];
	await Promise.all([0, 1, 2, 3, 4].map(i => limit(async () => {
		active2++;
		peak = Math.max(peak, active2);
		await new Promise(res => setTimeout(res, 5 + (i % 2) * 5));
		order.push(i);
		active2--;
	})));
	check('limiter: five large files, at most two mid-upload', peak === 2 && order.length === 5, { peak, order });
	const limit1 = att.createLimiter(1);
	let errAfter = false;
	await limit1(async () => { throw new Error('x'); }).catch(() => undefined);
	await limit1(async () => { errAfter = true; });
	check('limiter frees its slot after a throw', errAfter);

	console.log('');
	if (failures.length === 0) {
		console.log(`All ${checks} attachment checks passed.`);
		process.exit(0);
	}
	console.log(`${failures.length}/${checks} attachment checks FAILED.`);
	process.exit(1);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
