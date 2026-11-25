import { App, Debouncer, Notice, PluginSettingTab, SettingDefinitionItem, SettingDefinitionPage, debounce } from 'obsidian';
import CommonplaceNotesPlugin from '../main';
import { PublishingProfile, SettingsUiState } from '../types';
import { Logger, errorMessage } from '../utils/logging';
import { DefinitionContext, SettingsContext, ProfileContext } from './context';
import { DELETE, GENERAL_CODECS, KeyCodec, findCodec } from './codecs';
import { RefRegistry, buildGeneralKey, buildProfileKey, deleteAtPath, getAtPath, parseKey, setAtPath } from './keys';
import { PageNameSnapshot } from './pageNames';
import { LegacyPage } from './legacyPage';
import { generalDefinitions } from './tabs/generalTab';
import { parserDefinitions } from './tabs/parserTab';
import { routingDefinitions } from './tabs/routingTab';
import { renderIdentitySection } from './profile/identity';
import { renderContentSection } from './profile/content';
import { renderDestinationSection } from './profile/destination';
import { renderDangerZone } from './profile/dangerZone';
import { renderAccessGroupsSection } from './profile/accessGroups';
import { EXCLUDED_DIRS_RULES_VERSION } from '../utils/excludedDirectories';

/** Delay before a control edit is persisted; text controls write per keystroke. */
const SAVE_DEBOUNCE_MS = 400;

/** Page-name snapshot scope for the profile list. */
const PROFILES_SCOPE = 'profiles';

/**
 * CPN's settings tab, built on Obsidian's declarative settings API
 * (`getSettingDefinitions()`), so every setting is reachable from settings
 * search. See specs/declarative-settings/design.md.
 *
 * Controls bind to path keys (keys.ts) resolved by getControlValue /
 * setControlValue against plugin.settings or a profile's session ref; codecs
 * (codecs.ts) hold any non-assignment behavior.
 */
export class CommonplaceNotesSettingTab extends PluginSettingTab {
	plugin: CommonplaceNotesPlugin;
	private readonly refs = new RefRegistry('r');
	private readonly names = new PageNameSnapshot();
	private readonly codecs: KeyCodec[] = [...GENERAL_CODECS];
	private readonly debouncedSave: Debouncer<[], void>;
	/** The legacy adapter page currently on screen, if any (redrawn by refresh()). */
	private shownLegacyPage: LegacyPage | null = null;

	constructor(app: App, plugin: CommonplaceNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.debouncedSave = debounce(() => {
			this.plugin.saveSettings().catch(err => Logger.error('Could not save settings:', err));
		}, SAVE_DEBOUNCE_MS, true);
	}

	// --- Definitions --------------------------------------------------------

	getSettingDefinitions(): SettingDefinitionItem[] {
		const ctx = this.definitionContext();
		return [
			...generalDefinitions(ctx),
			{
				type: 'group',
				items: [
					{
						type: 'page',
						name: 'Markdown parser',
						desc: 'CPN directory and the built-in parser stages you can override from the vault.',
						items: parserDefinitions(ctx),
					},
					{
						type: 'page',
						name: 'Note routing',
						desc: 'New-note title prompt and the built-in routing actions and options.',
						items: routingDefinitions(ctx),
					},
				],
			},
			this.profilesList(),
		];
	}

	private profilesList(): SettingDefinitionItem {
		const profiles = this.plugin.settings.publishingProfiles;
		const named = this.names.resolve(PROFILES_SCOPE, profiles.map(p => ({ ref: this.refs.refFor(p), name: p.name })));
		const pages: SettingDefinitionPage[] = named.map(({ ref, name }) => {
			const profile = this.refs.resolve<PublishingProfile>(ref)!;
			return {
				type: 'page',
				name,
				desc: profile.publishMechanism === 'Local' ? 'Local' : 'AWS',
				page: () => this.legacyPage(el => this.renderProfilePage(el, profile)),
			};
		});
		const tombstones: SettingDefinitionPage[] = this.names.removed(PROFILES_SCOPE).map(({ name }) => ({
			type: 'page',
			name,
			visible: false,
			items: [{ name: 'Profile removed', desc: 'This profile was deleted. Go back to the profile list.' }],
		}));
		return {
			type: 'list',
			heading: 'Publishing profiles',
			emptyState: 'No profiles configured. Add one with the + button.',
			addItem: { name: 'Add profile', action: () => { void this.addNewProfile(); } },
			items: [...pages, ...tombstones],
		};
	}

