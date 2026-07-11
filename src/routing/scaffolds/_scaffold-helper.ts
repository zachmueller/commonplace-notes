/**
 * Helpers that emit complete routing `.md` files from metadata.
 *
 * The emitted content is BOTH (a) what gets written to the vault when a user
 * materializes a built-in, and (b) the in-memory fallback parsed at load time
 * when no vault file exists — so behavior is identical either way. Mirrors the
 * parser subsystem's `_scaffold-helper.ts`.
 */

import { stringifyYaml } from 'obsidian';
import { RK } from '../frontmatterKeys';
import type {
	BuiltinRoutingActionScaffold,
	BuiltinRoutingOptionScaffold,
	RawStep,
	RoutingActionKind,
} from '../types';

function quote(s: string): string {
	return `"${s.replace(/"/g, '\\"')}"`;
}

// ---------------------------------------------------------------------------
// Action scaffolds
// ---------------------------------------------------------------------------

export interface ActionScaffoldOptions {
	name: string;
	kind: RoutingActionKind;
	description: string;
	/** Prose shown above any code fence. */
	doc: string;
	/** Capability flags (defaults applied by the parser: newNoteOnly=false, idempotent=true). */
	newNoteOnly?: boolean;
	idempotent?: boolean;
	/** `move` target directory. */
	targetDir?: string;
	/** `publish-contexts` list. */
	publishContexts?: string[];
	/** `set-frontmatter` mapping. */
	frontmatter?: Record<string, unknown>;
	/** `insert-template` template reference (`cpn-routing-template`) — a path or `[[wikilink]]`. */
	template?: string;
	/** `code` body (must be a valid TS/JS statement block). */
	code?: string;
}

/** Build a {@link BuiltinRoutingActionScaffold} with a fully-rendered `.md` body. */
export function actionScaffold(opts: ActionScaffoldOptions): BuiltinRoutingActionScaffold {
	const { name, kind, description, doc } = opts;

	const lines: string[] = [
		'---',
		`${RK.TYPE}: routing-action`,
		`${RK.ACTION_NAME}: ${name}`,
		`${RK.ACTION_KIND}: ${kind}`,
		`${RK.DESCRIPTION}: ${quote(description)}`,
	];
	if (opts.newNoteOnly !== undefined) lines.push(`${RK.NEW_NOTE_ONLY}: ${opts.newNoteOnly}`);
	if (opts.idempotent !== undefined) lines.push(`${RK.IDEMPOTENT}: ${opts.idempotent}`);
	if (opts.targetDir !== undefined) lines.push(`${RK.TARGET_DIR}: ${quote(opts.targetDir)}`);
	if (opts.publishContexts !== undefined) {
		lines.push(`${RK.PUBLISH_CONTEXTS}: ${JSON.stringify(opts.publishContexts)}`);
	}
	if (opts.frontmatter !== undefined) {
		lines.push(`${RK.FRONTMATTER}:`);
		// Indent the nested YAML mapping by two spaces.
		const nested = stringifyYaml(opts.frontmatter).trimEnd();
		for (const l of nested.split('\n')) lines.push(`  ${l}`);
	}
	if (opts.template !== undefined) lines.push(`${RK.TEMPLATE}: ${quote(opts.template)}`);
	lines.push('---', '', doc.trimEnd(), '');

	if (opts.code !== undefined) {
		lines.push('```ts', opts.code.trim(), '```', '');
	}

	return { name, kind, description, scaffoldContent: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Option scaffolds
// ---------------------------------------------------------------------------

export interface OptionScaffoldOptions {
	name: string;
	description: string;
	onError?: 'abort' | 'continue';
	titlePrompt?: 'always' | 'only-if-Untitled' | 'off';
	steps: RawStep[];
}

/** Render a `RawStep` into the YAML form authored under `cpn-routing-steps`. */
function renderStep(step: RawStep): string {
	if ('ref' in step) {
		if (!step.params || Object.keys(step.params).length === 0) {
			return `  - "[[${step.ref}]]"`;
		}
		const params = JSON.stringify(step.params);
		return `  - { action: "[[${step.ref}]]", params: ${params} }`;
	}
	// Inline step — render the spec object under `inline:`.
	const inlineYaml = stringifyYaml({ inline: step.inline }).trimEnd();
	return inlineYaml
		.split('\n')
		.map((l, i) => (i === 0 ? `  - ${l}` : `    ${l}`))
		.join('\n');
}

/** Build a {@link BuiltinRoutingOptionScaffold} with a fully-rendered `.md` body. */
export function optionScaffold(opts: OptionScaffoldOptions): BuiltinRoutingOptionScaffold {
	const { name, description, steps } = opts;

	const lines: string[] = [
		'---',
		`${RK.TYPE}: routing-option`,
		`${RK.OPTION_NAME}: ${quote(name)}`,
		`${RK.DESCRIPTION}: ${quote(description)}`,
	];
	if (opts.onError !== undefined) lines.push(`${RK.ON_ERROR}: ${opts.onError}`);
	if (opts.titlePrompt !== undefined) lines.push(`${RK.TITLE_PROMPT}: ${opts.titlePrompt}`);
	lines.push(`${RK.STEPS}:`);
	for (const step of steps) lines.push(renderStep(step));
	lines.push('---', '', `Routing option: ${description}`, '');

	return { name, description, scaffoldContent: lines.join('\n') };
}
