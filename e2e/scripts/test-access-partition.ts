#!/usr/bin/env npx tsx
/**
 * Per-note Access Rules Test
 *
 * Pure unit test of src/utils/access.ts, the rules that decide where a note with
 * `cpn-access-groups` publishes and what it may reveal:
 *   - frontmatter normalization (list/string/invalid)
 *   - partitions, removed partitions on an access change
 *   - link + backlink visibility across partitions (no title/uid leaks)
 *   - fail-closed publish checks (read gate, upgrade state, BYO opt-in, home
 *     note, undefined groups, Local mechanism)
 *   - splitting uid/slug aggregates into public + per-group views
 *   - the membership file shape for the pre-token trigger
 *
 * Run: npx tsx e2e/scripts/test-access-partition.ts
 */

import * as accessModule from '../../src/utils/access';

const A: typeof accessModule =
	(accessModule as any).normalizeGroupList !== undefined ? accessModule : (accessModule as any).default;

const failures: string[] = [];
function eq(actual: unknown, expected: unknown, msg: string) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) failures.push(`${msg} (expected ${e}, got ${a})`);
}
function check(cond: boolean, msg: string) {
	if (!cond) failures.push(msg);
}

const EDGE_ARN = 'arn:aws:lambda:us-east-1:1:function:authedge:3';

function profile(over: any = {}): any {
	return {
		id: 'p',
		name: 'P',
		publishMechanism: 'AWS',
		homeNotePath: 'Home.md',
		accessGroups: { team: { members: ['A@x.com', ' b@x.com', 'a@x.com'] }, family: { members: [] } },
		infrastructureState: {
			status: 'deployed',
			readGateMode: 'cognito',
			authLambdaEdgeArn: EDGE_ARN,
			cognitoAuth: {
				stackName: 'cpn-cognito-p',
				edgeStackName: 'cpn-authedge-p',
				edgeFunctionVersionArn: EDGE_ARN,
				accessGroupsBucket: 'bkt',
				accessGroupsKey: 'access/cpn-cognito-p/groups.json',
			},
		},
		...over,
	};
}

function testNormalize() {
	eq(A.normalizeGroupList(undefined), { groups: [], invalid: [], notAList: false }, 'absent -> no groups');
	eq(A.normalizeGroupList([]), { groups: [], invalid: [], notAList: false }, 'empty list -> no groups');
	eq(A.normalizeGroupList(['Team', 'family', 'team', ' ops ']).groups, ['family', 'ops', 'team'], 'lowercased, trimmed, deduped, sorted');
	eq(A.normalizeGroupList('team'), { groups: ['team'], invalid: [], notAList: true }, 'bare string accepted, flagged');
	eq(A.normalizeGroupList(['ok', 'bad name', 'x/y']).invalid, ['bad name', 'x/y'], 'invalid names reported');
	eq(A.normalizeGroupList({ a: 1 }).invalid.length, 1, 'non-list object is invalid');
	eq(A.normalizeGroupName(' My Team '), 'my-team', 'settings name normalization');
	eq(A.normalizeGroupName('bad/name'), null, 'unfixable settings name');
	eq(A.normalizeMembers([' B@x.com', 'b@x.com', '', 'a@x.com']), ['a@x.com', 'b@x.com'], 'members normalized');
}

function testPartitions() {
	eq(A.partitionsFor([]), [null], 'public note -> public partition');
	eq(A.partitionsFor(['a', 'b']), ['a', 'b'], 'gated note -> its group partitions only');
	eq(A.removedPartitions([null], ['a']), [null], 'public -> gated removes public copy');
	eq(A.removedPartitions(['a', 'b'], ['b']), ['a'], 'dropping a group removes that copy');
	eq(A.removedPartitions(['a'], ['a', 'b']), [], 'adding a group removes nothing');
	eq(A.removedPartitions(['a'], [null]), ['a'], 'gated -> public removes the group copy');
	eq(A.restrictedPrefix('team'), 'restricted/team/', 'restricted prefix');
}

