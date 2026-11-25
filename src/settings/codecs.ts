import { Notice, debounce } from 'obsidian';
import type CommonplaceNotesPlugin from '../main';
import { Logger } from '../utils/logging';
import { formatExtensionList, parseExtensionList, resolveAttachmentSettings, type AttachmentMode, type AttachmentSettings } from '../utils/attachments';
import { KeyScope, matchPath, toPath } from './keys';
import { THEME_DEFAULTS, ensureSiteCustomization, type ThemeMode } from './profile/siteCustomization';
import type { PublishingProfile, ThemeColors } from '../types';

/** Returned from {@link KeyCodec.write} to delete the field instead of storing a value. */
export const DELETE = Symbol('delete');

export interface CodecContext {
	plugin: CommonplaceNotesPlugin;
	/** The object the path is resolved against: plugin.settings or a profile. */
	target: Record<string, unknown>;
	/** The key's path segments (unescaped). */
	path: readonly string[];
	/** Rebuild the definitions and re-render the current page. */
	refresh: () => void;
}

/**
 * The non-assignment side of a control key (spec §3): how a stored value is
 * shown, how an edited value is stored, and what has to happen afterwards.
 * `validate` on the control rejects input; codecs never reject, only map.
 */
export interface KeyCodec {
	scope: KeyScope;
	/** Path pattern; `*` matches one segment, a trailing `**` the rest. */
	pattern: readonly string[];
	/** Map the stored value to the control's value. */
	read?: (stored: unknown, ctx: CodecContext) => unknown;
	/** Prepare the target before the write (e.g. fill in a partial object). */
	before?: (ctx: CodecContext) => void;
	/** Map the control's value to the stored value, or {@link DELETE}. */
	write?: (value: unknown, ctx: CodecContext) => unknown;
	/** Side effects after the in-memory write (the save is debounced separately). */
	after?: (value: unknown, ctx: CodecContext) => void;
}

/** Build a codec from a dotted pattern literal. */
export function codec(scope: KeyScope, pattern: string, rest: Omit<KeyCodec, 'scope' | 'pattern'>): KeyCodec {
	return { scope, pattern: toPath(pattern), ...rest };
}

/** First codec whose scope and pattern match. */
export function findCodec(codecs: readonly KeyCodec[], scope: KeyScope, path: readonly string[]): KeyCodec | undefined {
	return codecs.find(c => c.scope === scope && matchPath(c.pattern, path));
}

/** Codecs for the global (plugin.settings) keys. */
export const GENERAL_CODECS: KeyCodec[] = [
	codec('general', 'debugMode', {
		after: value => Logger.setDebugMode(value === true),
	}),
	codec('general', 'cpnDirectory', {
		read: stored => (typeof stored === 'string' && stored) ? stored : 'cpn',
		write: value => (typeof value === 'string' ? value.trim() : '') || 'cpn',
	}),
];

/** Profile names and ids feed command names; re-register once typing settles. */
const reRegisterProfileCommands = debounce((plugin: CommonplaceNotesPlugin) => {
	plugin.registerProfileCommands();
}, 600, true);

function attachmentsOf(target: Record<string, unknown>): AttachmentSettings {
	return resolveAttachmentSettings(target.attachments as Partial<AttachmentSettings> | undefined);
}

/** Fill in the profile's siteCustomization defaults before any write under it. */
function ensureCustom(ctx: CodecContext): void {
	ensureSiteCustomization(ctx.target as unknown as PublishingProfile);
}

/** A theme color equal to the theme default is dropped, as the old Reset did. */
function themeColorCodec(pattern: string): KeyCodec {
	return codec('profile', pattern, {
		before: ensureCustom,
		write: (value, ctx) => {
			const [mode, field] = ctx.path.slice(-2) as [ThemeMode, keyof ThemeColors];
			return value === THEME_DEFAULTS[mode]?.[field] ? DELETE : value;
		},
	});
}

/** Codecs for per-profile keys; the target is the profile object. */
export const PROFILE_CODECS: KeyCodec[] = [
	// Site customization: specific paths first (first match wins).
	themeColorCodec('siteCustomization.themeOverrides.*.*'),
	themeColorCodec('siteCustomization.namedStyles.*.*.*'),
	codec('profile', 'siteCustomization.namedStyles.*.fontFamily', {
		before: ensureCustom,
		write: value => String(value ?? '').trim() || DELETE,
	}),
	codec('profile', 'siteCustomization.namedStyles.*.css', {
		// Stored raw to keep the author's formatting; whitespace-only clears it.
		before: ensureCustom,
		write: value => String(value ?? '').trim() ? value : DELETE,
	}),
	codec('profile', 'siteCustomization.**', { before: ensureCustom }),
	codec('profile', 'accessGroups.*.description', {
		write: value => String(value ?? '').trim() || DELETE,
	}),
	codec('profile', 'name', { after: (_v, ctx) => reRegisterProfileCommands(ctx.plugin) }),
	codec('profile', 'id', { after: (_v, ctx) => reRegisterProfileCommands(ctx.plugin) }),
	codec('profile', 'excludedDirectories', {
		read: stored => Array.isArray(stored) ? stored.join('\n') : '',
		write: value => String(value).split('\n').filter(line => line.trim() !== ''),
	}),
	codec('profile', 'awsSettings.s3Prefix', {
		write: value => {
			const v = typeof value === 'string' ? value : '';
			return v ? (v.endsWith('/') ? v : `${v}/`) : '';
		},
	}),
	// Attachments are stored as a full object once edited (resolved defaults
	// filled in), as before; reads fall back to the defaults.
	codec('profile', 'attachments.allowedExtensions', {
		read: (_s, ctx) => formatExtensionList(attachmentsOf(ctx.target).allowedExtensions),
		before: ctx => { ctx.target.attachments = attachmentsOf(ctx.target); },
		write: value => parseExtensionList(String(value)),
	}),
	codec('profile', 'attachments.mode', {
		read: (_s, ctx) => attachmentsOf(ctx.target).mode,
		before: ctx => { ctx.target.attachments = attachmentsOf(ctx.target); },
		write: (value, ctx) => {
			const before = attachmentsOf(ctx.target).mode;
			const mode = value as AttachmentMode;
			if (before === 'off' && mode !== 'off') {
				new Notice('Attachments are on. Run "Publish all notes" once so existing notes pick up their attachments.', 12000);
			}
			return mode;
		},
	}),
	codec('profile', 'attachments.inlinePdfs', {
		read: (_s, ctx) => attachmentsOf(ctx.target).inlinePdfs,
		before: ctx => { ctx.target.attachments = attachmentsOf(ctx.target); },
		after: () => { new Notice('Run "Publish all notes" so published notes pick up the change.', 12000); },
	}),
	codec('profile', 'attachments.maxFileSizeMB', {
		read: (_s, ctx) => attachmentsOf(ctx.target).maxFileSizeMB,
		before: ctx => { ctx.target.attachments = attachmentsOf(ctx.target); },
		write: value => Math.round(Number(value)),
	}),
];
