/**
 * Startup timing marks: a handful of timestamps taken during plugin load so the
 * cost of each startup step can be measured in a real vault (debugMode logs a
 * one-line summary) and by the e2e timing harness (e2e/scripts/startup-timing.ts,
 * which reads `plugin.startupTimings` over CDP).
 *
 * Always recorded: each mark is one performance.now() call and a push.
 *
 * Times are ms since the bundle started evaluating. esbuild.config.mjs puts
 * `__cpnEvalStart` in the banner, so it runs before any bundled module code.
 * Without the banner (e.g. tsx unit tests) the origin falls back to the timer's
 * creation.
 */

declare const __cpnEvalStart: number | undefined;

export interface StartupMark {
	/** Step that just finished (e.g. 'loadSettings'). */
	label: string;
	/** ms since the origin (bundle evaluation start). */
	at: number;
}

export interface StartupTimings {
	/** performance.now() of the origin; 0-based marks are relative to it. */
	origin: number;
	/** True when the origin is the bundle's evaluation start (banner present). */
	originIsEvalStart: boolean;
	marks: StartupMark[];
	/** Each mark's duration since the previous mark (the first since the origin). */
	steps: Record<string, number>;
}

/** The bundle's evaluation start, or undefined when the banner isn't present. */
export function bundleEvalStart(): number | undefined {
	return typeof __cpnEvalStart === 'number' ? __cpnEvalStart : undefined;
}

export class StartupTimer {
	private readonly origin: number;
	private readonly originIsEvalStart: boolean;
	private readonly marks: StartupMark[] = [];

	constructor(
		private readonly now: () => number = () => performance.now(),
		origin: number | undefined = bundleEvalStart(),
	) {
		this.originIsEvalStart = origin !== undefined;
		this.origin = origin ?? this.now();
	}

	/** Record that the step `label` just finished. */
	mark(label: string): void {
		this.marks.push({ label, at: this.now() - this.origin });
	}

	/** Snapshot of the marks with per-step durations. Repeated labels sum. */
	timings(): StartupTimings {
		const steps: Record<string, number> = {};
		let prev = 0;
		for (const { label, at } of this.marks) {
			steps[label] = round((steps[label] ?? 0) + at - prev);
			prev = at;
		}
		return {
			origin: this.origin,
			originIsEvalStart: this.originIsEvalStart,
			marks: this.marks.map(m => ({ label: m.label, at: round(m.at) })),
			steps,
		};
	}

	/** One line: `label 1.2ms | label 0.4ms | … (total 63.0ms)`. */
	summary(): string {
		const { steps, marks } = this.timings();
		const parts = Object.entries(steps).map(([label, ms]) => `${label} ${ms.toFixed(1)}ms`);
		const total = marks.length ? marks[marks.length - 1].at : 0;
		return `${parts.join(' | ')} (total ${total.toFixed(1)}ms)`;
	}
}

function round(ms: number): number {
	return Math.round(ms * 100) / 100;
}
