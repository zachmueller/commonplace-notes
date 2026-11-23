# Spec: Publishing attachments (audio, images, PDFs, …)

This is the overview. The design and the work are split into one document per
phase, each with checkboxes to tick as the work lands:

| Phase | Document | Ships | Beta |
|-------|----------|-------|------|
| 1 | [Groundwork](phase-1-groundwork.md): session length, excluded-directory matching, raw-scrub fixes, Obscure attachment names | First, on its own | No |
| 2 | [Core attachments](phase-2-core.md): publish lock, settings, collection, rendering, pinning, local state, upload, site | With phase 3, in one release | Yes |
| 3 | [Cleanup](phase-3-cleanup.md): sweeps, rebuild, audit, bucket lifecycle rule | With phase 2, in one release | Yes |
| 4 | [Change notice](phase-4-change-notice.md) | Any later release | Yes, while the feature is |

**Reading the docs.** "P2 §6" means section 6 of the phase 2 document. Each
phase document holds the full design for what it ships, its tests and its doc
updates. This page holds what applies to every phase: the problem, the
decisions, the non-goals and the assumptions.

**Checkboxes.** Tick a box when the change has merged with its tests. A section
is done when all of its boxes are ticked. A phase is done when its **Done when**
list is.

## Problem

Notes often link to non-Markdown files in the vault: `![[song.mp3]]`,
`![[diagram.png|300]]`, `[[slides.pdf]]`, `![](Media/pic.png)`. Today these are
never published. Wikilink forms render as unpublished links
(`docs/publishing-model.md`, "Limitations"; `src/utils/remarkObsidianLinks.ts`,
the `unpublishedSpan` branch). Markdown forms pass through as a broken relative
`<img src>` / `<a href>` that also leaks the vault folder path. The only
workaround is to host the file elsewhere and hand-write a URL, which ignores the
note's access groups.

## Goal

Let a published note carry the attachments it links to, with:

1. **Explicit opt-in.** Off by default per profile, so no file publishes by
   accident.
2. **Access that follows the notes.** A file is readable by exactly the readers
   who can read some note that references it, using the existing
   `restricted/<group>/` access areas and edge-function contract.
3. **Correct change tracking.** Editing a file in the vault publishes a new copy
   on the next publish. Old note revisions (permalinks) keep the copy they were
   published with. Nothing is ever served stale from a cache.

## Release plan

- [ ] Phase 1 ships on its own. It isn't beta. Its excluded-directory matching
      must ship no later than phase 2, because attachment collection relies on
      it. Its splice-offset fix ships with or before Obscure attachment names,
      because that change splices more links the same way.
- [ ] Phases 2 and 3 ship **in the same release**. Phase 2 alone would leave
      public copies behind when a note is gated.
- [ ] That release is a **beta**. The settings group reads **Attachments
      (Beta)**, the docs and the release notes label the feature "Beta", and the
      mode stays `off` by default.
- [ ] Phase 4 ships in any later release.

The phase 2 prerequisites (the publish lock, the `handlePublishError` fix and
the publish timestamp, P2 §1) each stand alone and may land earlier, including
with phase 1.

### Leaving beta

Leaving beta is a separate decision. It needs all of:

- [ ] Real use on the sandbox site (AWS account `random`).
- [ ] At least one release without changes to the formats in P2 §5 and P2 §6
      (note JSON `attachments`, `attachments.json`, `staged-attachments.json`,
      the key layout). Until then those formats may change, with a migration if
      they do.
- [ ] The "Beta" labels removed from the settings group, the docs and the
      release notes.

## Decisions

