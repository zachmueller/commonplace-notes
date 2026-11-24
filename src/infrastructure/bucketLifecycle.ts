/**
 * The site bucket's cleanup (lifecycle) rule: the `NoncurrentVersionDays`
 * parameter of the site stack, and what Settings -> Infrastructure shows for it.
 *
 * Pure: no Obsidian imports, so it can be unit-tested with tsx
 * (e2e/scripts/test-bucket-lifecycle.ts).
 *
 * The bucket is versioned, so an overwritten or deleted object (a swept
 * attachment, an old note JSON) stays as a noncurrent version, stored and
 * billed. The site stack has two lifecycle rules:
 *   - noncurrent versions expire `NoncurrentVersionDays` days after they stop
 *     being current (`0` turns this rule off);
 *   - incomplete multipart uploads are aborted 7 days after they start, always.
 *
 * A new site gets the 30-day default. A site deployed before the parameter
 * existed keeps its old versions until its author applies the rule: targeted
 * updates pass an explicit `0` for it (CloudFormationManager's
 * FULL_STACK_PARAM_DEFAULTS), so an unrelated update never starts deleting
 * history on its own.
 */

import type { InfrastructureState } from './types';

/** Noncurrent-version lifetime for a new site, in days. */
export const DEFAULT_NONCURRENT_VERSION_DAYS = 30;
/** `0` keeps noncurrent versions (the expiry rule is left out). */
export const MIN_NONCURRENT_VERSION_DAYS = 0;
/** The template's MaxValue. */
export const MAX_NONCURRENT_VERSION_DAYS = 3650;
/** Fixed in the template: abandoned multipart uploads are aborted after this. */
export const ABORT_INCOMPLETE_UPLOAD_DAYS = 7;

/** Whether `days` is a value the template's `NoncurrentVersionDays` accepts. */
export function isValidNoncurrentDays(days: unknown): days is number {
	return typeof days === 'number' && Number.isInteger(days)
		&& days >= MIN_NONCURRENT_VERSION_DAYS && days <= MAX_NONCURRENT_VERSION_DAYS;
}

/**
 * Parse the settings field. Whole digits only, so an empty field doesn't
 * read as `0` (which would turn expiry off). Returns null when invalid.
 */
export function parseNoncurrentDays(raw: string): number | null {
	const text = raw.trim();
	if (!/^\d+$/.test(text)) return null;
	const days = Number(text);
	return isValidNoncurrentDays(days) ? days : null;
}

/**
 * The deployed stack's `NoncurrentVersionDays`, from DescribeStacks
 * parameters. Undefined when the stack predates the parameter (or the value
 * can't be read).
 */
export function deployedNoncurrentDays(
	parameters: ReadonlyArray<{ ParameterKey?: string; ParameterValue?: string }> | undefined,
): number | undefined {
	const raw = parameters?.find((p) => p.ParameterKey === 'NoncurrentVersionDays')?.ParameterValue;
	if (raw === undefined) return undefined;
	const days = parseNoncurrentDays(raw);
	return days === null ? undefined : days;
}

/** One-sentence description of a cleanup rule's current state. */
export function describeBucketLifecycle(days: number | undefined): string {
	if (days === undefined) {
		return 'No cleanup rule yet: this site was deployed before it existed, so deleted and overwritten '
			+ 'files keep their old versions, stored and billed indefinitely.';
	}
	const abort = `Uploads abandoned midway are removed after ${ABORT_INCOMPLETE_UPLOAD_DAYS} days.`;
	if (days === 0) return `Old versions are kept indefinitely. ${abort}`;
	return `Old versions are deleted ${days} day${days === 1 ? '' : 's'} after they're replaced or deleted. ${abort}`;
}

export type BucketCleanupRow =
	| { kind: 'hidden' }
	| { kind: 'imported'; desc: string }
	| { kind: 'editable'; desc: string; current: number | undefined; initialDays: number };

/** Applies to every object, not just attachments; the row says so. */
const WHOLE_BUCKET_NOTE = 'Applies to the whole bucket: old versions of note JSON, mappings and config.json '
	+ 'can\'t be recovered once they expire. 0 keeps old versions.';

/**
 * What the "Bucket cleanup rule" row shows. Hidden without a site stack.
 * Imported stacks are managed outside the plugin, so no Apply button.
 */
export function bucketCleanupRow(
	state: Pick<InfrastructureState, 'fullStackName' | 'imported' | 'bucketLifecycleDays'> | undefined,
): BucketCleanupRow {
	if (!state?.fullStackName) return { kind: 'hidden' };
	if (state.imported) return { kind: 'imported', desc: 'Managed outside the plugin; add a lifecycle rule in CDK.' };
	const current = isValidNoncurrentDays(state.bucketLifecycleDays) ? state.bucketLifecycleDays : undefined;
	return {
		kind: 'editable',
		current,
		initialDays: current ?? DEFAULT_NONCURRENT_VERSION_DAYS,
		desc: `${describeBucketLifecycle(current)} ${WHOLE_BUCKET_NOTE}`,
	};
}
