import { App } from 'obsidian';
import CommonplaceNotesPlugin from '../main';
import { PublishingProfile } from '../types';

/**
 * Shared handles threaded into the extracted settings renderers in place of the
 * `this` they used to close over when they were methods on the setting tab.
 * `rerenderAll` rebuilds the whole tab (tab bar + active pane, restoring the
 * persisted tab); `rerenderProfile` rebuilds only the active-profile pane.
 * `createSection` is the collapsible-subsection factory (persists open state).
 */
export interface SettingsContext {
	app: App;
	plugin: CommonplaceNotesPlugin;
	rerenderAll: () => void;
	rerenderProfile: () => void;
	createSection: (parent: HTMLElement, title: string, opts?: { defaultCollapsed?: boolean }) => HTMLElement;
	/** Update the active-profile dropdown's label in place (no full re-render). */
	updateProfileDropdownLabel: (index: number, name: string) => void;
}

/** Context for per-profile renderers, carrying the active profile and its index. */
export interface ProfileContext extends SettingsContext {
	profile: PublishingProfile;
	index: number;
}
