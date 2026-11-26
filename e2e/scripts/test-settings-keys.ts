#!/usr/bin/env npx tsx
/**
 * Settings-keys Unit Test
 *
 * Exercises the pure helpers behind the declarative settings tab:
 * src/settings/keys.ts (key grammar, escaping, path get/set/delete, pattern
 * matching, session refs) and src/settings/pageNames.ts (stable, unique page
 * names and tombstones).
 *
 * Run: npx tsx e2e/scripts/test-settings-keys.ts
 */

import * as keysModule from '../../src/settings/keys';
import * as namesModule from '../../src/settings/pageNames';

// Under tsx's ESM/CJS interop, named exports from src/ modules can land under
// `.default` (see test-obscure-wikilinks.ts).
const keys: typeof import('../../src/settings/keys') =
	(keysModule as any).parseKey ? keysModule : (keysModule as any).default;
const names: typeof import('../../src/settings/pageNames') =
	(namesModule as any).PageNameSnapshot ? namesModule : (namesModule as any).default;
const {
	buildGeneralKey, buildProfileKey, parseKey, getAtPath, setAtPath, deleteAtPath, matchPath, RefRegistry, toPath,
} = keys;
const { PageNameSnapshot, uniqueName } = names;

const failures: string[] = [];
let checks = 0;

function check(cond: boolean, msg: string): void {
	checks++;
	if (!cond) failures.push(msg);
}

