import type CommonplaceNotesPlugin from '../main';
import { Logger } from '../utils/logging';
import { KeyScope, matchPath, toPath } from './keys';

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
