import { App } from 'obsidian';
import CommonplaceNotesPlugin from '../main';
import type { PublishingProfile } from '../types';
import type { PathInput, RefRegistry } from './keys';
import type { PageNameSnapshot } from './pageNames';

/**
 * Context for the declarative definition builders (`xDefinitions(ctx)`).
 * Keys come from {@link generalKey} / {@link profileKey}; structural changes
 * call {@link refresh}; visibility-only changes rely on the framework's own
 * refreshDomState after each write.
 */
export interface DefinitionContext {
	app: App;
	plugin: CommonplaceNotesPlugin;
	/** Key for a field under plugin.settings. */
	generalKey: (path: PathInput) => string;
	/** Key for a field under `profile`, addressed by its session ref. */
	profileKey: (profile: PublishingProfile, path: PathInput) => string;
	/** Session refs for profiles and other user-named objects. */
	refs: RefRegistry;
	/** Stable page names for user-named items (spec §4). */
	names: PageNameSnapshot;
	/** Rebuild the definitions and re-render the current page. */
	refresh: () => void;
	/** Re-evaluate `visible` / `disabled` predicates in place. */
	refreshDomState: () => void;
	/** Persist plugin settings now (bypassing the control debounce). */
	save: () => Promise<void>;
	/**
	 * Write a control key from a `render` row's own inputs, exactly as a
	 * `control` row would (codecs, debounced save).
	 */
	write: (key: string, value: unknown) => void;
	/** Read a control key through its codec, as a `control` row would. */
	read: (key: string) => unknown;
}
