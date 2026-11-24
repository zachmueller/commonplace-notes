#!/usr/bin/env npx tsx
/**
 * Excluded-Directories Unit Test
 *
 * Exercises the pure matcher behind Publisher.isFileExcluded
 * (src/utils/excludedDirectories.ts): root-anchored folder patterns with `*`
 * and `**`, case-insensitive, never matching file names; and the one-time
 * upgrade that appends `**\/<entry>/` and `<entry>*\/` for slashless entries so
 * every folder the old rule excluded stays excluded.
 *
 * Run: npx tsx e2e/scripts/test-excluded-directories.ts
 */

import * as excludedModule from '../../src/utils/excludedDirectories';

// Under tsx's ESM/CJS interop, named exports from src/ modules can land under
// `.default` (see test-obscure-wikilinks.ts).
const mod: typeof import('../../src/utils/excludedDirectories') =
	(excludedModule as any).compileExcludePatterns ? excludedModule : (excludedModule as any).default;
const { compileExcludePatterns, upgradeExcludedDirectories, findNoLongerExcluded, legacyIsExcluded } = mod;

const failures: string[] = [];
let checks = 0;

function check(cond: boolean, msg: string): void {
	checks++;
	if (!cond) failures.push(msg);
}

/** `lines` excludes every path in `yes` and none in `no`. */
function expectMatches(lines: string[], yes: string[], no: string[]): void {
	const isExcluded = compileExcludePatterns(lines);
	for (const p of yes) check(isExcluded(p), `${JSON.stringify(lines)} should exclude ${p}`);
	for (const p of no) check(!isExcluded(p), `${JSON.stringify(lines)} should not exclude ${p}`);
}

