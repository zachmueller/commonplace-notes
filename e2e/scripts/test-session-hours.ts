#!/usr/bin/env npx tsx
/**
 * Sign-in Session Length Unit Test
 *
 * Covers the plugin side of the Cognito `SessionHours` parameter (attachment
 * spec P1 §1). Existing pools must keep 1-hour sessions until their author
 * applies a longer length, so no update that sends the current template may
 * leave SessionHours to the template default of 12.
 *
 *   1. effectiveSessionHours: the persisted value, else 1.
 *   2. Create parameters use the wizard's value, 12 by default.
 *   3. The real CloudFormationManager call sites, against a fake CloudFormation
 *      client that records UpdateStack/CreateStack input:
 *      - deployCognitoAuthStack, update path: SessionHours explicit (the
 *        wizard's value; 1 for a pre-SessionHours pool with nothing persisted);
 *      - deployCognitoAuthStack, create path: the wizard's value / 12;
 *      - updateCognitoAuthStack (wizard phase 2): explicit;
 *      - upgradeCognitoGate: explicit `1` on a pre-SessionHours pool, the
 *        persisted value otherwise, and `sessionHours` persisted afterwards;
 *      - updateCognitoCallbackUrl: SessionHours omitted for a pool that lacks
 *        it, UsePreviousValue for one that has it;
 *      - updateCognitoSessionLength: the new value, everything else
 *        UsePreviousValue, persisted; refused for a legacy inline-edge pool,
 *        an imported stack, and out-of-range hours.
 *
 * No AWS calls: the fake client is installed in the manager's client cache.
 *
 * Run: npx tsx e2e/scripts/test-session-hours.ts
 */

import * as paramsModule from '../../src/infrastructure/cognitoParams';
import * as cfmModule from '../../src/infrastructure/cloudFormationManager';

const params: typeof import('../../src/infrastructure/cognitoParams') =
	(paramsModule as any).effectiveSessionHours ? paramsModule : (paramsModule as any).default;
const CloudFormationManager: any =
	(cfmModule as any).CloudFormationManager ?? (cfmModule as any).default?.CloudFormationManager;

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
const OLD_KEYS = ['VariantName', 'GoogleClientId', 'GoogleClientSecret', 'CallbackURL', 'AuthDomainPrefix', 'AssetsBucket', 'TriggerAssetsKey'];
const NEW_KEYS = [...OLD_KEYS, 'SessionHours'];

interface FakeStack {
	/** undefined = the stack doesn't exist. */
	status?: string;
	keys: string[];
	/** Resources of the deployed template (GetTemplate). */
	resources?: Record<string, unknown>;
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
						Parameters: this.stack.keys.map(k => ({ ParameterKey: k, ParameterValue: 'x' })),
						Outputs: [],
					}],
				};
			case 'GetTemplateCommand':
				return { TemplateBody: JSON.stringify({ Resources: this.stack.resources ?? { UserPool: {} } }) };
			case 'UpdateStackCommand':
			case 'CreateStackCommand':
				return {};
			default:
				throw new Error(`unexpected command ${name}`);
		}
	}
	last(name: string): any {
		return [...this.sent].reverse().find(s => s.name === name)?.input;
	}
}

function makeProfile(cognito: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): any {
	return {
		id: 'p1',
		name: 'P1',
		awsSettings: { awsProfile: AWS_PROFILE, region: 'us-east-1' },
		infrastructureState: cognito
			? { status: 'deployed', region: 'us-east-1', variantName: '', readGateMode: 'none', cognitoAuth: { stackName: 'cpn-cognito', ...cognito }, ...extra }
			: undefined,
	};
}

/** A manager with a fake client; AWS-touching side steps stubbed. */
function makeManager(stack: FakeStack, profile: any): { cfm: any; cf: FakeCf; saves: number[] } {
	const saves: number[] = [];
	const plugin = {
		settings: { publishingProfiles: profile ? [profile] : [] },
		saveSettings: async () => { saves.push(Date.now()); },
	};
	const cfm = new CloudFormationManager(plugin);
	const cf = new FakeCf(stack);
	cfm.cfClients.set(`${AWS_PROFILE}:us-east-1`, cf);
	// upgradeCognitoGate's other steps (bootstrap bucket, trigger upload, outputs,
	// polling) aren't under test here.
	cfm.prepareCognitoAssets = async (config: any) => { config.assetsBucket = 'bucket'; config.preTokenAssetsKey = 'key'; };
	cfm.getCognitoAuthOutputs = async () => ({ accessGroupsBucket: 'bucket', accessGroupsKey: 'groups.json' });
	cfm.pollStackUntilComplete = async () => 'UPDATE_COMPLETE';
	return { cfm, cf, saves };
}

