/**
 * Materializable example deploy hooks.
 *
 * EXPORT-ONLY: unlike the parser scaffolds, these are never parsed into a
 * running in-memory fallback. They exist solely so a user can materialize a
 * starter note (via the profile's "Deploy hooks" settings section or the
 * export command) and then edit it. Deploy hooks have no built-in behavior.
 */

import type { BuiltinDeployHookScaffold } from '../types';
import { EXAMPLE_POST_DEPLOY } from './example-post-deploy';

const SCAFFOLDS: BuiltinDeployHookScaffold[] = [
	EXAMPLE_POST_DEPLOY,
];

export const BUILTIN_DEPLOY_HOOK_SCAFFOLDS: ReadonlyMap<string, BuiltinDeployHookScaffold> = new Map(
	SCAFFOLDS.map((s) => [s.name, s]),
);