function sameList(got: string[], want: string[], what: string): void {
	check(JSON.stringify(got) === JSON.stringify(want), `${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// --- Rules -----------------------------------------------------------------

// Rules 1–3: `private/`, `private` and `/private` name one root folder.
for (const entry of ['private/', 'private', '/private']) {
	expectMatches([entry],
		['private/a.mp3', 'private/x/a.md'],
		['Projects/private/a.mp3', 'privateer/a.mp3', 'private.md']);
}

expectMatches(['Projects/private/'],
	['Projects/private/a.mp3', 'Projects/private/2024/x.mp3'],
	['private/a.mp3', 'Projects/privateer/a.mp3', 'Other/Projects/private/a.mp3', 'Projects/a.mp3']);

// Rule 5: `**` at any depth, including zero folders.
expectMatches(['**/private/'],
	['private/a.md', 'a/private/b.md', 'a/b/private/c.md', 'a/private/x/y.md'],
	['a/privateer/b.md', 'privateer/a.md', 'private.md', 'a/private.md']);

// Rule 4: `*` within a segment.
expectMatches(['*-private/'],
	['work-private/a.md', '-private/a.md'],
	['work-private.md', 'a/work-private/b.md', 'work-privateer/a.md']);
expectMatches(['Projects/*/drafts/'],
	['Projects/alpha/drafts/a.md', 'Projects/beta/drafts/x/y.md'],
	['Projects/drafts/a.md', 'Projects/a/b/drafts/c.md', 'Projects/alpha/a.md']);

// Rule 5: `**` in the middle, zero and several folders.
expectMatches(['Archive/**/raw/'],
	['Archive/raw/a.wav', 'Archive/2024/raw/a.wav', 'Archive/2024/05/raw/a.wav'],
	['raw/a.wav', 'Other/Archive/raw/a.wav', 'Archive/2024/rawer/a.wav']);

// Rule 5: `**` inside a longer segment is `*`.
expectMatches(['a**b/'], ['ab/x.md', 'axxb/x.md'], ['a/b/x.md', 'a/c/b/x.md']);

// Rule 1: trimming, empty lines, `./`.
expectMatches(['private/ '], ['private/a.md'], ['privateer/a.md']);
expectMatches([' private/'], ['private/a.md'], ['privateer/a.md']);
expectMatches(['', '   ', '\t'], [], ['private/a.md', 'a.md', 'a/b.md']);
expectMatches(['./private/'], ['private/a.md'], ['Projects/private/a.md']);

// Rule 6: case-insensitive.
expectMatches(['Private/'], ['private/a.md', 'PRIVATE/a.md'], []);
expectMatches(['**/Drafts/'], ['a/drafts/b.md'], []);

// Rule 7: other characters are literal.
expectMatches(['what?/'], ['what?/a.md'], ['whatx/a.md', 'what/a.md']);
expectMatches(['[draft]/'], ['[draft]/a.md'], ['d/a.md', 'draft/a.md']);
expectMatches(['{a,b}/'], ['{a,b}/x.md'], ['a/x.md', 'b/x.md']);
expectMatches(['a.b/'], ['a.b/x.md'], ['axb/x.md']);
expectMatches(['a+(b)/'], ['a+(b)/x.md'], ['aab/x.md']);

// Rule 8: patterns never match file names.
expectMatches(['**/*.wav'], ['a/b.wav/c.wav'], ['a/b.wav', 'b.wav', 'x/y/z.wav']);
expectMatches(['notes.md'], ['notes.md/a.md'], ['notes.md']);

// --- Upgrade ---------------------------------------------------------------

{
	const up = upgradeExcludedDirectories(['private']);
	sameList(up.added, ['**/private/', 'private*/'], 'private gains');
	sameList(up.entries, ['private', '**/private/', 'private*/'], 'private entries');
	// What the old rule excluded stays excluded, including folders created after the upgrade.
	expectMatches(up.entries,
		['private/a.md', 'Projects/private/a.md', 'privateer/a.md', 'a/b/private/c.md', 'private-later/x.md'],
		['private.md', 'Projects/privateer/a.md']);
}
{
	const up = upgradeExcludedDirectories(['Projects/private']);
	sameList(up.added, ['**/Projects/private/', 'Projects/private*/'], 'Projects/private gains');
	expectMatches(up.entries,
		['Projects/private/a.md', 'x/Projects/private/a.md', 'Projects/privateer/a.md'],
		['Projects/private.md', 'private/a.md']);
}
sameList(upgradeExcludedDirectories(['/private']).added, ['**/private/', 'private*/'], '/private gains (no **//)');
sameList(upgradeExcludedDirectories(['./private']).added, ['**/private/', 'private*/'], './private gains');
sameList(upgradeExcludedDirectories(['private/']).added, [], 'private/ gains nothing');
sameList(upgradeExcludedDirectories(['private/ ']).added, [], '"private/ " gains nothing');
sameList(upgradeExcludedDirectories(['private ']).added, ['**/private/', 'private*/'], '"private " is trimmed');
sameList(upgradeExcludedDirectories([]).added, [], 'empty list gains nothing');

// Patterns already in the list aren't added twice.
{
	const up = upgradeExcludedDirectories(['private', '**/private/']);
	sameList(up.added, ['private*/'], 'existing pattern skipped');
	sameList(up.entries, ['private', '**/private/', 'private*/'], 'existing pattern entries');
	const dup = upgradeExcludedDirectories(['private', 'private/']);
	sameList(dup.added, ['**/private/', 'private*/'], 'private + private/');
	const twice = upgradeExcludedDirectories(['private', '/private']);
	sameList(twice.added, ['**/private/', 'private*/'], 'two spellings add once');
}

// Step 2: only root private.md is reported as no longer excluded.
{
	const vault = [
		'private.md', 'private/a.md', 'Projects/private/a.mp3', 'privateer/a.md',
		'Projects/private.md', 'notes/a.md', 'private-notes.md', 'readme.md'
	];
	const old = ['private'];
	const up = upgradeExcludedDirectories(old);
	const lost = findNoLongerExcluded(old, up.entries, vault);
	sameList(lost, ['private.md', 'private-notes.md'], 'files no pattern can keep');
	// Sanity: those were excluded before.
	check(legacyIsExcluded(old, 'private.md'), 'old rule excluded private.md');
	// And nothing is lost for an entry with a slash.
	sameList(findNoLongerExcluded(['private/'], ['private/'], vault), [], 'private/ loses nothing');
}

// The old rule never matched these (documented `private/` form at depth, a
// leading slash), so the new rule only excludes more.
check(!legacyIsExcluded(['private/'], 'a/private/b.md'), 'old rule missed nested private/');
check(!legacyIsExcluded(['/private'], 'private/b.md'), 'old rule missed /private');

// A second run (already-upgraded list) changes nothing.
{
	const first = upgradeExcludedDirectories(['private', 'Projects/drafts', 'archive/']);
	const second = upgradeExcludedDirectories(first.entries);
	sameList(second.entries, first.entries, 'second run entries');
	// The added patterns end in `/`; the original slashless entries' patterns
	// are already present.
	sameList(second.added, [], 'second run adds nothing');
}

// --- Report ----------------------------------------------------------------

if (failures.length === 0) {
	console.log(`All ${checks} excluded-directory checks passed.`);
	process.exit(0);
}
console.log(`${failures.length}/${checks} excluded-directory check(s) FAILED:`);
for (const f of failures) console.log('  - ' + f);
process.exit(1);
