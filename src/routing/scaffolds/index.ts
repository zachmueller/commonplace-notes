/**
 * Canonical built-in routing actions, as overridable scaffolds.
 *
 * Each entry's `scaffoldContent` is BOTH the file written to the vault when a
 * user materializes it AND the in-memory fallback parsed at load time when no
 * vault file exists — so the shared actions work out of the box. A vault file
 * whose `cpn-routing-action-name` matches an entry here OVERRIDES it.
 *
 * These are the generic building blocks (`move`, `set-publish-contexts`,
 * `insert-template`, `ensure-uid`) that users compose into their own routing
 * OPTIONS — CPN ships no built-in options, so adopters aren't locked into any
 * particular vault layout.
 *
 * Analogue of the parser subsystem's `BUILTIN_PARSER_SCAFFOLDS`.
 */

import type { BuiltinRoutingActionScaffold, BuiltinRoutingOptionScaffold } from '../types';
import { MOVE } from './move';
import { SET_PUBLISH_CONTEXTS } from './set-publish-contexts';
import { INSERT_TEMPLATE } from './insert-template';
import { ENSURE_UID } from './ensure-uid';

const ACTION_SCAFFOLDS: BuiltinRoutingActionScaffold[] = [
	MOVE,
	SET_PUBLISH_CONTEXTS,
	INSERT_TEMPLATE,
	ENSURE_UID,
];

// CPN ships no built-in options; users author their own from the shared actions.
const OPTION_SCAFFOLDS: BuiltinRoutingOptionScaffold[] = [];

export const BUILTIN_ROUTING_ACTION_SCAFFOLDS: ReadonlyMap<string, BuiltinRoutingActionScaffold> =
	new Map(ACTION_SCAFFOLDS.map((s) => [s.name, s]));

export const BUILTIN_ROUTING_OPTION_SCAFFOLDS: ReadonlyMap<string, BuiltinRoutingOptionScaffold> =
	new Map(OPTION_SCAFFOLDS.map((s) => [s.name, s]));
