import { optionScaffold } from './_scaffold-helper';

/**
 * Built-in routing options mirroring Zach's `getBaseSetups()` entries, using the
 * shared built-in actions. Adopters edit or replace these; they demonstrate the
 * hybrid composition model (shared action refs + per-step params).
 */

export const OPTION_PUBLIC_ALL = optionScaffold({
	name: 'Public (all)',
	description: 'Seed default frontmatter, keep at the vault root, publish to public + amazon.',
	onError: 'abort',
	steps: [
		{ ref: 'default-frontmatter' },
		{ ref: 'move', params: { dir: '/' } },
		{ ref: 'set-publish-contexts', params: { contexts: ['public', 'amazon'] } },
	],
});

export const OPTION_PRIVATE = optionScaffold({
	name: 'Private',
	description: 'Seed default frontmatter and move to /private. No publish contexts (never published).',
	onError: 'abort',
	steps: [
		{ ref: 'default-frontmatter' },
		{ ref: 'move', params: { dir: 'private' } },
	],
});

export const OPTION_AMAZON_ONLY = optionScaffold({
	name: 'Amazon-only',
	description: 'Seed default frontmatter, keep at the vault root, publish to amazon only.',
	onError: 'abort',
	steps: [
		{ ref: 'default-frontmatter' },
		{ ref: 'move', params: { dir: '/' } },
		{ ref: 'set-publish-contexts', params: { contexts: ['amazon'] } },
	],
});
