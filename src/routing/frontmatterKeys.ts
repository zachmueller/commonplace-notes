/**
 * Frontmatter key names read/written by the note-routing engine.
 *
 * Single source of truth — every routing frontmatter access (parsers, scaffold
 * writer, error messages) flows through here so read and write sites can't drift
 * apart. The routing-exclusive keys carry the `cpn-routing-` prefix to make it
 * clear they configure routing (distinct from ordinary `cpn-` note properties
 * and the parser/asset subsystems' `cpn-*` config).
 */

export const RK = {
	// -- routing-exclusive (cpn-routing-*) --
	ACTION_NAME: 'cpn-routing-action-name',
	ACTION_KIND: 'cpn-routing-action-kind',
	OPTION_NAME: 'cpn-routing-option-name',
	ON_ERROR: 'cpn-routing-on-error',
	TITLE_PROMPT: 'cpn-routing-title-prompt',
	STEPS: 'cpn-routing-steps',
	NEW_NOTE_ONLY: 'cpn-routing-new-note-only',
	IDEMPOTENT: 'cpn-routing-idempotent',
	TARGET_DIR: 'cpn-routing-target-dir',
	FRONTMATTER: 'cpn-routing-frontmatter',
	TEMPLATE: 'cpn-routing-template',

	// -- shared keys the routing parsers also read — kept UNprefixed by design --
	// `cpn-type` is the discriminator shared with the parser & asset subsystems
	// (routing-ness lives in its value: `routing-action` / `routing-option`).
	// `cpn-description` is a generic description shared with the parser subsystem.
	// `cpn-publish-contexts` is the core note-publishing property; the
	// `publish-contexts` action deliberately reuses it. Do NOT prefix these.
	// `cpn-uid` is the core stable note identifier (backs published URLs); the
	// `ensure-uid` action reuses it. Do NOT prefix.
	TYPE: 'cpn-type',
	DESCRIPTION: 'cpn-description',
	PUBLISH_CONTEXTS: 'cpn-publish-contexts',
	UID: 'cpn-uid',
} as const;
