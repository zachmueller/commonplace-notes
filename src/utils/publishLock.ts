/**
 * Per-profile publish lock (attachment spec P2 §1).
 *
 * A publish, a delete, a group purge, a content-index rebuild and (phase 3)
 * the attachment checks for one profile must never overlap: each reloads
 * local state (publish history, mappings, access.json, attachments.json) from
 * disk and writes it back, so two at once can lose each other's writes.
 *
 * The lock is in memory, one per profile ID, so different profiles never
 * block each other and quitting Obsidian releases everything. A second request
 * while one runs is refused, not queued: a queued request could run against a
 * selection or settings that changed meanwhile.
 *
 * Not re-entrant. Code already holding the lock calls the unlocked internals.
 *
 * Pure module (no Obsidian imports), so it is unit-testable on its own.
 */

const held = new Map<string, string>();

export type LockResult<T> = { ran: true; result: T } | { ran: false; heldBy: string };

/**
 * Runs `fn` while holding `profileId`'s lock. Returns `{ ran: false, heldBy }`
 * without running `fn` if the lock is held. Releases in `finally`, so a throw
 * from `fn` still releases it (and propagates).
 */
export async function withProfileLock<T>(
	profileId: string,
	label: string,
	fn: () => Promise<T>,
): Promise<LockResult<T>> {
	const current = held.get(profileId);
	if (current !== undefined) return { ran: false, heldBy: current };
	held.set(profileId, label);
	try {
		return { ran: true, result: await fn() };
	} finally {
		held.delete(profileId);
	}
}

/** What holds `profileId`'s lock, or null when it's free. */
export function profileLockHolder(profileId: string): string | null {
	return held.get(profileId) ?? null;
}

/** The notice shown when a request is refused: "`<profile>` is busy (`<heldBy>`). …" */
export function busyMessage(profileName: string, heldBy: string): string {
	return `${profileName} is busy (${heldBy}). Try again when it finishes.`;
}
