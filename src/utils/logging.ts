export class Logger {
	private static debugMode: boolean = false;

	static setDebugMode(enabled: boolean) {
		this.debugMode = enabled;
	}

	static debug(message: string, ...args: unknown[]) {
		if (this.debugMode) {
			console.log(`[CPN Debug] ${message}`, ...args);
		}
	}

	static info(message: string, ...args: unknown[]) {
		console.log(`[CPN] ${message}`, ...args);
	}

	static warn(message: string, ...args: unknown[]) {
		console.warn(`[CPN Warning] ${message}`, ...args);
	}

	static error(message: string, ...args: unknown[]) {
		console.error(`[CPN Error] ${message}`, ...args);
	}
}

/** Narrow an unknown caught value to a human-readable message. Standardizes the
 *  `String(err?.message || err)` / `err instanceof Error ? err.message : String(err)`
 *  idioms used across the plugin so `catch (err: unknown)` blocks can read a message
 *  without an `any` cast. Reads `.message` off Error instances and plain rejection
 *  objects alike, falling back to `String(err)`. */
export function errorMessage(err: unknown): string {
	if (err && typeof err === 'object' && 'message' in err) {
		const message = (err as { message?: unknown }).message;
		if (message) return String(message);
	}
	return String(err);
}

/** Extract an error/status code from an unknown caught value. AWS SDK errors expose
 *  it as `.name`; some (v2-style / raw) responses use `.Code`. Preserves the
 *  `err?.name || err?.Code` idiom for `catch (err: unknown)` blocks. (Node system
 *  errors use a lowercase `.code` — read that directly rather than via this helper,
 *  since AWS `Error` instances also carry a truthy `.name`.) */
export function errorCode(err: unknown): string | undefined {
	if (err && typeof err === 'object') {
		const e = err as { name?: unknown; Code?: unknown };
		const code = e.name || e.Code;
		if (code !== undefined && code !== null) return String(code);
	}
	return undefined;
}