	private definitionContext(): DefinitionContext {
		return {
			app: this.app,
			plugin: this.plugin,
			generalKey: path => buildGeneralKey(path),
			profileKey: (profile, path) => buildProfileKey(this.refs.refFor(profile), path),
			refs: this.refs,
			names: this.names,
			refresh: () => this.refresh(),
			refreshDomState: () => this.refreshDomState(),
			save: () => this.saveNow(),
		};
	}

	// --- Control storage ----------------------------------------------------

	private resolveKey(key: string): { target: Record<string, unknown>; path: string[]; codec?: KeyCodec } | null {
		const parsed = parseKey(key);
		if (!parsed) {
			Logger.warn(`Settings: malformed control key "${key}"`);
			return null;
		}
		const target = parsed.scope === 'general'
			? this.plugin.settings as unknown as Record<string, unknown>
			: this.refs.resolve<Record<string, unknown>>(parsed.ref);
		if (!target) {
			Logger.warn(`Settings: control key "${key}" refers to an unknown profile`);
			return null;
		}
		return { target, path: parsed.path, codec: findCodec(this.codecs, parsed.scope, parsed.path) };
	}

	getControlValue(key: string): unknown {
		const resolved = this.resolveKey(key);
		if (!resolved) return undefined;
		const { target, path, codec } = resolved;
		const stored = getAtPath(target, path);
		return codec?.read ? codec.read(stored, this.codecContext(target, path)) : stored;
	}

	setControlValue(key: string, value: unknown): void {
		const resolved = this.resolveKey(key);
		if (!resolved) return;
		const { target, path, codec } = resolved;
		const cctx = this.codecContext(target, path);
		codec?.before?.(cctx);
		const stored = codec?.write ? codec.write(value, cctx) : value;
		if (stored === DELETE) deleteAtPath(target, path);
		else setAtPath(target, path, stored);
		this.debouncedSave();
		codec?.after?.(value, cctx);
	}

	private codecContext(target: Record<string, unknown>, path: readonly string[]) {
		return { plugin: this.plugin, target, path, refresh: () => this.refresh() };
	}

	/** Persist now, cancelling any pending debounced save. */
	async saveNow(): Promise<void> {
		this.debouncedSave.cancel();
		await this.plugin.saveSettings();
	}

	/** Run a pending debounced save immediately (tab hidden, plugin unloading). */
	flushPendingSave(): void {
		this.debouncedSave.run();
	}

	// --- Refresh / lifecycle --------------------------------------------------

	/**
	 * Rebuild the definitions (structure, page names, displayValue/status) and
	 * re-render the current page, including a legacy adapter page, which
	 * `update()` alone does not redraw.
	 */
	refresh(): void {
		this.update();
		this.shownLegacyPage?.display();
	}

	hide(): void {
		this.flushPendingSave();
		super.hide();
		// Renames and removals show up in page names from the next render on
		// (spec §4). Rebuild after Obsidian has finished switching away.
		this.names.clear();
		window.setTimeout(() => this.update(), 0);
	}

	// --- Legacy adapters (removed as areas are converted) ---------------------

	private legacyPage(render: (el: HTMLElement) => void): LegacyPage {
		return new LegacyPage(
			el => render(el),
			(page, shown) => {
				if (shown) this.shownLegacyPage = page;
				else if (this.shownLegacyPage === page) this.shownLegacyPage = null;
			},
		);
	}

	/** Context for the legacy renderers; re-renders target the adapter on screen. */
	private legacyContext(): SettingsContext {
		return {
			app: this.app,
			plugin: this.plugin,
			rerenderAll: () => this.refresh(),
			rerenderProfile: () => this.shownLegacyPage?.display(),
			createSection: (parent, title, opts) => this.createSection(parent, title, opts),
			updateProfileDropdownLabel: () => { /* no dropdown; names refresh on hide (spec §4) */ },
		};
	}

