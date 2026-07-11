/**
 * Parser-stage compilation pipeline.
 *
 * Strips TypeScript types via Sucrase, then compiles the resulting JavaScript
 * into an AsyncFunction with injected context arguments. Ported from Notor's
 * `shared/notor/src/extensions/compiler.ts`; `stripTypes` is reused verbatim,
 * but the argument set is parser-specific (`libs, context, app, utils`) rather
 * than Notor's tool/automation sets.
 */

import { transform } from 'sucrase';
import type { CompiledParserFn } from './types';

// ---------------------------------------------------------------------------
// AsyncFunction constructor
// ---------------------------------------------------------------------------

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
	...args: string[]
) => CompiledParserFn;

// ---------------------------------------------------------------------------
// Type stripping
// ---------------------------------------------------------------------------

/**
 * Strip TypeScript type annotations from stage code using Sucrase.
 *
 * Handles: type annotations, interfaces, generics, `as` casts, type-only
 * imports (stripped to empty). Does NOT support `enum`/`namespace`.
 *
 * @throws Error with a descriptive message on a Sucrase syntax error.
 */
export function stripTypes(code: string): string {
	try {
		const result = transform(code, {
			transforms: ['typescript'],
		});
		return result.code;
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`TypeScript transform failed: ${message}`);
	}
}

// ---------------------------------------------------------------------------
// AsyncFunction compilation
// ---------------------------------------------------------------------------

/**
 * Parser stage argument names — injected as function parameters at runtime.
 * The stage body has these in scope and `return`s a unified plugin.
 */
export const PARSER_ARG_NAMES = ['libs', 'context', 'app', 'utils'] as const;

/** Compile already-stripped JavaScript into the parser-stage AsyncFunction. */
export function compileParserFunction(strippedCode: string): CompiledParserFn {
	return new AsyncFunction(...PARSER_ARG_NAMES, strippedCode);
}

// ---------------------------------------------------------------------------
// Full compilation pipeline
// ---------------------------------------------------------------------------

/**
 * Generic compile pipeline shared by every note-embedded-code subsystem
 * (parser stages, routing actions): strip TypeScript types → compile to an
 * AsyncFunction with the given argument names in scope.
 *
 * @param rawCode  - Raw TS/JS from a code fence.
 * @param argNames - Parameter names injected into the function body.
 * @returns `{ fn }` on success, or `{ error }` with a descriptive message.
 */
export function compileUserFunction<Fn = (...args: any[]) => Promise<unknown>>(
	rawCode: string,
	argNames: readonly string[],
): { fn: Fn } | { error: string } {
	let strippedCode: string;
	try {
		strippedCode = stripTypes(rawCode);
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return { error: message };
	}

	try {
		const GenericAsyncFunction = AsyncFunction as unknown as new (...args: string[]) => Fn;
		return { fn: new GenericAsyncFunction(...argNames, strippedCode) };
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return { error: `Compilation failed: ${message}` };
	}
}

/**
 * Full pipeline: strip TypeScript types → compile to AsyncFunction.
 *
 * @param rawCode - Raw TS/JS from the stage's code fence.
 * @returns `{ fn }` on success, or `{ error }` with a descriptive message.
 */
export function compileParserExtension(
	rawCode: string,
): { fn: CompiledParserFn } | { error: string } {
	return compileUserFunction<CompiledParserFn>(rawCode, PARSER_ARG_NAMES);
}
