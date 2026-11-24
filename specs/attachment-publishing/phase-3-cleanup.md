# Phase 3: Cleanup (Beta)

Part of [Publishing attachments](design.md). **Beta.** Ships in the same
release as [phase 2](phase-2-core.md), which it depends on: without these
sweeps, gating a note would leave its files publicly fetchable.

Sections:

1. [Which files an area needs](#1-which-files-an-area-needs)
2. [Sweeps](#2-sweeps)
3. [Rebuilding attachment state](#3-rebuilding-attachment-state)
4. [Audit](#4-audit)
5. [Bucket lifecycle rule](#5-bucket-lifecycle-rule)
6. [Tests](#6-tests)
7. [Docs](#7-docs)

Every operation here holds the profile's publish lock (P2 §1). Sweeps run
inside `publishNotes` and `deletePublishedUid`, which already hold it. The
rebuild and the audit's delete offer take it themselves.

## 1. Which files an area needs

The set of files an area needs is **derived**, not reference-counted:

> required(area) = ⋃ `refs[h]` for every revision `h` in `publish-history[uid]`,
> for every UID currently published whose current access areas include `area`.

- [x] Implement `required`, candidate and orphan derivation as pure functions in
      `src/utils/attachments.ts`.

The two inputs come from different files:

- **Which UIDs are published:** the keys of the profile's `uid-to-hash`
  mapping (`MappingManager.getUidToHashMap`). Not the access map, which can lack
  a published UID.
- **A UID's current areas:** `partitionsFor` its groups in the access map
  (`access.json`, uid → groups). A UID missing from the access map, or mapped to
  `[]`, is **public**. This matches `AccessManager.set`, which treats an
  unrecorded prior state as public, and it covers notes published before access
  groups existed. Deriving the UID set from the access map alone would drop
  those notes and could delete files their revisions use.

This works because of how existing code places revisions:

- An access change deletes every historical revision from the areas the note
  left (`applyAccessTransitions`).
- A deleted UID leaves the mappings (`Publisher.deletePublishedUid`), even
  though its publish history is kept.
- A blocked note leaves the mappings (`commitBlockedNotes`).

It is a **superset**, which is the safe direction. An access change doesn't copy
old revisions into the areas a note enters, so some required keys belong to
revisions that aren't in that area. The derivation can over-retain a file, but
it never deletes one a live revision uses.

## 2. Sweeps

Orphans can only appear when published revisions are removed. Editing an
attachment never creates one, because the old revision still references the old
bytes.

### When to sweep

- [x] **After `applyAccessTransitions`**, once the new mappings are live, in
      each area a note left. This includes blocked notes (`to: null`). This is
      the important one: without it, a note moving from public to gated would
      leave its audio publicly fetchable.
  - [x] `applyAccessTransitions` (`src/publish/awsUpload.ts`) consumes the
        transitions itself and today returns only `boolean | null`. Change it
        to also return the note hashes it removed from each area (its
        `byPartition` map), which become this sweep's candidates.
- [x] **After `deletePublishedUid`** (delete picker), in each area it deleted
      from (public plus every group area). The sweep runs **after**
      `removeUidFromMappings` and `accessManager.remove`, so required(area) no
      longer counts the deleted UID.
- [x] **After `purgeRestrictedPartition`** removes a whole group area
      (`src/settings/profile/accessGroups.ts`). Its `attachments/` goes with it,
      because the deletion is prefix-based. Drop that area from `uploaded`.

### Sweep, for one area

- candidates = ⋃ `refs[h]` for the removed revisions `h`.
- orphans = candidates − required(area).

- [x] Delete orphans with `DeleteObjects` (batches of 1000), and remove them
      from `uploaded[area]`.
- [x] Only keys of the removed revisions are candidates, which bounds what a
      sweep can delete.

required(area) comes from local state, so the sweep relies on the
one-publishing-machine assumption (design.md, Assumptions).

### Sweeps ignore the attachment mode

- [x] All three sweeps run on every AWS profile, including with the mode `off`.

Gating attachment work on the mode would fail open: a user who publishes
attachments, turns the mode off, then gates a note would leave that note's files
publicly fetchable. So the sweep never checks the mode. It uses
`attachments.json` when the file exists. When it doesn't, the sweep creates it
(P2 §6), and the bucket probe decides: if the bucket holds no attachment
objects, the file starts complete, nothing is a candidate and the sweep ends. A
profile that never published attachments therefore pays one `ListObjectsV2`
probe on its first access change or delete, and nothing after that, because the
file then exists.

### When a sweep can't finish

- [x] The sweep needs `attachments.json` to be `complete`. If it isn't, rebuild
      first (§3).
- [x] If the rebuild fails, skip the sweep and show a persistent notice:
      "Couldn't check `<note>`'s attachments. They may still be readable in
      `<area>`. Run **Audit published notes**."
- [x] If the `DeleteObjects` call fails, or reports per-key errors, show the
      same persistent notice and keep the keys that weren't deleted in
      `uploaded[area]`.
- [x] In both cases the note's own deletion and the access change still happen.

A failed sweep's candidates aren't kept: the transitions were already consumed
and saved. **Audit published notes** (§4) is the recovery path. It finds every
unreferenced object, whatever left it behind.

### Invalidation

None is added. An access change already invalidates `/*` (`removedAny` in
`pushLocalJsonsToS3`, and `createCloudFrontInvalidation` always sends `/*`), and
so does `deletePublishedUid`. That evicts any cached copy of a formerly public
file.

### Fail-closed rules

- An attachment publishes only to the areas of the note revisions that reference
  it. A note that fails access resolution (`access.ok === false`) is blocked
  today, and its attachments are never collected (P2 §3).
- The edge contract is unchanged. `/restricted/<group>/attachments/*` sits under
  `/restricted/<group>/` and is enforced like notes. The existing "refuse to
  detach while `restricted/` has objects" check already covers attachment
  objects, because it lists the prefix.
- The renderer can't show a file that isn't in the note's list (P2 §4), and the
  list is staged with the note.

## 3. Rebuilding attachment state

Any orphan deletion (§2) and the audit's delete offer (§4) first run a
**rebuild** when `attachments.json` has `complete: false`. Without this, a fresh
file holding only new revisions would look authoritative and could delete files
that older live revisions still use.

- [x] **Step 1.** List `notes/` and `restricted/*/notes/` with `ListObjectsV2`.
- [x] **Step 2.** GET each note JSON (concurrency 5, progress notice) and record
      its `attachments` keys under its hash. Pre-feature revisions have no
      field, so they correctly record nothing.
- [x] **Step 3.** List `attachments/` and `restricted/*/attachments/` to rebuild
      `uploaded`.
- [x] **Step 4.** Merge `refs` with the local file (a union: a note hash always
      maps to the same keys, so entries never conflict). **Replace** `uploaded`
      with the listing from step 3 instead of merging it, because the bucket is
      the truth. Merging would keep local entries for keys deleted outside the
      plugin, and the next publish would then skip uploading them. Set
      `complete: true`.
- [x] If the rebuild fails (credentials, network), the operation that needed it
      skips its deletes and says so (§2).
- [x] When run outside a publish or delete, the rebuild takes the publish lock.

## 4. Audit

**Audit published notes** reads only local files today. With attachments it
also lists the bucket (it needs `s3:ListBucket`) and reports in the console
summary:

- [x] **Unreferenced objects:** keys under `attachments/` and
      `restricted/*/attachments/` that are not in required(area). These come
      from out-of-band changes, a skipped sweep or a failed sweep. Offer to
      delete them, only after a rebuild if `complete` is false. The delete offer
      takes the publish lock.
- [x] **Missing objects:** keys in required(area) with no object. If the vault
      still has matching bytes, clear them from `uploaded`, so the next publish
      of a referencing note re-uploads them. Otherwise list them as "referenced,
      never uploaded (bytes no longer in the vault)".

## 5. Bucket lifecycle rule

The site bucket has versioning on and no lifecycle rule
(`infrastructure/lib/full-stack-oac.ts`, `full-stack-oai.ts`). A swept
attachment becomes a delete marker over a retained version: unreachable through
CloudFront, but stored and billed indefinitely. Abandoned multipart uploads
linger the same way.

### Template change (both site stacks)

- [x] New parameter `NoncurrentVersionDays` (Number, default **30**, `0`
      disables that rule).
- [x] A `LifecycleConfiguration` on the bucket:
  - `NoncurrentVersionExpiration: { NoncurrentDays: NoncurrentVersionDays }`,
    through `Fn::If` and `AWS::NoValue` when it is `0`;
  - `AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }`, always.
- [x] `npm run synth` to regenerate `src/infrastructure/templates.ts`.

This applies to the whole bucket. Overwritten or deleted note JSON, mappings and
`config.json` also become unrecoverable 30 days after they stop being current.
That is the point of the rule, and the docs say so.

### Rollout

- [x] New deployments get it from the wizard with the default.
- [x] Existing deployments: a new row in **Settings → Infrastructure**
      (`src/settings/profile/infrastructure.ts`), "Bucket cleanup rule", showing
      the current state, a days field and an **Apply** button.
- [x] Apply runs a targeted site-stack update in `cloudFormationManager.ts` (the
      `updateFullStackOrigins` pattern: current template,
      `NoncurrentVersionDays` overridden, every other parameter
      `UsePreviousValue`, `preserveLiveDomain` applied). It polls to completion
      with the event log used elsewhere.
- [x] Imported stacks show "Managed outside the plugin; add a lifecycle rule in
      CDK" instead of the button.
- [x] The applied value is persisted as `InfrastructureState.bucketLifecycleDays`
      (`src/types.ts`).

## 6. Tests

### `test-attachments.ts` (extended)

- [x] required/candidate/orphan derivation across an access change, a UID
      delete, a blocked note, and two notes sharing a file in different areas.
- [x] A published UID missing from the access map counts as public, so a file
      its revisions use is never an orphan in the public area.
- [x] Sweeps with the mode `off`: a note whose revisions reference a file moves
      from public to gated, and the public copy is still an orphan.
- [x] A sweep after `deletePublishedUid` doesn't count the deleted UID.
- [x] A failed `DeleteObjects` keeps the undeleted keys in `uploaded`.

### `test-attachment-state.ts` (extended)

- [x] Rebuild merge: `refs` is a union with the local file.
- [x] Rebuild: `uploaded` equals the bucket listing, so a local entry for a key
      that is no longer in the bucket is dropped.
- [x] A file created after a failed probe makes the next sweep rebuild first.

### End-to-end (sandbox `random` only)

- [x] Gate a note that embeds an mp3 to a group and publish. The file appears
      under `restricted/<g>/attachments/`. The public copy is gone, and an
      anonymous fetch of the old public URL returns 403.
- [x] Make two notes, one public and one gated, share a file. It exists in both
      areas. Ungating or deleting one leaves the other's copy intact.
- [x] Delete `attachments.json` and gate a note that has attachments. The probe
      finds attachment objects, so the publish rebuilds the state from the
      bucket, then sweeps the public copy.
- [x] On a profile with publish history but no attachment objects, the first
      publish with attachments on creates the file as complete and never
      rebuilds.
- [x] Publish a public note with an mp3, switch the mode to `off`, gate the note
      and publish. The public copy is swept, and an anonymous fetch of its URL
      returns 403.
- [x] Delete an attachment object out of band and run **Audit published
      notes**: it reports the missing object and clears it from `uploaded`, and
      the next publish of the note re-uploads it.
- [x] Apply the bucket cleanup rule. `GetBucketLifecycleConfiguration` shows
      both rules, and the site's routes (`/auth/*`, comments, chat) still work.

## 7. Docs

- [x] `docs/publishing-model.md`: cleanup, the one-publishing-machine
      assumption, and that **Audit published notes** finds and repairs missing
      or leftover attachment objects.
- [x] `docs/infrastructure-deployment.md`: the bucket cleanup rule, its default,
      and that noncurrent note JSON, mappings and `config.json` expire too.
- [x] The S3 permissions cleanup uses: `s3:ListBucket` for the audit and the
      rebuild, `s3:GetObject` for the rebuild, `s3:DeleteObject` for sweeps.

## Done when

- [x] Every box in §1–§7 is ticked.
- [ ] Phase 2 is done too, because they ship together.
- [x] `npm run build`, `npm run synth` and all unit tests pass.
- [x] The end-to-end checks in §6 pass on the sandbox site
      (`npm run test:attachment-cleanup-live`, 72/72).
