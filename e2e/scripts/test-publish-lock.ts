#!/usr/bin/env npx tsx
/**
 * Per-profile publish lock unit test (attachment spec P2 §1, §10).
 *
 *   1. A second withProfileLock on the same profile while the first runs
 *      returns { ran: false, heldBy } and doesn't run its function.
 *   2. Different profiles run concurrently.
 *   3. The lock is released when the function throws (and the throw
 *      propagates).
 *   4. Sequential calls each run; profileLockHolder reports the holder.
 *   5. busyMessage wording.
 *
 * The publisher-level checks (two real publishes, the delete picker during a
 * publish) need Obsidian and run in the attachment e2e.
 *
 * Run: npx tsx e2e/scripts/test-publish-lock.ts
 */

import * as lockModule from '../../src/utils/publishLock';

const lock: typeof import('../../src/utils/publishLock') =
	(lockModule as any).withProfileLock ? lockModule : (lockModule as any).default;

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>(r => { resolve = r; });
	return { promise, resolve };
}

async function main(): Promise<void> {
	// 1. Refused while held.
	{
		const gate = deferred();
		let secondRan = false;
		const first = lock.withProfileLock('p1', 'publishing', async () => {
			await gate.promise;
			return 'first';
		});
		const second = await lock.withProfileLock('p1', 'deleting a note', async () => {
			secondRan = true;
			return 'second';
		});
		check('second call on a held profile is refused', second.ran === false);
		check('refusal names the holder', !second.ran && second.heldBy === 'publishing',
			JSON.stringify(second));
		check('refused function never ran', !secondRan);
		check('profileLockHolder reports the holder', lock.profileLockHolder('p1') === 'publishing');
		gate.resolve();
		const r = await first;
		check('first call completes with its result', r.ran && r.result === 'first', JSON.stringify(r));
		check('lock is free after completion', lock.profileLockHolder('p1') === null);
	}

	// 2. Different profiles don't block each other.
	{
		const gateA = deferred();
		const gateB = deferred();
		let aStarted = false;
		let bStarted = false;
		const a = lock.withProfileLock('A', 'publishing', async () => { aStarted = true; await gateA.promise; return 1; });
		const b = lock.withProfileLock('B', 'publishing', async () => { bStarted = true; await gateB.promise; return 2; });
		await Promise.resolve();
		check('two profiles run at once', aStarted && bStarted);
		gateB.resolve();
		gateA.resolve();
		const [ra, rb] = await Promise.all([a, b]);
		check('both profiles complete', ra.ran && rb.ran);
	}

	// 3. Released on throw.
	{
		let threw = false;
		try {
			await lock.withProfileLock('p2', 'publishing', async () => { throw new Error('boom'); });
		} catch (e) {
			threw = (e as Error).message === 'boom';
		}
		check('a throw propagates', threw);
		check('lock is released after a throw', lock.profileLockHolder('p2') === null);
		const after = await lock.withProfileLock('p2', 'publishing', async () => 'ok');
		check('next call after a throw runs', after.ran && after.result === 'ok');
	}

	// 4. Sequential calls run.
	{
		const r1 = await lock.withProfileLock('p3', 'publishing', async () => 1);
		const r2 = await lock.withProfileLock('p3', 'publishing', async () => 2);
		check('sequential calls both run', r1.ran && r2.ran);
	}

	// 5. Notice wording.
	check('busy notice wording',
		lock.busyMessage('Notes', 'publishing') === 'Notes is busy (publishing). Try again when it finishes.',
		lock.busyMessage('Notes', 'publishing'));

	console.log('');
	if (failures.length === 0) {
		console.log(`All ${checks} publish-lock checks passed.`);
		process.exit(0);
	}
	console.log(`${failures.length}/${checks} publish-lock checks FAILED.`);
	process.exit(1);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