| Question | Decision |
|----------|----------|
| Which version a note shows | **Pinned.** A note revision references the exact bytes it was published with. Editing the file creates a new note revision (P2 §5). |
| Access control | **One copy per access area.** The file is uploaded to every area (public, `restricted/<group>/`) that has a referencing note. No edge-function change (P2 §7). |
| What gets published | **Per-profile setting**, default **off**, with levels for how broadly links are followed, plus an extension allow-list and a size cap (P2 §2). |
| File types | **No type is ever refused.** The allow-list is the user's to widen, and `*` allows every extension. Types that could run code at the site's origin (HTML, JavaScript, XML, SVG opened directly, …) are still published, but served as downloads (P2 §7, Headers). |
| Public exposure | A file becomes public as soon as **any** public note references it. That note shows it to everyone anyway. |
| Source of a note's attachment list | **Obsidian's metadata cache only** (P2 §3). The renderer never adds to it; it only renders what the list contains. |
| Reader experience | **Embeds play inline, everything else opens in a new tab.** `![[image]]`, `![[audio]]` and `![[video]]` render in the note. PDF and other embeds, and every plain link, open the file in a new browser tab (P2 §4). |
| Attachment list in note JSON | **Yes.** Each published note JSON lists its attachment keys (P2 §5). |
| Diffing attachments | **No.** Attachments get no diff link or diff view. The note diff shows file names in place of content hashes and says when attachments changed (P2 §9). |
| Raw Markdown | A separate **Obscure attachment names** setting (default on) replaces every link to a non-Markdown vault file in the published `raw` with the file's content hash, or `null` when it didn't publish, in both wikilink and Markdown syntax, whatever the attachment mode. Like **Obscure wikilinks**, it affects only `raw` and what is built from it. It hides folder paths, not file names: as with note titles, the rendered note shows a file's name unless the author wrote an alias. New note hashes from this are accepted (P1 §4). |
| Excluded directories | Entries match **from the vault root**: `private/` excludes only the top-level `private` folder. `*` matches within one folder name and `**` matches any depth, so `**/private/` excludes a `private` folder anywhere. This applies to notes and attachments alike. Existing entries keep their text. A one-time upgrade appends patterns so every folder the old rule excluded stays excluded, and a notice says what it added (P1 §2). |
| Large files | **Streamed from disk** with Node's `fs` (the plugin is desktop-only) for hashing and multipart upload, so memory use doesn't grow with file size. At most two large files upload at once, so peak upload memory stays under about 112 MB whatever the file sizes (P2 §6, P2 §7). |
| File excluded after staging | Every staged attachment is re-checked against the current exclusion rules, allow-list and size cap just before upload. Files that now fail are dropped, not uploaded (P2 §7). |
| File changed mid-publish | Re-check before staging and re-queue. If the file is still changing, abort the publish without throwing, so staging stays intact. Just before upload, every staged entry's bytes are checked against its hash: a mismatch stops the publish if this publish staged the entry, and drops the entry if an earlier failed batch did, so one changed file can't fail every later publish. If the bytes still mismatch at upload, fail the publish with staged files kept (P2 §7). |
| Detecting changed bytes | The hash cache is keyed on size, mtime **and** `ctimeMs`, all from one Node `fs.stat` taken before hashing (never Obsidian's cached `file.stat`). Every write changes `ctimeMs`, and tools can't reset it. A tag editor that keeps size and mtime still causes a re-hash (P2 §6). **Publish updates since last full publish** uses the later of mtime and `ctimeMs` too (P2 §8). |
| Hash cache location | **One file per machine, shared by all profiles**, in the plugin folder: `attachment-hash-cache.<machineId>.json`. The machine ID lives in Obsidian's device-local storage, so a synced plugin folder never makes two machines overwrite each other's cache (P2 §6). |
| Concurrent publishes | **A per-profile lock.** A publish, a delete, an audit delete, a rebuild, a group purge and a content-index rebuild for the same profile never overlap. A second request while one runs is refused with a notice, not queued (P2 §1). |
| Raw-scrub splice offsets | **An existing bug, fixed in phase 1.** Today's scrubber applies match positions from a text node's unescaped value directly to the source. After an escape, an entity, trailing whitespace before a line break or a continuation-line prefix (blockquote, list item, indented line), it corrupts the published `raw`. The new scrubber maps value positions to source offsets (P1 §3). |
| Raw-scrub links in tables | **An existing bug, fixed in phase 1.** Today's scrubber writes a bare `\|` into table cells, which splits the cell. Inside a table cell, every `\|` it writes is escaped as `\\|` (P1 §3). |
| Attachment state when the probe fails | `attachments.json` is created with `complete: false`, never skipped, so the `refs` that publish commits are kept. The next sweep rebuilds first (P2 §6, P3 §3). |
| Publish errors and staging | `handlePublishError` copies staging into the error session directory and **no longer clears it**. Only a successful upload clears staging, so an earlier failed batch is never lost (P2 §1). |
| Upload failures | An attachment upload failure makes `pushLocalJsonsToS3` **return `false`**, like today's note-upload failure. It doesn't throw, so staging is kept and `handlePublishError` doesn't run (P2 §7). |
| Raw HTML and reference-style links | **Not handled, and documented.** `<img src="Media/x.png">`, `<audio src=…>` and `[ref]: Media/a.pdf` definitions are neither published nor obscured. They pass through as written, folder path included (P2 §4). |
| Links Obsidian and remark read differently | **Not handled, and documented.** A link Obsidian's metadata cache indexes but remark doesn't parse as one wikilink or one `image`/`link` node is uploaded with the note, but is neither rendered nor obscured in `raw` (P2 §4). |
| Release | Attachment publishing **launches as a beta** in its first release (phases 2 and 3). The settings group, the docs and the release notes label it "Beta". The mode still defaults to `off`. Phase 1 changes (session length, excluded-directory matching, Obscure attachment names) are not beta. |
| Publishing machines | Cleanup assumes **one publishing machine per profile**, or one whose plugin data finished syncing before publishing. The docs say so (Assumptions, below). |
| Cleanup and the mode | Orphan sweeps run **whatever the attachment mode**, including `off`, whenever the bucket may hold attachments. Turning the mode off must never leave a gated note's files public (P3 §2). |
| Deleted bytes | Add an S3 lifecycle rule that expires noncurrent versions and aborts stale multipart uploads (P3 §5). |
| Sign-in session | Raise the session from 1 hour to **12 hours** by default, configurable per profile in the infrastructure settings. Accept media stopping at session expiry (P1 §1). |

## Non-goals (v1)

- **Local publish mechanism.** Attachments render as unpublished links on Local
  profiles. Local publishing is experimental, and its template would need the
  same URL rewriting as the site.
- **Search and chat.** Attachments are not added to `contentIndex.json` or the
  `kb/` chat corpus.
- **Comments on attachments.**
- **Live attachments** (a stable ID that always resolves to the latest bytes).
- **Diffing attachment contents.**
- **A lightbox or click-to-enlarge for inline images.**
- **Raw HTML and reference-style links to vault files.** `<img src>`,
  `<audio src>`, `<a href>` and other raw HTML, and `[ref]: path` definitions,
  aren't in Obsidian's metadata cache and aren't visited by the new stage or the
  raw scrub. They pass through unchanged, folder path included (P2 §4).
- **Links Obsidian and remark parse differently**, such as a wikilink holding
  emphasis markers (`![[my *draft* take.mp3]]`). See P2 §4.
- **Concurrent publishing from several machines.** Cleanup trusts local state
  (Assumptions, below). Concurrent publishes on one machine are prevented by the
  publish lock (P2 §1).
- **Purging one file from old revisions.** If a public note once embedded
  `secret.mp3` and a later revision drops it, the old public revision still
  references it, exactly as the old revision's text stays public. Removing it
  means deleting the note's published history (the existing delete picker).

## Assumptions

**One publishing machine per profile.** The profile's local state
(`publish-history.json`, the mappings, `access.json` and, from phase 2,
`attachments.json`) lives in the plugin folder,
`<configDir>/plugins/commonplace-notes/profiles/<profileId>/`
(`ProfileManager.getProfileDir`, from `manifest.dir`). It reaches other machines
only through whatever syncs that folder: Obsidian Sync with community plugins
included, or a file-level sync of the whole vault. `complete` in
`attachments.json` (P2 §6) detects a **missing** file, not a **stale** one. If
two machines publish the same profile before sync catches up, one machine's
sweep (P3 §2) can delete a file that the other's newer revision uses, and its
`uploaded` list can skip re-uploading a key the other machine swept.

v1 therefore assumes one publishing machine per profile, or that the plugin
folder finishes syncing before each publish. `docs/publishing-model.md` says so,
and **Audit published notes** (P3 §4) finds and repairs the resulting missing
objects. The per-profile publish lock (P2 §1) covers overlapping work on one
machine only.

## Defaults chosen

These were settled while writing the spec. Change any you disagree with:

- Noncurrent versions expire after **30 days** (P3 §5).
- The size cap's ceiling is **500 MB** (P2 §2).
- Shared HTML, JavaScript and other active files **download** rather than
  render (P2 §7). Rendering them on the site would mean serving them from a
  separate origin, which is an infrastructure change.
- Inline images aren't clickable (no lightbox, no open-in-new-tab) in v1.
- An inline image's `alt` is the link's alias or alt text, otherwise the file
  name (P2 §4).
- **Obscure attachment names** is on by default, like Obscure wikilinks (P1 §4).
- Excluded-directory matching is case-insensitive (P1 §2).
- The excluded-directories upgrade appends `**/<entry>/` and `<entry>*/` for
  each entry without a trailing slash, so nothing the old rule excluded becomes
  publishable, apart from root files it matched only by name, which are
  reported. It doesn't edit or remove the user's entries or block publishing
  (P1 §2).
- Obscure attachment names hides folder paths, not file names, matching
  Obscure wikilinks: only an author-written alias keeps a name out of the
  rendered note (P1 §4, P2 §4).
- A mixed paragraph (`![[pic.png]] ![[Note]]`) renders its note embed inline
  (P2 §4).
- A publish request while the profile is busy is **refused**, not queued
  (P2 §1).

## Testing conventions

- **Unit tests** run with `npx tsx e2e/scripts/…`, with one `package.json`
  script each, as existing tests do. Pure modules (no Obsidian imports) get the
  most coverage.
- **End-to-end tests** use the `write-e2e-test` skill, on the **sandbox AWS
  account (`random`) only**, never the real `notes` site.
- **Parser golden file.** Any phase that changes HTML output re-captures
  `e2e/fixtures/parser-golden.json` and reviews every diff.
