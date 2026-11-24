#!/usr/bin/env npx tsx
/**
 * Bucket Cleanup Rule Unit Test
 *
 * Covers the site stack's `NoncurrentVersionDays` parameter and its lifecycle
 * rules (attachment spec P3 §5). A site deployed before the rule must keep its
 * old versions until its author applies the rule, so no update other than
 * Apply may leave NoncurrentVersionDays to the template default of 30.
 *
 *   1. parseNoncurrentDays / isValidNoncurrentDays / deployedNoncurrentDays.
 *   2. bucketCleanupRow: hidden, imported, not set up, off, on.
 *   3. Both shipped site templates: the parameter, the condition, and two
 *      rules (noncurrent expiry behind Fn::If / AWS::NoValue, abort after 7
 *      days always).
 *   4. The real CloudFormationManager call sites, against a fake CloudFormation
 *      client that records UpdateStack/CreateStack input:
 *      - updateBucketLifecycle (the Apply button): current template (OAC or
 *        OAI), NoncurrentVersionDays overridden, every other deployed key
 *        UsePreviousValue, keys the live stack lacks given explicit defaults
 *        (never UsePreviousValue), polled, persisted; a no-op still persists;
 *        a rolled-back update throws and persists nothing; refused for
 *        imported stacks and invalid days;
 *      - updateFullStackOrigins / updateFullStackAuthLambda: `0` for a stack
 *        that lacks the parameter, UsePreviousValue for one that has it;
 *      - deployFullStack, create path: 30;
 *      - getBucketLifecycleDays: the live value, undefined when absent.
 *
 * No AWS calls: the fake client is installed in the manager's client cache.
 *
 * Run: npx tsx e2e/scripts/test-bucket-lifecycle.ts
 */

import * as lifecycleModule from '../../src/infrastructure/bucketLifecycle';
import * as cfmModule from '../../src/infrastructure/cloudFormationManager';
import * as templatesModule from '../../src/infrastructure/templates';

const lc: typeof import('../../src/infrastructure/bucketLifecycle') =
	(lifecycleModule as any).parseNoncurrentDays ? lifecycleModule : (lifecycleModule as any).default;
const CloudFormationManager: any =
	(cfmModule as any).CloudFormationManager ?? (cfmModule as any).default?.CloudFormationManager;
const templates: Record<string, string> =
	(templatesModule as any).FULL_STACK_OAC_TEMPLATE ? templatesModule : (templatesModule as any).default;

const failures: string[] = [];
let checks = 0;
function check(cond: boolean, msg: string): void {
	checks++;
	if (!cond) failures.push(msg);
}

type Param = { ParameterKey: string; ParameterValue?: string; UsePreviousValue?: boolean };
const param = (list: Param[] | undefined, key: string) => list?.find(p => p.ParameterKey === key);

// ---------------------------------------------------------------------------
// Fake CloudFormation
// ---------------------------------------------------------------------------

const AWS_PROFILE = 'fake';
const REGION = 'us-west-2';
/** A site deployed before chat, extra aliases and the cleanup rule. */
const OLD_KEYS = [
	'VariantName', 'S3Prefix', 'CustomDomain', 'CertificateArn', 'UseRoute53', 'HostedZoneId',
	'HostedZoneName', 'AuthLambdaEdgeArn', 'CallbackApiDomainName', 'CommentBucketDomainName',
	'CommentApiDomainName',
];
const NEW_KEYS = [...OLD_KEYS, 'ChatFunctionUrlDomainName', 'AdditionalAliases', 'MinimumProtocolVersion', 'NoncurrentVersionDays'];

interface FakeStack {
	/** undefined = the stack doesn't exist. */
	status?: string;
	keys: string[];
	values?: Record<string, string>;
	/** Make UpdateStack fail with CloudFormation's no-op error. */
	noUpdates?: boolean;
}

