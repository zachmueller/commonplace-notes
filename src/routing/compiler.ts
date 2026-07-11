/**
 * Compilation for routing `code` actions.
 *
 * Reuses the shared `compileUserFunction` (sucrase type-strip → AsyncFunction)
 * from the parser subsystem; only the injected argument names differ. A routing
 * `code` body has `(libs, context, app, utils)` in scope and runs for its side
 * effects (its return value is ignored).
 */

import { compileUserFunction } from '../utils/parser/compiler';
import type { CompiledRoutingFn } from './types';

/**
 * Routing action argument names — injected as function parameters at runtime.
 * Same positions as the parser stage args, so the shared compiler applies.
 */
export const ROUTING_ARG_NAMES = ['libs', 'context', 'app', 'utils'] as const;

/**
 * Strip TypeScript types → compile a routing `code` action to an AsyncFunction.
 *
 * @param rawCode - Raw TS/JS from the action's code fence.
 * @returns `{ fn }` on success, or `{ error }` with a descriptive message.
 */
export function compileRoutingAction(
	rawCode: string,
): { fn: CompiledRoutingFn } | { error: string } {
	return compileUserFunction<CompiledRoutingFn>(rawCode, ROUTING_ARG_NAMES);
}