const wizardConfig = (extra: Record<string, unknown> = {}) => ({
	profileId: 'p1', variantName: '', awsProfile: AWS_PROFILE, region: 'us-east-1', s3Prefix: '',
	customDomain: '', useRoute53: false, hostedZoneId: '', hostedZoneName: '', originAccessMethod: 'oac',
	googleClientId: 'gid', authDomainPrefix: 'pfx', ...extra,
});

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
	// 1. effectiveSessionHours
	check(params.effectiveSessionHours({ sessionHours: 12 }) === 12, 'persisted 12 → 12');
	check(params.effectiveSessionHours({ sessionHours: 1 }) === 1, 'persisted 1 → 1');
	check(params.effectiveSessionHours({}) === 1, 'nothing persisted → 1');
	check(params.effectiveSessionHours(undefined) === 1, 'no pool state → 1');
	check(params.effectiveSessionHours({ sessionHours: 99 }) === 1, 'invalid persisted value → 1');

	// 2. Create parameters
	check(param(params.buildCognitoAuthParameters(wizardConfig() as any), 'SessionHours')?.ParameterValue === '12', 'create default 12');
	check(param(params.buildCognitoAuthParameters(wizardConfig({ sessionHours: 6 }) as any), 'SessionHours')?.ParameterValue === '6', 'create uses wizard value');

	// 3a. deployCognitoAuthStack — update path, pre-SessionHours pool, wizard seeded 1.
	{
		const profile = makeProfile({});
		const { cfm, cf } = makeManager({ status: 'UPDATE_COMPLETE', keys: OLD_KEYS }, profile);
		await cfm.deployCognitoAuthStack(wizardConfig({ sessionHours: 1 }));
		const sh = param(cf.last('UpdateStackCommand')?.Parameters, 'SessionHours');
		check(sh?.ParameterValue === '1' && !sh?.UsePreviousValue, `deploy update (legacy pool): SessionHours=1 explicit, got ${JSON.stringify(sh)}`);
		check(param(cf.last('UpdateStackCommand')?.Parameters, 'GoogleClientSecret')?.UsePreviousValue === true, 'deploy update keeps the secret');
	}
	// 3b. deployCognitoAuthStack — update path, config without sessionHours, nothing persisted → 1.
	{
		const profile = makeProfile({});
		const { cfm, cf } = makeManager({ status: 'UPDATE_COMPLETE', keys: OLD_KEYS }, profile);
		await cfm.deployCognitoAuthStack(wizardConfig());
		const sh = param(cf.last('UpdateStackCommand')?.Parameters, 'SessionHours');
		check(sh?.ParameterValue === '1', `deploy update (no config value, nothing persisted): 1, got ${JSON.stringify(sh)}`);
	}
	// 3c. deployCognitoAuthStack — update path, persisted 8, wizard re-run seeded 8.
	{
		const profile = makeProfile({ sessionHours: 8 });
		const { cfm, cf } = makeManager({ status: 'UPDATE_COMPLETE', keys: NEW_KEYS }, profile);
		await cfm.deployCognitoAuthStack(wizardConfig({ sessionHours: 8 }));
		check(param(cf.last('UpdateStackCommand')?.Parameters, 'SessionHours')?.ParameterValue === '8', 'deploy update (persisted 8): 8');
	}
	// 3d. deployCognitoAuthStack — create path.
	{
		const { cfm, cf } = makeManager({ status: undefined, keys: [] }, makeProfile(undefined));
		await cfm.deployCognitoAuthStack(wizardConfig({ sessionHours: 12 }));
		const sh = param(cf.last('CreateStackCommand')?.Parameters, 'SessionHours');
		check(sh?.ParameterValue === '12', `deploy create: 12, got ${JSON.stringify(sh)}`);
		check(!cf.last('UpdateStackCommand'), 'deploy create sends no UpdateStack');
	}

	// 3e. updateCognitoAuthStack (wizard phase 2) — a brand-new pool isn't
	// persisted yet, so the wizard's value must win (not effectiveSessionHours' 1).
	{
		const { cfm, cf } = makeManager({ status: 'CREATE_COMPLETE', keys: NEW_KEYS }, makeProfile(undefined));
		await cfm.updateCognitoAuthStack(wizardConfig({ sessionHours: 12, callbackUrl: 'https://x/auth/callback' }));
		check(param(cf.last('UpdateStackCommand')?.Parameters, 'SessionHours')?.ParameterValue === '12', 'phase 2 (new pool): wizard 12');
	}
	{
		const { cfm, cf } = makeManager({ status: 'UPDATE_COMPLETE', keys: OLD_KEYS }, makeProfile({}));
		await cfm.updateCognitoAuthStack(wizardConfig({ callbackUrl: 'https://x/auth/callback' }));
		check(param(cf.last('UpdateStackCommand')?.Parameters, 'SessionHours')?.ParameterValue === '1', 'phase 2 (no config value, legacy pool): 1');
	}

	// 3f. upgradeCognitoGate — pre-SessionHours pool, nothing persisted.
	{
		const profile = makeProfile({});
		const { cfm, cf, saves } = makeManager({ status: 'UPDATE_COMPLETE', keys: OLD_KEYS }, profile);
		await cfm.upgradeCognitoGate(profile);
		const update = cf.sent.filter(s => s.name === 'UpdateStackCommand').map(s => s.input)
			.find(i => typeof i.TemplateBody === 'string' && i.TemplateBody.includes('SessionHours'));
		const sh = param(update?.Parameters, 'SessionHours');
		check(sh?.ParameterValue === '1' && !sh?.UsePreviousValue, `upgrade (legacy pool): SessionHours=1 explicit, got ${JSON.stringify(sh)}`);
		check(profile.infrastructureState.cognitoAuth.sessionHours === 1, 'upgrade persists sessionHours: 1');
		check(saves.length > 0, 'upgrade saves settings');
	}
	// 3g. upgradeCognitoGate — persisted 12.
	{
		const profile = makeProfile({ sessionHours: 12 });
		const { cfm, cf } = makeManager({ status: 'UPDATE_COMPLETE', keys: NEW_KEYS }, profile);
		await cfm.upgradeCognitoGate(profile);
		check(param(cf.last('UpdateStackCommand')?.Parameters, 'SessionHours')?.ParameterValue === '12', 'upgrade (persisted 12): 12');
	}

	// 3h. updateCognitoCallbackUrl — UsePreviousTemplate, unchanged behaviour.
	{
		const profile = makeProfile({});
		const { cfm, cf } = makeManager({ status: 'UPDATE_COMPLETE', keys: OLD_KEYS }, profile);
		await cfm.updateCognitoCallbackUrl('cpn-cognito', 'https://x/auth/callback', profile);
		const input = cf.last('UpdateStackCommand');
		check(input?.UsePreviousTemplate === true, 'callback sync uses the previous template');
		check(!param(input?.Parameters, 'SessionHours'), 'callback sync omits SessionHours for a pool that lacks it');
	}
	{
		const profile = makeProfile({ sessionHours: 12 });
		const { cfm, cf } = makeManager({ status: 'UPDATE_COMPLETE', keys: NEW_KEYS }, profile);
		await cfm.updateCognitoCallbackUrl('cpn-cognito', 'https://x/auth/callback', profile);
		check(param(cf.last('UpdateStackCommand')?.Parameters, 'SessionHours')?.UsePreviousValue === true,
			'callback sync keeps SessionHours via UsePreviousValue');
	}

	// 3i. updateCognitoSessionLength (the Apply button).
	{
		const profile = makeProfile({});
		const { cfm, cf, saves } = makeManager({ status: 'UPDATE_COMPLETE', keys: OLD_KEYS }, profile);
		await cfm.updateCognitoSessionLength(profile, 12);
		const input = cf.last('UpdateStackCommand');
		check(typeof input?.TemplateBody === 'string' && input.TemplateBody.includes('SessionHours'), 'apply sends the current template');
		check(param(input?.Parameters, 'SessionHours')?.ParameterValue === '12', 'apply: SessionHours=12');
		const others = (input?.Parameters ?? []).filter((p: Param) => p.ParameterKey !== 'SessionHours');
		check(others.length === OLD_KEYS.length && others.every((p: Param) => p.UsePreviousValue === true),
			`apply: every other deployed key UsePreviousValue, got ${JSON.stringify(others)}`);
		check(profile.infrastructureState.cognitoAuth.sessionHours === 12, 'apply persists 12');
		check(saves.length === 1, 'apply saves settings');
	}
	{
		const profile = makeProfile({});
		const { cfm, cf } = makeManager({ status: 'UPDATE_COMPLETE', keys: OLD_KEYS, resources: { AuthEdgeFn: {}, UserPool: {} } }, profile);
		await rejects(() => cfm.updateCognitoSessionLength(profile, 12), /Upgrade Cognito gate first/, 'apply on legacy inline-edge pool');
		check(!cf.last('UpdateStackCommand'), 'legacy pool: no UpdateStack sent');
		check(profile.infrastructureState.cognitoAuth.sessionHours === undefined, 'legacy pool: nothing persisted');
	}
	{
		const profile = makeProfile({}, { imported: true });
		const { cfm } = makeManager({ status: 'UPDATE_COMPLETE', keys: OLD_KEYS }, profile);
		await rejects(() => cfm.updateCognitoSessionLength(profile, 12), /Imported/, 'apply on imported stack');
	}
	{
		const profile = makeProfile({});
		const { cfm } = makeManager({ status: 'UPDATE_COMPLETE', keys: OLD_KEYS }, profile);
		for (const bad of [0, 25, 1.5, NaN]) {
			await rejects(() => cfm.updateCognitoSessionLength(profile, bad), /whole number of hours/, `apply rejects ${bad}`);
		}
	}

	if (failures.length === 0) {
		console.log(`All ${checks} session-hours checks passed.`);
		process.exit(0);
	}
	console.log(`${failures.length}/${checks} session-hours check(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