class FakeCf {
	sent: { name: string; input: any }[] = [];
	constructor(public stack: FakeStack) {}
	async send(cmd: any): Promise<any> {
		const name: string = cmd.constructor.name;
		this.sent.push({ name, input: cmd.input });
		switch (name) {
			case 'DescribeStacksCommand':
				if (!this.stack.status) throw new Error(`Stack with id ${cmd.input.StackName} does not exist`);
				return {
					Stacks: [{
						StackStatus: this.stack.status,
						Parameters: this.stack.keys.map(k => ({ ParameterKey: k, ParameterValue: this.stack.values?.[k] ?? 'x' })),
						// No DistributionID output: preserveLiveDomain has nothing to read.
						Outputs: [],
					}],
				};
			case 'UpdateStackCommand':
				if (this.stack.noUpdates) throw new Error('No updates are to be performed.');
				return {};
			case 'CreateStackCommand':
				return {};
			default:
				throw new Error(`unexpected command ${name}`);
		}
	}
	all(name: string): any[] {
		return this.sent.filter(s => s.name === name).map(s => s.input);
	}
	last(name: string): any {
		return this.all(name).pop();
	}
}

function makeProfile(extra: Record<string, unknown> = {}): any {
	return {
		id: 'p1',
		name: 'P1',
		awsSettings: { awsProfile: AWS_PROFILE, region: REGION },
		infrastructureState: {
			status: 'deployed', region: REGION, variantName: '', useRoute53: false,
			originAccessMethod: 'oac', fullStackName: 'cpn-default', ...extra,
		},
	};
}

function makeManager(stack: FakeStack, profile: any, pollStatus = 'UPDATE_COMPLETE') {
	const saves: number[] = [];
	const polls: { stackName: string; region: string }[] = [];
	const plugin = {
		settings: { publishingProfiles: profile ? [profile] : [] },
		saveSettings: async () => { saves.push(Date.now()); },
	};
	const cfm = new CloudFormationManager(plugin);
	const cf = new FakeCf(stack);
	cfm.cfClients.set(`${AWS_PROFILE}:${REGION}`, cf);
	cfm.pollStackUntilComplete = async (stackName: string, _p: unknown, _e: unknown, region: string) => {
		polls.push({ stackName, region });
		return pollStatus;
	};
	return { cfm, cf, saves, polls };
}

