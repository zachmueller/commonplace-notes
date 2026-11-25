#!/usr/bin/env npx tsx
/**
 * StartupTimer unit test (src/utils/startupTiming.ts).
 *
 *   1. Marks are relative to the given origin (the bundle's evaluation start).
 *   2. steps holds each mark's duration since the previous mark; a repeated
 *      label sums its durations.
 *   3. Without an origin (no esbuild banner) the origin is the timer's creation
 *      and originIsEvalStart is false.
 *   4. summary() is one line with every step and the total.
 *   5. bundleEvalStart() is undefined outside the bundle.
 *
 * Run: npx tsx e2e/scripts/test-startup-timing.ts
 */

import * as timingModule from '../../src/utils/startupTiming';

const timing: typeof import('../../src/utils/startupTiming') =
	(timingModule as any).StartupTimer ? timingModule : (timingModule as any).default;

const failures: string[] = [];
let checks = 0;
function check(name: string, ok: boolean, detail = ''): void {
	checks++;
	if (ok) console.log(`PASS  ${name}`);
	else {
		failures.push(name);
		console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
	}
}

/** A clock that returns the queued times in order. */
function clock(...times: number[]): () => number {
	return () => {
		const t = times.shift();
		if (t === undefined) throw new Error('clock exhausted');
		return t;
	};
}

// 1–2. Origin-relative marks and step durations.
{
	const timer = new timing.StartupTimer(clock(150, 153.5, 160, 170), 100);
	timer.mark('evaluate');
	timer.mark('loadSettings');
	timer.mark('managers');
	timer.mark('loadSettings');
	const t = timer.timings();
	check('origin is the given eval start', t.origin === 100 && t.originIsEvalStart === true, JSON.stringify(t));
	check(
		'marks are ms since the origin',
		JSON.stringify(t.marks.map(m => m.at)) === JSON.stringify([50, 53.5, 60, 70]),
		JSON.stringify(t.marks),
	);
	check('first step runs from the origin', t.steps.evaluate === 50, JSON.stringify(t.steps));
	check('later steps run from the previous mark', t.steps.managers === 6.5, JSON.stringify(t.steps));
	check('a repeated label sums', t.steps.loadSettings === 3.5 + 10, JSON.stringify(t.steps));
}

// 3. No banner: origin is the timer's creation.
{
	const timer = new timing.StartupTimer(clock(40, 42.25), undefined);
	timer.mark('evaluate');
	const t = timer.timings();
	check('fallback origin is creation time', t.origin === 40 && t.originIsEvalStart === false, JSON.stringify(t));
	check('fallback marks are relative to creation', t.steps.evaluate === 2.25, JSON.stringify(t.steps));
}

// 4. Summary line.
{
	const timer = new timing.StartupTimer(clock(10, 12.04, 20), 0);
	timer.mark('evaluate');
	timer.mark('loadSettings');
	timer.mark('managers');
	const line = timer.summary();
	check(
		'summary lists every step and the total',
		line === 'evaluate 10.0ms | loadSettings 2.0ms | managers 8.0ms (total 20.0ms)',
		line,
	);
	check('summary of no marks', new timing.StartupTimer(clock(5), 0).summary() === ' (total 0.0ms)');
}

// 5. Outside the bundle there's no banner global.
check('bundleEvalStart() is undefined outside the bundle', timing.bundleEvalStart() === undefined);

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length) process.exit(1);