	private renderProfilePage(containerEl: HTMLElement, profile: PublishingProfile): void {
		const index = this.plugin.settings.publishingProfiles.indexOf(profile);
		if (index === -1) {
			containerEl.createEl('p', {
				text: 'This profile was deleted. Go back to the profile list.',
				cls: 'cpn-no-profiles-message',
			});
			return;
		}
		try {
			this.displayProfileSettings(containerEl, profile, index);
		} catch (error) {
			Logger.error(`Error displaying profile ${profile.name}:`, error);
			// Say so on the page: otherwise the sections after the failure just
			// vanish with no hint why.
			containerEl.createDiv({
				cls: 'setting-item-description mod-warning cpn-profile-render-error',
				text: `Some settings for this profile failed to render: ${errorMessage(error)}. See the developer console for details.`,
			});
		}
	}

	/**
	 * Build a collapsible subsection as a native <details>. Open state is keyed
	 * by title and persisted, so it survives the re-renders many handlers
	 * trigger. Content goes directly into the returned <details> (after the
	 * <summary>).
	 */
	private createSection(parent: HTMLElement, title: string, opts?: { defaultCollapsed?: boolean }): HTMLElement {
		const collapsed = this.ensureUiState().collapsedSections?.[title]
			?? (opts?.defaultCollapsed ?? false);
		const details = parent.createEl('details', { cls: 'cpn-settings-section' });
		details.open = !collapsed;
		details.createEl('summary', { cls: 'cpn-settings-section-summary', text: title });
		details.addEventListener('toggle', () => {
			const ui = this.ensureUiState();
			(ui.collapsedSections ??= {})[title] = !details.open;
			this.debouncedSave();
		});
		return details;
	}

	/** Lazily create and return the persisted Settings-tab UI state. */
	private ensureUiState(): SettingsUiState {
		if (!this.plugin.settings.settingsUiState) {
			this.plugin.settings.settingsUiState = {};
		}
		return this.plugin.settings.settingsUiState;
	}

	private displayProfileSettings(containerEl: HTMLElement, profile: PublishingProfile, index: number) {
		const profileContainer = containerEl.createDiv({ cls: 'cpn-profile-container' });

		const ctx: ProfileContext = { ...this.legacyContext(), profile, index };

		const lastUpdated = profile.lastFullPublishTimestamp ? new Date(profile.lastFullPublishTimestamp).toLocaleString() : 'n/a';
		profileContainer.createDiv({
			cls: 'cpn-profile-last-publish',
			text: `Last full publish: ${lastUpdated}`
		});

		// --- Profile Identity ---
		const identitySection = this.createSection(profileContainer, 'Profile Identity');
		renderIdentitySection(ctx, identitySection);

		// --- Content ---
		const contentSection = this.createSection(profileContainer, 'Content');
		renderContentSection(ctx, contentSection);

		// --- Destination (spawns AWS Infrastructure / Auth / Site sections) ---
		const destSection = this.createSection(profileContainer, 'Destination');
		renderDestinationSection(ctx, destSection, profileContainer);

		// --- Access groups (per-note access gating) ---
		const accessSection = this.createSection(profileContainer, 'Access groups', { defaultCollapsed: true });
		renderAccessGroupsSection(ctx, accessSection);

		// --- Danger Zone (starts collapsed so destructive actions are tucked away) ---
		const dangerSection = this.createSection(profileContainer, 'Danger Zone', { defaultCollapsed: true });
		renderDangerZone(ctx, dangerSection, profileContainer);
	}

	// --- Profiles -------------------------------------------------------------

	private async addNewProfile() {
		const newProfile: PublishingProfile = {
			name: 'New profile',
			id: `profile-${Date.now()}`,
			lastFullPublishTimestamp: 0,
			excludedDirectories: [],
			excludedDirsRulesVersion: EXCLUDED_DIRS_RULES_VERSION,
			baseUrl: '',
			homeNotePath: '',
			isPublic: false,
			publishContentIndex: true,
			obscureRawWikilinks: true,
			obscureRawAttachments: true,
			publishMechanism: 'AWS',
			indicator: {
				style: 'color',
				color: '#3366cc'
			},
			awsSettings: {
				awsAccountId: '',
				awsProfile: '',
				region: '',
				bucketName: '',
				cloudFrontInvalidationScheme: 'individual',
				credentialMode: 'sdk',
				credentialRefreshCommands: '',
				awsCliPath: ''
			}
		};

		this.plugin.settings.publishingProfiles.push(newProfile);
		await this.saveNow();
		this.refresh();
		const name = this.names.nameOf(PROFILES_SCOPE, this.refs.refFor(newProfile)) ?? newProfile.name;
		new Notice(`Added "${name}" under Publishing profiles.`);
	}
}
