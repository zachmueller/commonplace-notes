import { App, Debouncer, Notice, PluginSettingTab, SettingDefinitionItem, SettingDefinitionPage, debounce } from 'obsidian';
import CommonplaceNotesPlugin from '../main';
import { PublishingProfile } from '../types';
import { Logger } from '../utils/logging';
import { DefinitionContext } from './context';
import { DELETE, GENERAL_CODECS, KeyCodec, PROFILE_CODECS, findCodec } from './codecs';
import { RefRegistry, buildGeneralKey, buildProfileKey, deleteAtPath, getAtPath, parseKey, setAtPath } from './keys';
import { NamedItem, PageNameSnapshot } from './pageNames';
import { guardRenders } from './guard';
import { generalDefinitions } from './tabs/generalTab';
import { parserDefinitions } from './tabs/parserTab';
import { routingDefinitions } from './tabs/routingTab';
import { profilePage, profileTombstone } from './profile/page';
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
	private readonly codecs: KeyCodec[] = [...GENERAL_CODECS, ...PROFILE_CODECS];
	private readonly debouncedSave: Debouncer<[], void>;

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
		return guardRenders([
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
		]);
	}

	private profilesList(): SettingDefinitionItem {
		const profiles = this.plugin.settings.publishingProfiles;
		// Each profile on its own: one malformed entry in data.json is logged and
		// left out rather than throwing out of getSettingDefinitions() (which runs
		// inside addSettingTab during onload, so it would stop the plugin loading).
		const items: NamedItem[] = [];
		for (const p of profiles) {
			try {
				items.push({ ref: this.refs.refFor(p), name: p.name });
			} catch (error) {
				Logger.error('Leaving a malformed publishing profile out of settings:', error);
			}
		}
		const named = this.names.resolve(PROFILES_SCOPE, items);
		const ctx = this.definitionContext();
		const pages: SettingDefinitionPage[] = named.map(({ ref, name }) => {
			const profile = this.refs.resolve<PublishingProfile>(ref)!;
			return profilePage(ctx, profile, name);
		});
		const tombstones = this.names.removed(PROFILES_SCOPE).map(({ name }) => profileTombstone(name));
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
			write: (key, value) => this.setControlValue(key, value),
			read: key => this.getControlValue(key),
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
	 * re-render the current page in place. Plugin code outside the tab (e.g.
	 * the deployment wizard) calls this after changing a profile.
	 */
	refresh(): void {
		this.update();
	}

	hide(): void {
		this.flushPendingSave();
		super.hide();
		// Renames and removals show up in page names from the next render on
		// (spec §4). Rebuild after Obsidian has finished switching away.
		this.names.clear();
		window.setTimeout(() => this.update(), 0);
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
