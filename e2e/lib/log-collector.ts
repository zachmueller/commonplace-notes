/**
 * Log Collector
 *
 * Captures logs from Obsidian's console via Playwright's CDP connection
 * and writes them to JSONL files on disk.
 *
 * The collector:
 *  1. Listens to console events on a Playwright Page
 *  2. Filters for plugin log entries (prefixed with [CPN])
 *  3. Writes each entry as a JSON line to a .jsonl file
 *  4. Also captures all console output for debugging
 *  5. Writes a summary file at the end for quick review
 *
 * Recognizes the Logger prefixes from src/utils/logging.ts:
 *   [CPN Debug] ... -> level: debug
 *   [CPN]       ... -> level: info
 *   [CPN Warning] ... -> level: warn
 *   [CPN Error]   ... -> level: error
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Page, ConsoleMessage } from "playwright-core";

const LOG_PREFIXES: { prefix: string; level: string }[] = [
	{ prefix: "[CPN Error]", level: "error" },
	{ prefix: "[CPN Warning]", level: "warn" },
	{ prefix: "[CPN Debug]", level: "debug" },
	{ prefix: "[CPN]", level: "info" },
];

export interface CollectorOptions {
	/** Directory to write log files into */
	outputDir: string;
	/** Also capture non-plugin console output (default: true) */
	captureAll?: boolean;
	/** Maximum log entries before rotating (default: 10000) */
	maxEntries?: number;
}

export interface LogEntry {
	timestamp: string;
	level: string;
	source: string;
	message: string;
	data?: unknown;
}

export interface RawConsoleEntry {
	timestamp: string;
	type: string;
	text: string;
}

export class LogCollector {
	private structuredLogs: LogEntry[] = [];
	private rawLogs: RawConsoleEntry[] = [];
	private structuredStream: fs.WriteStream;
	private rawStream: fs.WriteStream | null = null;
	private options: Required<CollectorOptions>;
	private disposed = false;

	constructor(options: CollectorOptions) {
		this.options = {
			captureAll: true,
			maxEntries: 10_000,
			...options,
		};

		fs.mkdirSync(this.options.outputDir, { recursive: true });

		const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
		this.structuredStream = fs.createWriteStream(
			path.join(this.options.outputDir, `plugin-logs-${timestamp}.jsonl`),
			{ flags: "a" }
		);

		if (this.options.captureAll) {
			this.rawStream = fs.createWriteStream(
				path.join(this.options.outputDir, `console-all-${timestamp}.jsonl`),
				{ flags: "a" }
			);
		}
	}

	/**
	 * Attach to a Playwright page and start collecting console logs.
	 */
	attach(page: Page): void {
		page.on("console", (msg: ConsoleMessage) => {
			this.handleConsoleMessage(msg);
		});

		page.on("pageerror", (error: Error) => {
			const entry: LogEntry = {
				timestamp: new Date().toISOString(),
				level: "error",
				source: "page-error",
				message: error.message,
				data: { stack: error.stack },
			};
			this.writeStructured(entry);
		});
	}

	private handleConsoleMessage(msg: ConsoleMessage): void {
		const text = msg.text();
		const msgType = msg.type();

		// Capture raw console output
		if (this.options.captureAll && this.rawStream) {
			const raw: RawConsoleEntry = {
				timestamp: new Date().toISOString(),
				type: msgType,
				text,
			};
			this.rawLogs.push(raw);
			this.rawStream.write(JSON.stringify(raw) + "\n");
		}

		// Check for CPN plugin log entries
		for (const { prefix, level } of LOG_PREFIXES) {
			if (text.startsWith(prefix)) {
				const message = text.slice(prefix.length).trim();
				const entry: LogEntry = {
					timestamp: new Date().toISOString(),
					level,
					source: "plugin",
					message,
				};
				this.writeStructured(entry);
				return;
			}
		}

		// Also capture console.error and console.warn from any source
		if (msgType === "error" || msgType === "warning") {
			const entry: LogEntry = {
				timestamp: new Date().toISOString(),
				level: msgType === "warning" ? "warn" : "error",
				source: "console",
				message: text,
			};
			this.writeStructured(entry);
		}
	}

	private writeStructured(entry: LogEntry): void {
		if (this.disposed) return;

		this.structuredLogs.push(entry);
		this.structuredStream.write(JSON.stringify(entry) + "\n");

		if (this.structuredLogs.length > this.options.maxEntries) {
			this.structuredLogs = this.structuredLogs.slice(-Math.floor(this.options.maxEntries / 2));
		}
	}

	/** Get all structured log entries collected so far. */
	getStructuredLogs(): LogEntry[] {
		return [...this.structuredLogs];
	}

	/** Get log entries filtered by level. */
	getLogsByLevel(level: string): LogEntry[] {
		return this.structuredLogs.filter((e) => e.level === level);
	}

	/** Get log entries filtered by source. */
	getLogsBySource(source: string): LogEntry[] {
		return this.structuredLogs.filter((e) => e.source === source);
	}

	/** Check if any error-level logs have been captured. */
	hasErrors(): boolean {
		return this.structuredLogs.some((e) => e.level === "error");
	}

	/**
	 * Write a summary file with stats and recent errors for quick review.
	 */
	writeSummary(): string {
		const summaryPath = path.join(this.options.outputDir, "latest-summary.json");

		const errors = this.getLogsByLevel("error");
		const warnings = this.getLogsByLevel("warn");

		const summary = {
			generatedAt: new Date().toISOString(),
			stats: {
				totalEntries: this.structuredLogs.length,
				errors: errors.length,
				warnings: warnings.length,
				sources: [...new Set(this.structuredLogs.map((e) => e.source))],
			},
			recentErrors: errors.slice(-20),
			recentWarnings: warnings.slice(-10),
			lastEntries: this.structuredLogs.slice(-30),
		};

		fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
		return summaryPath;
	}

	/** Close all streams and finalize logs. */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;

		this.writeSummary();

		return new Promise((resolve) => {
			this.structuredStream.end(() => {
				if (this.rawStream) {
					this.rawStream.end(() => resolve());
				} else {
					resolve();
				}
			});
		});
	}
}