function same(got: unknown, want: unknown, what: string): void {
	check(JSON.stringify(got) === JSON.stringify(want), `${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

// --- Key grammar -----------------------------------------------------------

same(buildGeneralKey('urlStackWindowSeconds'), 'general.urlStackWindowSeconds', 'general key');
same(parseKey('general.urlStackWindowSeconds'), { scope: 'general', path: ['urlStackWindowSeconds'] }, 'parse general');
same(buildProfileKey('r1', 'awsSettings.bucketName'), 'profile.r1.awsSettings.bucketName', 'profile key');
same(parseKey('profile.r1.awsSettings.bucketName'), { scope: 'profile', ref: 'r1', path: ['awsSettings', 'bucketName'] }, 'parse profile');

// Segments with dots and percent signs survive a round trip as one segment.
{
	const path = ['siteCustomization', 'namedStyles', 'v1.2 50%', 'fontFamily'];
	const key = buildProfileKey('r7', path);
	same(key, 'profile.r7.siteCustomization.namedStyles.v1%2E2 50%25.fontFamily', 'escaped key');
	same(parseKey(key), { scope: 'profile', ref: 'r7', path }, 'escaped round trip');
}
same(toPath('a.b.c'), ['a', 'b', 'c'], 'dotted path literal');

// Malformed keys.
for (const bad of ['', 'general', 'profile', 'profile.r1', 'other.x', 'general..x', 'profile.r1.a..b']) {
	check(parseKey(bad) === null, `parseKey(${JSON.stringify(bad)}) should be null`);
}

// --- get / set / delete ------------------------------------------------------

{
	const root: Record<string, unknown> = { awsSettings: { bucketName: 'b' } };
	same(getAtPath(root, ['awsSettings', 'bucketName']), 'b', 'get nested');
	same(getAtPath(root, ['awsSettings', 'missing', 'deeper']), undefined, 'get missing');
	same(getAtPath(undefined, ['x']), undefined, 'get from undefined root');

	check(setAtPath(root, ['siteCustomization', 'themeOverrides', 'dark', 'linkColor'], '#fff'), 'set nested create ok');
	same(root.siteCustomization, { themeOverrides: { dark: { linkColor: '#fff' } } }, 'nested create shape');

	check(setAtPath(root, ['siteCustomization', 'headerLinks', '0', 'label'], 'Home'), 'set array create ok');
	const links = getAtPath(root, ['siteCustomization', 'headerLinks']);
	check(Array.isArray(links), 'numeric segment creates an array');
	same(links, [{ label: 'Home' }], 'array create shape');

	check(!setAtPath(root, ['awsSettings', 'bucketName', 'x'], 1), 'set through a string fails');
	check(!setAtPath(null, ['x'], 1), 'set on null root fails');

	check(deleteAtPath(root, ['siteCustomization', 'themeOverrides', 'dark', 'linkColor']), 'delete present');
	same(getAtPath(root, ['siteCustomization', 'themeOverrides', 'dark']), {}, 'delete leaves parent');
	check(!deleteAtPath(root, ['siteCustomization', 'nope', 'x']), 'delete absent is a no-op');
}

// --- matchPath -----------------------------------------------------------------

check(matchPath(['awsSettings', 's3Prefix'], ['awsSettings', 's3Prefix']), 'exact match');
check(!matchPath(['awsSettings', 's3Prefix'], ['awsSettings']), 'shorter path does not match');
check(matchPath(['accessGroups', '*', 'members'], ['accessGroups', 'staff', 'members']), 'wildcard segment');
check(!matchPath(['accessGroups', '*', 'members'], ['accessGroups', 'staff', 'description']), 'wildcard mismatch');
check(matchPath(['attachments', '**'], ['attachments', 'mode']), 'trailing ** matches remainder');
check(matchPath(['attachments', '**'], ['attachments']), 'trailing ** matches none');
check(!matchPath(['attachments', '**'], ['awsSettings', 'region']), 'trailing ** prefix mismatch');

// --- RefRegistry -----------------------------------------------------------------

{
	const reg = new RefRegistry('p');
	const a = { id: 'a' };
	const b = { id: 'b' };
	const ra = reg.refFor(a);
	check(ra === reg.refFor(a), 'same object, same ref');
	check(ra !== reg.refFor(b), 'different objects, different refs');
	a.id = 'renamed';
	check(reg.resolve(ra) === a, 'ref survives editing the object id');
	// A record re-keyed under a new name keeps the same object, so the same ref.
	const groups: Record<string, object> = { staff: { members: [] } };
	const rg = reg.refFor(groups.staff);
	groups.team = groups.staff;
	delete groups.staff;
	check(reg.refFor(groups.team) === rg, 'ref survives re-keying a record');
	check(reg.resolve('p999') === undefined, 'unknown ref resolves to undefined');
}

// --- Page names --------------------------------------------------------------------

same(uniqueName('X', new Set()), 'X', 'unique: free');
same(uniqueName('X', new Set(['X'])), 'X (2)', 'unique: suffix');
same(uniqueName('X', new Set(['X', 'X (2)'])), 'X (3)', 'unique: next suffix');
same(uniqueName('  ', new Set()), 'Untitled', 'unique: blank');
same(uniqueName(undefined, new Set()), 'Untitled', 'unique: missing name (malformed data.json)');
same(uniqueName(42, new Set(['Untitled'])), 'Untitled (2)', 'unique: non-string name');

{
	const snap = new PageNameSnapshot();
	// Duplicates are made unique.
	same(snap.resolve('profiles', [{ ref: 'a', name: 'New profile' }, { ref: 'b', name: 'New profile' }]),
		[{ ref: 'a', name: 'New profile' }, { ref: 'b', name: 'New profile (2)' }], 'dedupe siblings');
	// A rename keeps the recorded name until clear().
	same(snap.resolve('profiles', [{ ref: 'a', name: 'Blog' }, { ref: 'b', name: 'New profile' }]).map(i => i.name),
		['New profile', 'New profile (2)'], 'rename is deferred');
	// Scopes are independent.
	same(snap.resolve('groups:a', [{ ref: 'g', name: 'New profile' }]).map(i => i.name), ['New profile'], 'scopes independent');
	// Removal leaves a tombstone that keeps its name reserved.
	same(snap.resolve('profiles', [{ ref: 'b', name: 'New profile' }]).map(i => i.name), ['New profile (2)'], 'live after removal');
	same(snap.removed('profiles'), [{ ref: 'a', name: 'New profile' }], 'tombstone listed');
	same(snap.resolve('profiles', [{ ref: 'b', name: 'x' }, { ref: 'c', name: 'New profile' }]).map(i => i.name),
		['New profile (2)', 'New profile (3)'], 'tombstone name stays reserved');
	// A returning ref is live again.
	snap.resolve('profiles', [{ ref: 'a', name: 'whatever' }, { ref: 'b', name: 'x' }, { ref: 'c', name: 'y' }]);
	same(snap.removed('profiles'), [], 'returning ref is no longer a tombstone');
	same(snap.nameOf('profiles', 'b'), 'New profile (2)', 'nameOf recorded');
	same(snap.nameOf('profiles', 'zz'), undefined, 'nameOf unknown');
	snap.clear();
	same(snap.resolve('profiles', [{ ref: 'a', name: 'Blog' }]), [{ ref: 'a', name: 'Blog' }], 'clear takes fresh names');
	same(snap.removed('profiles'), [], 'clear drops tombstones');
}

// --- Report ----------------------------------------------------------------

if (failures.length === 0) {
	console.log(`All ${checks} settings-key checks passed.`);
	process.exit(0);
}
console.log(`${failures.length}/${checks} settings-key check(s) FAILED:`);
for (const f of failures) console.log('  - ' + f);
process.exit(1);
