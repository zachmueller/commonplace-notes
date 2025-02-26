export class Logger {
	private static debugMode: boolean = false;

	static setDebugMode(enabled: boolean) {
		this.debugMode = enabled;
	}

	static debug(message: string, ...args: any[]) {
		if (this.debugMode) {
			console.log(`[CPN Debug] ${message}`, ...args);
		}
	}

	static info(message: string, ...args: any[]) {
		console.log(`[CPN] ${message}`, ...args);
	}

	static warn(message: string, ...args: any[]) {
		console.warn(`[CPN Warning] ${message}`, ...args);
	}

	static error(message: string, ...args: any[]) {
		console.error(`[CPN Error] ${message}`, ...args);
	}
}