/**
 * Canonical built-in routing actions and options, as overridable scaffolds.
 *
 * Each entry's `scaffoldContent` is BOTH the file written to the vault when a
 * user materializes it AND the in-memory fallback parsed at load time when no
 * vault file exists — so routing works out of the box. A vault file whose
 * `cpn-action-name` / `cpn-option-name` matches an entry here OVERRIDES it.
 *
 * Analogue of the parser subsystem's `BUILTIN_PARSER_SCAFFOLDS`.
 */

import type { BuiltinRoutingActionScaffold, BuiltinRoutingOptionScaffold } from '../types';
import { MOVE } from './move';
import { SET_PUBLISH_CONTEXTS } from './set-publish-contexts';
import { DEFAULT_FRONTMATTER } from './default-frontmatter';
import { INSERT_TEMPLATE } from './insert-template';
import { CODE_EXAMPLE } from './code-example';
import { OPTION_PUBLIC_ALL, OPTION_PRIVATE, OPTION_AMAZON_ONLY } from './options';

const ACTION_SCAFFOLDS: BuiltinRoutingActionScaffold[] = [
	MOVE,
	SET_PUBLISH_CONTEXTS,
	DEFAULT_FRONTMATTER,
	INSERT_TEMPLATE,
	CODE_EXAMPLE,
];

const OPTION_SCAFFOLDS: BuiltinRoutingOptionScaffold[] = [
	OPTION_PUBLIC_ALL,
	OPTION_PRIVATE,
	OPTION_AMAZON_ONLY,
];

export const BUILTIN_ROUTING_ACTION_SCAFFOLDS: ReadonlyMap<string, BuiltinRoutingActionScaffold> =
	new Map(ACTION_SCAFFOLDS.map((s) => [s.name, s]));

export const BUILTIN_ROUTING_OPTION_SCAFFOLDS: ReadonlyMap<string, BuiltinRoutingOptionScaffold> =
	new Map(OPTION_SCAFFOLDS.map((s) => [s.name, s]));
