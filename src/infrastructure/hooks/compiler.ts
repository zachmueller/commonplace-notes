/**
 * Compilation for deploy hooks.
 *
 * Reuses the shared `compileUserFunction` (sucrase type-strip → AsyncFunction)
 * from the parser subsystem; only the injected argument names differ. A hook
 * body has `(aws, context, utils)` in scope and runs for its side effects (its
 * return value is ignored). Unlike parser stages, hooks get no `libs`/`app` —
 * they are AWS-focused, not render-focused.
 */

import { compileUserFunction } from '../../utils/parser/compiler';
import type { CompiledDeployHookFn } from './types';

/**
 * Deploy-hook argument names — injected as function parameters at runtime.
 * The hook body has these in scope and runs for side effects.
 */
export const DEPLOY_HOOK_ARG_NAMES = ['aws', 'context', 'utils'] as const;

/**
 * Strip TypeScript types → compile a deploy hook to an AsyncFunction.
 *
 * @param rawCode - Raw TS/JS from the hook's code fence.
 * @returns `{ fn }` on success, or `{ error }` with a descriptive message.
 */
export function compileDeployHook(
	rawCode: string,
): { fn: CompiledDeployHookFn } | { error: string } {
	return compileUserFunction<CompiledDeployHookFn>(rawCode, DEPLOY_HOOK_ARG_NAMES);
}