function testVisibility() {
	// Backlinks, per partition copy
	check(A.visibleInPartition(null, []), 'public backlink visible in public copy');
	check(!A.visibleInPartition(null, ['team']), 'gated backlink hidden from public copy');
	check(A.visibleInPartition('team', ['team', 'ops']), 'gated backlink visible in a shared group copy');
	check(!A.visibleInPartition('family', ['team']), 'gated backlink hidden from another group copy');
	check(A.visibleInPartition('team', []), 'public backlink visible in a group copy');
	// Links: shared HTML must be safe in every copy
	check(A.linkVisibleFrom([], []), 'public -> public link resolves');
	check(!A.linkVisibleFrom([], ['team']), 'public -> gated link does not resolve (no leak)');
	check(A.linkVisibleFrom(['team'], ['team']), 'team -> team link resolves');
	check(!A.linkVisibleFrom(['team', 'family'], ['team']), 'multi-group source: target must be in ALL source groups');
	check(A.linkVisibleFrom(['team', 'family'], ['family', 'team']), 'target covering all source groups resolves');
	check(A.linkVisibleFrom(['team'], []), 'gated -> public link resolves');
}

function testPublishChecks() {
	const n = (g: string[]) => A.normalizeGroupList(g);
	eq(A.validateNoteAccess(profile(), n([]), false), { ok: true }, 'public note always ok');
	eq(A.validateNoteAccess(profile(), n(['team']), false), { ok: true }, 'defined group on upgraded cognito site ok');
	check(!A.validateNoteAccess(profile(), n(['team']), true).ok, 'gated home note blocked');
	check(!A.validateNoteAccess(profile(), n(['nope']), false).ok, 'undefined group blocked');
	check(!A.validateNoteAccess(profile(), A.normalizeGroupList(['bad name']), false).ok, 'invalid name blocked even alone');
	check(!A.validateNoteAccess(profile({ publishMechanism: 'Local' }), n(['team']), false).ok, 'Local mechanism blocked');

	const legacy = profile();
	delete legacy.infrastructureState.cognitoAuth.edgeStackName;
	check(!A.canPublishGated(legacy).ok, 'legacy (un-upgraded) cognito gate blocked');
	const handSetArn = profile();
	handSetArn.infrastructureState.authLambdaEdgeArn = 'arn:aws:lambda:us-east-1:1:function:other:1';
	check(!A.canPublishGated(handSetArn).ok, 'site not running the group-aware edge fn -> blocked');
	for (const mode of ['none', 'password']) {
		const p = profile();
		p.infrastructureState.readGateMode = mode;
		check(!A.canPublishGated(p).ok, `${mode} read gate blocked`);
	}
	const byo = profile();
	byo.infrastructureState.readGateMode = 'byo';
	check(!A.canPublishGated(byo).ok, 'byo without opt-in blocked');
	byo.byoEnforcesAccessGroups = true;
	check(A.canPublishGated(byo).ok, 'byo with opt-in ok');
}

function testAggregates() {
	const access: Record<string, string[]> = { PUB: [], SEC: ['team'], BOTH: ['family', 'team'] };
	const accessOf = (uid: string) => access[uid] ?? [];
	const uidToHash = { PUB: 'h1', SEC: 'h2', BOTH: 'h3', UNKNOWN: 'h4' };
	const parts = A.partitionRecord(uidToHash, accessOf, ['team', 'family', 'empty']);
	eq(parts.publicView, { PUB: 'h1', UNKNOWN: 'h4' }, 'public view excludes gated uids');
	eq(parts.groupViews.team, { SEC: 'h2', BOTH: 'h3' }, 'team view');
	eq(parts.groupViews.family, { BOTH: 'h3' }, 'family view');
	eq(parts.groupViews.empty, {}, 'defined group without notes gets an empty view');
	const slugs = A.partitionSlugMap({ 'pub.md': 'PUB', 'secret-plans.md': 'SEC' }, accessOf, ['team']);
	eq(slugs.publicView, { 'pub.md': 'PUB' }, 'public slug map hides gated note paths');
	eq(slugs.groupViews.team, { 'secret-plans.md': 'SEC' }, 'team slug map');
}

function testGroupsJson() {
	const json = JSON.parse(A.buildGroupsJson(profile()));
	eq(json, { version: 1, groups: { family: [], team: ['a@x.com', 'b@x.com'] } }, 'membership file: sorted groups, normalized members');
	eq(A.buildGroupsJson(profile()), A.buildGroupsJson(profile()), 'membership file is deterministic');
}

testNormalize();
testPartitions();
testVisibility();
testPublishChecks();
testAggregates();
testGroupsJson();

if (failures.length === 0) {
	console.log('All access-partition cases passed.');
	process.exit(0);
}
console.log(`${failures.length} access-partition assertion(s) FAILED:`);
for (const f of failures) console.log('  - ' + f);
process.exit(1);