async function rejects(fn: () => Promise<unknown>, pattern: RegExp, msg: string): Promise<void> {
	try {
		await fn();
		check(false, `${msg}: expected an error`);
	} catch (err) {
		check(pattern.test(String((err as Error)?.message ?? err)), `${msg}: wrong error ${String(err)}`);
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	// 1. Parsing and validation
	check(lc.parseNoncurrentDays('30') === 30, "'30' → 30");
	check(lc.parseNoncurrentDays(' 7 ') === 7, "' 7 ' → 7");
	check(lc.parseNoncurrentDays('0') === 0, "'0' → 0");
	check(lc.parseNoncurrentDays('3650') === 3650, "'3650' → 3650");
	for (const bad of ['', '  ', '-1', '1.5', '3651', 'abc', '1e2', '0x10']) {
		check(lc.parseNoncurrentDays(bad) === null, `'${bad}' rejected`);
	}
	check(lc.isValidNoncurrentDays(0) && lc.isValidNoncurrentDays(30), '0 and 30 valid');
	for (const bad of [-1, 1.5, 3651, NaN, '30']) check(!lc.isValidNoncurrentDays(bad), `${String(bad)} invalid`);
	check(lc.deployedNoncurrentDays([{ ParameterKey: 'NoncurrentVersionDays', ParameterValue: '14' }]) === 14, 'deployed 14');
	check(lc.deployedNoncurrentDays([{ ParameterKey: 'VariantName', ParameterValue: '' }]) === undefined, 'deployed: absent → undefined');
	check(lc.deployedNoncurrentDays(undefined) === undefined, 'deployed: no parameters → undefined');

	// 2. Row state
	check(lc.bucketCleanupRow(undefined).kind === 'hidden', 'row: no state → hidden');
	check(lc.bucketCleanupRow({}).kind === 'hidden', 'row: no site stack → hidden');
	{
		const row = lc.bucketCleanupRow({ fullStackName: 'cpn-default', imported: true, bucketLifecycleDays: 30 });
		check(row.kind === 'imported' && row.desc === 'Managed outside the plugin; add a lifecycle rule in CDK.',
			`row: imported, got ${JSON.stringify(row)}`);
	}
	{
		const row = lc.bucketCleanupRow({ fullStackName: 'cpn-default' });
		check(row.kind === 'editable' && row.current === undefined && row.initialDays === 30, `row: not set up → field 30, got ${JSON.stringify(row)}`);
		check(row.kind === 'editable' && /No cleanup rule yet/.test(row.desc), 'row: not set up says so');
		check(row.kind === 'editable' && /config\.json/.test(row.desc) && /whole bucket/.test(row.desc), 'row: whole-bucket warning');
	}
	{
		const row = lc.bucketCleanupRow({ fullStackName: 'cpn-default', bucketLifecycleDays: 0 });
		check(row.kind === 'editable' && row.current === 0 && row.initialDays === 0, 'row: off → field 0');
		check(row.kind === 'editable' && /kept indefinitely/.test(row.desc) && /7 days/.test(row.desc), `row: off desc, got ${row.kind === 'editable' ? row.desc : ''}`);
	}
	{
		const row = lc.bucketCleanupRow({ fullStackName: 'cpn-default', bucketLifecycleDays: 14 });
		check(row.kind === 'editable' && row.current === 14 && /deleted 14 days/.test(row.desc), 'row: 14 days');
		const one = lc.bucketCleanupRow({ fullStackName: 'cpn-default', bucketLifecycleDays: 1 });
		check(one.kind === 'editable' && /deleted 1 day after/.test(one.desc), 'row: singular day');
		const bad = lc.bucketCleanupRow({ fullStackName: 'cpn-default', bucketLifecycleDays: -3 });
		check(bad.kind === 'editable' && bad.current === undefined, 'row: invalid persisted value → not set up');
	}

	// 3. Shipped templates
	for (const name of ['FULL_STACK_OAC_TEMPLATE', 'FULL_STACK_OAI_TEMPLATE']) {
		const tpl = JSON.parse(templates[name]);
		const p = tpl.Parameters?.NoncurrentVersionDays;
		check(p?.Type === 'Number' && p?.Default === 30 && p?.MinValue === 0, `${name}: parameter Number, default 30, min 0`);
		check(JSON.stringify(tpl.Conditions?.HasNoncurrentVersionExpiry)
			=== JSON.stringify({ 'Fn::Not': [{ 'Fn::Equals': [{ Ref: 'NoncurrentVersionDays' }, '0'] }] }), `${name}: condition`);
		const rules = tpl.Resources?.PublishedNotesBucket?.Properties?.LifecycleConfiguration?.Rules;
		check(Array.isArray(rules) && rules.length === 2, `${name}: two rules`);
		const [ifRule, abortRule] = rules ?? [];
		const [cond, rule, otherwise] = ifRule?.['Fn::If'] ?? [];
		check(cond === 'HasNoncurrentVersionExpiry' && otherwise?.Ref === 'AWS::NoValue', `${name}: expiry rule behind Fn::If / NoValue`);
		check(rule?.Status === 'Enabled' && rule?.NoncurrentVersionExpiration?.NoncurrentDays?.Ref === 'NoncurrentVersionDays',
			`${name}: expiry rule enabled, days from the parameter`);
		check(abortRule?.Status === 'Enabled' && abortRule?.AbortIncompleteMultipartUpload?.DaysAfterInitiation === 7,
			`${name}: abort rule enabled, 7 days, unconditional`);
		check(tpl.Resources?.PublishedNotesBucket?.Properties?.VersioningConfiguration?.Status === 'Enabled', `${name}: versioning still on`);
	}

	// 4a. updateBucketLifecycle on a site that predates the parameter.
	{
		const profile = makeProfile();
		const { cfm, cf, saves, polls } = makeManager({ status: 'UPDATE_COMPLETE', keys: OLD_KEYS }, profile);
		const events: string[] = [];
		await cfm.updateBucketLifecycle(profile, 30, (e: any) => events.push(e.status));
		const input = cf.last('UpdateStackCommand');
		check(input?.StackName === 'cpn-default', 'apply targets the persisted site stack');
		check(input?.TemplateBody === templates.FULL_STACK_OAC_TEMPLATE && !input?.UsePreviousTemplate, 'apply sends the current OAC template');
		const days = param(input?.Parameters, 'NoncurrentVersionDays');
		check(days?.ParameterValue === '30' && !days?.UsePreviousValue, `apply: NoncurrentVersionDays=30, got ${JSON.stringify(days)}`);
		for (const key of OLD_KEYS) {
			check(param(input?.Parameters, key)?.UsePreviousValue === true, `apply (old stack): ${key} UsePreviousValue`);
		}
		for (const key of ['ChatFunctionUrlDomainName', 'AdditionalAliases', 'MinimumProtocolVersion']) {
			const p = param(input?.Parameters, key);
			check(p !== undefined && !p.UsePreviousValue && typeof p.ParameterValue === 'string',
				`apply (old stack): ${key} the live stack lacks gets an explicit value, got ${JSON.stringify(p)}`);
		}
		check(input?.Capabilities?.includes('CAPABILITY_IAM'), 'apply: CAPABILITY_IAM');
		check(polls.length === 1 && polls[0].stackName === 'cpn-default' && polls[0].region === REGION, `apply polls in the site region, got ${JSON.stringify(polls)}`);
		check(profile.infrastructureState.bucketLifecycleDays === 30, 'apply persists 30');
		check(saves.length === 1, 'apply saves settings');
	}
	// 4b. updateBucketLifecycle on a current site, turning expiry off.
	{
		const profile = makeProfile({ bucketLifecycleDays: 30 });
		const { cfm, cf } = makeManager({ status: 'UPDATE_COMPLETE', keys: NEW_KEYS }, profile);
		await cfm.updateBucketLifecycle(profile, 0);
		const input = cf.last('UpdateStackCommand');
		check(param(input?.Parameters, 'NoncurrentVersionDays')?.ParameterValue === '0', 'apply 0: explicit 0');
		const others = (input?.Parameters ?? []).filter((p: Param) => p.ParameterKey !== 'NoncurrentVersionDays');
		check(others.length === NEW_KEYS.length - 1 && others.every((p: Param) => p.UsePreviousValue === true),
			`apply (current stack): every other key UsePreviousValue, got ${JSON.stringify(others)}`);
		check(profile.infrastructureState.bucketLifecycleDays === 0, 'apply persists 0');
	}
	// 4c. OAI site → OAI template.
	{
		const profile = makeProfile({ originAccessMethod: 'oai' });
		const { cfm, cf } = makeManager({ status: 'UPDATE_COMPLETE', keys: NEW_KEYS }, profile);
		await cfm.updateBucketLifecycle(profile, 14);
		check(cf.last('UpdateStackCommand')?.TemplateBody === templates.FULL_STACK_OAI_TEMPLATE, 'apply (OAI site) sends the OAI template');
	}
	// 4d. No-op update: no poll, value still persisted.
	{
		const profile = makeProfile();
		const { cfm, polls } = makeManager({ status: 'UPDATE_COMPLETE', keys: NEW_KEYS, noUpdates: true }, profile);
		await cfm.updateBucketLifecycle(profile, 30);
		check(polls.length === 0, 'no-op apply does not poll');
		check(profile.infrastructureState.bucketLifecycleDays === 30, 'no-op apply persists 30');
	}
	// 4e. Rolled-back update: throws, nothing persisted.
	{
		const profile = makeProfile();
		const { cfm, saves } = makeManager({ status: 'UPDATE_COMPLETE', keys: NEW_KEYS }, profile, 'UPDATE_ROLLBACK_COMPLETE');
		await rejects(() => cfm.updateBucketLifecycle(profile, 30), /UPDATE_ROLLBACK_COMPLETE/, 'rolled-back apply');
		check(profile.infrastructureState.bucketLifecycleDays === undefined && saves.length === 0, 'rolled-back apply persists nothing');
	}
	// 4f. Refusals.
	{
		const profile = makeProfile({ imported: true });
		const { cfm, cf } = makeManager({ status: 'UPDATE_COMPLETE', keys: NEW_KEYS }, profile);
		await rejects(() => cfm.updateBucketLifecycle(profile, 30), /managed outside the plugin/, 'apply on an imported stack');
		check(cf.sent.length === 0, 'imported: no CloudFormation calls');
	}
	{
		const profile = makeProfile({ fullStackName: undefined });
		const { cfm } = makeManager({ status: 'UPDATE_COMPLETE', keys: NEW_KEYS }, profile);
		await rejects(() => cfm.updateBucketLifecycle(profile, 30), /no deployed site stack/, 'apply without a site stack');
	}
	{
		const profile = makeProfile();
		const { cfm, cf } = makeManager({ status: 'UPDATE_COMPLETE', keys: NEW_KEYS }, profile);
		for (const bad of [-1, 1.5, 3651, NaN]) {
			await rejects(() => cfm.updateBucketLifecycle(profile, bad), /whole number/, `apply rejects ${bad}`);
		}
		check(cf.sent.length === 0, 'invalid days: no CloudFormation calls');
	}

	// 4g. Other targeted site-stack updates never turn expiry on by themselves.
	{
		const profile = makeProfile();
		const { cfm, cf } = makeManager({ status: 'UPDATE_COMPLETE', keys: OLD_KEYS }, profile);
		await cfm.updateFullStackOrigins(
			{ profileId: 'p1', variantName: '', awsProfile: AWS_PROFILE, region: REGION, originAccessMethod: 'oac' },
			{ CommentApiDomainName: 'api.example' });
		const p = param(cf.last('UpdateStackCommand')?.Parameters, 'NoncurrentVersionDays');
		check(p?.ParameterValue === '0' && !p?.UsePreviousValue, `origins update (old stack): explicit 0, got ${JSON.stringify(p)}`);
	}
	{
		const profile = makeProfile({ bucketLifecycleDays: 30 });
		const { cfm, cf } = makeManager({ status: 'UPDATE_COMPLETE', keys: NEW_KEYS }, profile);
		await cfm.updateFullStackAuthLambda('cpn-default', 'oac', 'arn:aws:lambda:us-east-1:1:function:f:1', profile, REGION);
		check(param(cf.last('UpdateStackCommand')?.Parameters, 'NoncurrentVersionDays')?.UsePreviousValue === true,
			'auth-lambda update (current stack): UsePreviousValue');
	}
	// 4h. deployFullStack, create path: the default.
	{
		const { cfm, cf } = makeManager({ status: undefined, keys: [] }, makeProfile());
		await cfm.deployFullStack({
			profileId: 'p1', variantName: '', awsProfile: AWS_PROFILE, region: REGION, s3Prefix: '',
			customDomain: '', useRoute53: false, hostedZoneId: '', hostedZoneName: '', originAccessMethod: 'oac',
		});
		check(param(cf.last('CreateStackCommand')?.Parameters, 'NoncurrentVersionDays')?.ParameterValue === '30', 'new site: 30');
	}
	// 4i. getBucketLifecycleDays.
	{
		const profile = makeProfile();
		const { cfm } = makeManager({ status: 'UPDATE_COMPLETE', keys: NEW_KEYS, values: { NoncurrentVersionDays: '30' } }, profile);
		check(await cfm.getBucketLifecycleDays('cpn-default', profile, REGION) === 30, 'live value read back');
		const old = makeManager({ status: 'UPDATE_COMPLETE', keys: OLD_KEYS }, profile);
		check(await old.cfm.getBucketLifecycleDays('cpn-default', profile, REGION) === undefined, 'old stack → undefined');
	}

	if (failures.length === 0) {
		console.log(`All ${checks} bucket-lifecycle checks passed.`);
		process.exit(0);
	}
	console.log(`${failures.length}/${checks} bucket-lifecycle check(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
