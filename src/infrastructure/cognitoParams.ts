/**
 * Parameters for the Cognito auth (pool) stack, and the sign-in session length.
 *
 * Pure: no Obsidian imports, so it can be unit-tested with tsx
 * (e2e/scripts/test-session-hours.ts). CloudFormationManager delegates here.
 *
 * Session length: the pool's `SessionHours` parameter sets the ID and access
 * token lifetime, and the callback Lambda sets the `cpn_id` cookie's Max-Age
 * from the token's `exp`. Pools deployed before the parameter existed use
 * Cognito's default 1-hour tokens. Their template default (12) must never
 * apply silently, because a longer session also lengthens how long a removed
 * reader keeps access. So every pool update that sends the current template
 * passes `SessionHours` explicitly, and only a new pool takes the default.
 */

import type { CognitoAuthState, DeploymentConfig } from './types';

/** Session length for a new pool. */
export const DEFAULT_SESSION_HOURS = 12;
/** Cognito's default token lifetime, which pools deployed before `SessionHours` have. */
export const LEGACY_SESSION_HOURS = 1;
export const MIN_SESSION_HOURS = 1;
/** Cognito's maximum ID token lifetime. */
export const MAX_SESSION_HOURS = 24;

export interface StackParameter {
	ParameterKey: string;
	ParameterValue?: string;
	UsePreviousValue?: boolean;
}

/**
 * Every Cognito auth stack template parameter key. Used to build a targeted
 * update that changes only a named subset and inherits the rest via
 * UsePreviousValue.
 */
export const COGNITO_AUTH_PARAM_KEYS = [
	'VariantName', 'GoogleClientId', 'GoogleClientSecret', 'CallbackURL', 'AuthDomainPrefix',
	'AssetsBucket', 'TriggerAssetsKey', 'SessionHours',
] as const;

/** Whether `hours` is a whole number of hours Cognito accepts. */
export function isValidSessionHours(hours: unknown): hours is number {
	return typeof hours === 'number' && Number.isInteger(hours)
		&& hours >= MIN_SESSION_HOURS && hours <= MAX_SESSION_HOURS;
}

/**
 * The session length a deployed pool has: the persisted value, or 1 when none
 * is persisted (the pool was deployed before this setting, so its tokens last
 * Cognito's default of 1 hour). Every caller that needs "the session length"
 * of a live pool uses this.
 */
export function effectiveSessionHours(cognito: Pick<CognitoAuthState, 'sessionHours'> | undefined): number {
	const hours = cognito?.sessionHours;
	return isValidSessionHours(hours) ? hours : LEGACY_SESSION_HOURS;
}

/**
 * The full parameter set, for CreateStack and for the wizard's phase-2 update
 * (which still holds the just-entered Google secret). `sessionHours` comes
 * from the wizard: 12 by default for a new pool, the live pool's
 * {@link effectiveSessionHours} on a re-run.
 */
export function buildCognitoAuthParameters(config: DeploymentConfig): StackParameter[] {
	return [
		{ ParameterKey: 'VariantName', ParameterValue: config.variantName },
		{ ParameterKey: 'GoogleClientId', ParameterValue: config.googleClientId || '' },
		{ ParameterKey: 'GoogleClientSecret', ParameterValue: config.googleClientSecret || '' },
		{ ParameterKey: 'CallbackURL', ParameterValue: config.callbackUrl || 'https://placeholder.invalid/auth/callback' },
		{ ParameterKey: 'AuthDomainPrefix', ParameterValue: config.authDomainPrefix || '' },
		{ ParameterKey: 'AssetsBucket', ParameterValue: config.assetsBucket || '' },
		{ ParameterKey: 'TriggerAssetsKey', ParameterValue: config.preTokenAssetsKey || '' },
		{ ParameterKey: 'SessionHours', ParameterValue: String(config.sessionHours ?? DEFAULT_SESSION_HOURS) },
	];
}

/**
 * Build UpdateStack parameters that change only the keys present in
 * `overrides` and keep every other key at its currently-deployed value
 * (UsePreviousValue). Critical for a callback-only re-sync: the Google client
 * secret is never persisted in the plugin, so re-passing the full parameter
 * set from a partial config (via buildCognitoAuthParameters) would resolve
 * GoogleClientSecret to '' and wipe the Google IdP secret. ParameterValue and
 * UsePreviousValue are mutually exclusive per key.
 *
 * A key the live stack was never deployed with (e.g. AssetsBucket on a
 * pre-access-groups pool, SessionHours on a pre-session-length pool) can't use
 * UsePreviousValue: CloudFormation rejects it. Such keys are omitted so the
 * template default applies, or, with UsePreviousTemplate, because the old
 * template may not declare them at all. Updates that send the current template
 * must therefore pass SessionHours in `overrides`
 * ({@link currentTemplateUpdateParameters}).
 */
export function buildCognitoAuthUpdateParameters(
	overrides: Partial<Record<string, string>>,
	deployedKeys?: Set<string>,
): StackParameter[] {
	const out: StackParameter[] = [];
	for (const key of COGNITO_AUTH_PARAM_KEYS) {
		if (key in overrides) {
			out.push({ ParameterKey: key, ParameterValue: overrides[key] });
		} else if (!deployedKeys || deployedKeys.has(key)) {
			out.push({ ParameterKey: key, UsePreviousValue: true });
		}
	}
	return out;
}

/**
 * Update parameters for any pool-stack update that sends the current
 * `COGNITO_AUTH_TEMPLATE`: the overrides plus `SessionHours` set explicitly,
 * so the template default never lengthens an existing site's sessions.
 */
export function currentTemplateUpdateParameters(
	overrides: Partial<Record<string, string>>,
	deployedKeys: Set<string> | undefined,
	sessionHours: number,
): StackParameter[] {
	return buildCognitoAuthUpdateParameters({ ...overrides, SessionHours: String(sessionHours) }, deployedKeys);
}
