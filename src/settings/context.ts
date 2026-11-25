import { App } from 'obsidian';
import CommonplaceNotesPlugin from '../main';
import { PublishingProfile } from '../types';
import type { PathInput, RefRegistry } from './keys';
import type { PageNameSnapshot } from './pageNames';

/**
 * Shared handles threaded into the legacy (imperative) settings renderers, which
 * run inside `LegacyPage` adapters until each is converted to definitions.
 * `rerenderAll` rebuilds the definitions and the current page; `rerenderProfile`
 * re-displays only the current page. `createSection` is the collapsible
 * subsection factory (persists open state).
 */
export interface SettingsContext {
	app: App;
	plugin: CommonplaceNotesPlugin;
	rerenderAll: () => void;
	rerenderProfile: () => void;
	createSection: (parent: HTMLElement, title: string, opts?: { defaultCollapsed?: boolean }) => HTMLElement;
	/** No-op since the profile dropdown is gone; kept until P5 for legacy callers. */
	updateProfileDropdownLabel: (index: number, name: string) => void;
}

/** Context for per-profile renderers, carrying the active profile and its index. */
export interface ProfileContext extends SettingsContext {
	profile: PublishingProfile;
	index: number;
}

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
