# Spec: Publishing attachments (audio, images, PDFs, …)

## Problem

Notes often link to non-Markdown files in the vault: `![[song.mp3]]`,
`![[diagram.png|300]]`, `[[slides.pdf]]`. Today these are never published; they
render as unpublished links (`docs/publishing-model.md`, "Limitations";
`src/utils/remarkObsidianLinks.ts`, the `unpublishedSpan` branch). The only
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

## Decisions

These were settled before writing the spec:

| Question | Decision |
|----------|----------|
| Which version a note shows | **Pinned.** A note revision references the exact bytes it was published with. Editing the file creates a new note revision. |
| Access control | **One copy per access area.** The file is uploaded to every area (public, `restricted/<group>/`) that has a referencing note. No edge-function or infrastructure change. |
| What gets published | **Per-profile setting**, default **off**, with levels for how broadly links are followed, plus an extension allow-list and a size cap. |
| Public exposure | A file becomes public as soon as **any** public note references it. That note shows it to everyone anyway. |

## Non-goals (v1)

- **Local publish mechanism.** Attachments keep rendering as unpublished links
  on Local profiles. Local publishing is experimental, and its template would
  need the same URL rewriting as the site.
- **Search and chat.** Attachments are not added to `contentIndex.json` or the
  `kb/` chat corpus.
- **Comments on attachments.**
- **Live attachments** (a stable ID that always resolves to the latest bytes).
- **Purging one file from old revisions.** If a public note once embedded
  `secret.mp3` and a later revision drops it, the old public revision still
  references it, exactly as the old revision's text stays public. Removing it
  means deleting the note's published history (the existing delete picker).

---

## 1. Settings

New optional field on `PublishingProfile` (`src/types.ts`):

```ts
interface AttachmentSettings {
  /** Which links to non-Markdown files publish the file. */
  mode: 'off' | 'embeds' | 'embedsAndLinks';
  /** Lowercase extensions without the dot. */
  allowedExtensions: string[];
  /** Files larger than this are skipped with a notice. */
  maxFileSizeMB: number;
}

attachments?: AttachmentSettings; // absent ≡ { mode: 'off', … defaults }
```

- **`off`** (default): today's behavior, unchanged.
- **`embeds`**: `![[file.ext]]` and `![](file.ext)` publish the file.
- **`embedsAndLinks`**: plain `[[file.ext]]` and `[text](file.ext)` publish it too.

**Default allow-list:**

- Images: `png jpg jpeg gif webp avif svg`
- Audio: `mp3 m4a aac ogg oga opus wav flac`
- Video: `mp4 m4v webm mov`
- Documents: `pdf`

**Hard deny-list**, regardless of settings: `md html htm xhtml js mjs wasm`,
plus Obsidian's own file types (`canvas`, `base`). `md` files are notes and
publish through `cpn-publish-contexts`. The others would run as same-origin
code if opened directly.

**Default cap:** 50 MB.

The profile's **Excluded directories** apply to attachments too. A file under
`private/` never publishes, whichever note links it.

UI: a new **Attachments** group in the profile's settings tab (mode dropdown,
extensions text field, size field). When the mode is first changed from `off`,
show a notice: run **Publish all notes** once so existing notes pick up their
attachments (see §5).

## 2. Which files a note references

While queuing a note (`NoteManager.queueNote`, `src/utils/notes.ts`), collect
its attachment references:

1. Take the note's `embeds` (and, in `embedsAndLinks` mode, its `links`) from
   `metadataCache.getFileCache(file)`. This covers both wikilink and Markdown
   link syntax.
2. Resolve each with `metadataCache.getFirstLinkpathDest(link, file.path)`.
3. Keep it if it resolves to a `TFile` that:
   - is not Markdown,
   - has an allowed, non-denied extension,
   - is not under an excluded directory,
   - is within the size cap.

   A file that fails only the size cap is skipped with a notice naming it.
4. Hash each kept file (§3) and attach the list to the note's state:

```ts
interface AttachmentRef {
  vaultPath: string;   // for upload and notices only; never published
  sha256: string;      // hex, 64 chars
  fileName: string;    // basename, e.g. "song.mp3"
  ext: string;
  size: number;
  embed: boolean;      // ![[…]] vs [[…]] (decides rendering)
}
// NoteState gains: attachments: AttachmentRef[]
```

Links inside code blocks and inline code are ignored. The metadata cache
already excludes them.

## 3. Storage, hashing and change detection

### Object keys

Files are stored by content, never by vault path:

```
<s3Prefix>attachments/<sha256>/<fileName>                  # public area
<s3Prefix>restricted/<group>/attachments/<sha256>/<fileName>
```

- The hash makes every key immutable. A key's bytes never change, so caches
  never go stale and no CloudFront invalidation is ever needed for attachments.
- Keeping `<fileName>` as the last segment gives downloads a sensible name.
- If two vault files share bytes but not names, both keys exist. That duplicate
  is negligible and keeps the URL honest about the filename.
- Hashes are full SHA-256. Unlike note hashes, these URLs are fetched directly,
  so they should be unguessable.

### Hash cache

Hashing a large file on every publish is wasteful, so keep a per-profile cache
alongside `publish-history.json` (`ProfileManager.getProfileDir`):

```jsonc
// attachment-hash-cache.json
{ "<vaultPath>": { "size": 1234567, "mtime": 1763900000000, "sha256": "…" } }
```

Re-hash (with `vault.readBinary` and `crypto.subtle.digest('SHA-256', …)`) only
when `size` or `mtime` differ from the cached values. A vault `rename` event
moves the entry to the new path. A `delete` event drops it.

### Upload manifest

Track what is already in each area, alongside the history:

```jsonc
// attachments-uploaded.json   (area key: "" = public, "restricted/<g>/")
{ "": ["<sha256>/<fileName>", …], "restricted/family/": [ … ] }
```

At upload, for each (area, key) a staged note needs:

1. If the manifest lists it, skip it.
2. Otherwise, send a `HeadObject`. If the object exists, record it and skip
   it. This recovers a lost manifest, e.g. on a fresh machine.
3. Otherwise, `PutObject` and record it.

An unchanged file therefore costs nothing on later publishes.

### Staging

Binary files are **not** copied into the staging directory, which would double
disk use for large media. Each staged note's JSON already identifies the note.
A sibling `staged-attachments.json` lists `{ vaultPath, sha256, fileName,
areas[] }` for the staged batch.

At upload, the bytes are read from the vault and **re-hashed**. If the hash no
longer matches, because the file changed between queue and upload, the upload
of that file is skipped and a notice says to publish again. The referencing
note is still uploaded: its HTML points at a key that doesn't exist yet. The
next publish fixes it, because the file's new hash changes the note's hash.

### Upload headers

- `ContentType` comes from an extension map (e.g. `mp3 → audio/mpeg`,
  `m4a → audio/mp4`, `pdf → application/pdf`). Unknown but allowed extensions
  get `application/octet-stream` plus
  `Content-Disposition: attachment; filename="…"`.
- `svg` always gets `Content-Disposition: attachment`. `<img>` ignores that
  header and renders normally, but opening the URL directly downloads the file
  instead of running any script it holds at the site's origin.
- Public area: `Cache-Control: public, max-age=31536000, immutable`.
- Restricted areas: `Cache-Control: private, max-age=86400, immutable`. Notes
  in these areas use `private, no-store` (`RESTRICTED_CACHE_CONTROL` in
  `src/publish/awsUpload.ts`), but re-downloading a 20 MB file on every play is
  not acceptable. The `private` directive still keeps shared caches out. The
  edge function still checks every request that reaches CloudFront. A member
  removed from a group can only replay bytes their own browser already holds.
- Files over 16 MB upload with S3 multipart upload. `@aws-sdk/lib-storage`'s
  `Upload` is the likely choice. It is not yet a dependency, so check bundle
  size first and fall back to manual `CreateMultipartUpload` if needed.
  Reading the whole file into memory is acceptable within the size cap.

S3 and CloudFront already serve byte-range requests, which `<audio>` and
`<video>` seeking needs. No infrastructure change is required.

## 4. Pinning: attachments in the note hash

The note's content hash (`notes.ts`, `currentHash`) gains an attachment
segment, **only when the note has attachment references**. Access groups and
`cpn-style` are added the same way:

```ts
const att = [...new Set(refs.map(r => `${r.sha256}/${r.fileName}`))].sort();
… + (att.length ? `::att=${att.join(',')}` : '')
```

As a result:

- **Notes without attachments keep their hashes.** No mass republish on rollout.
- **Editing an attachment changes the hash of every note that references it.**
  The next publish that includes those notes records a new revision, and the
  old revision keeps pointing at the old bytes.
- **Turning the mode on, or widening it, changes the hashes of the affected
  notes**, so they republish with working links.
- **Renaming the file** changes the note text and `fileName`, giving a new
  revision.

Record, per note revision, which attachment keys it uses. This is the source of
truth for cleanup (§7):

```jsonc
// attachment-refs.json   note content hash -> keys
{ "<noteHash>": ["<sha256>/<fileName>", …] }
```

It is written in `commitPendingNotes`, next to the publish history. Entries for
revisions without attachments are omitted.

## 5. Noticing changed attachments

Editing a file doesn't touch the notes that reference it, so mtime-based scopes
would miss the change.

- **Publish updates since last full publish** (`Publisher.getUpdatedNotes`):
  when the mode isn't `off`, also include every publishable note whose resolved
  links (`metadataCache.resolvedLinks`) reach an attachment file with
  `mtime > lastFullPublishTimestamp`.
- **Publish active and connected notes** and **Publish current note** need no
  change. They re-queue the note, and the hash check picks up the new bytes.
- **Change notice (phase 2).** On a vault `modify` event for a file in the hash
  cache, debounced: if any currently published note references it, show
  "`song.mp3` changed. 3 published notes use it." with a **Republish them**
  button. Track the referencing notes in memory from the last publish.

## 6. Rendering

### In the plugin (`remarkObsidianLinks.ts` and Markdown-link handling)

A resolved reference that §2 selected renders as an element carrying the
attachment key, **without** an area-specific URL:

| Reference | Output |
|-----------|--------|
| embed, image | `<img data-cpn-attachment="<sha256>/<fileName>" alt="…" width="…">`, honoring `\|300` / `\|300x200` |
| embed, audio | `<audio controls preload="metadata" data-cpn-attachment="…"></audio>` |
| embed, video | `<video controls preload="metadata" data-cpn-attachment="…"></video>`, sizes as for images |
| embed, pdf / other | `<a data-cpn-attachment="…" class="cpn-attachment">fileName</a>` |
| link (`embedsAndLinks`) | `<a data-cpn-attachment="…" class="cpn-attachment">display text</a>` |

Each element type gets a class (`cpn-attachment`, plus `-image`, `-audio`,
`-video` or `-file`) for styling. Block-level placement follows the existing
embed rule: a paragraph holding only embeds becomes block elements.

References that §2 rejected (mode off, wrong extension, excluded, too large,
unresolved) render as today's unpublished link.

**Why no URL in the HTML:** a note with groups `[a, b]` is published byte for
byte into both `restricted/a/` and `restricted/b/` (`src/utils/access.ts`). A
member of `b` only can't fetch `restricted/a/…`. So the HTML can't name one
area. The site fills in the area it actually loaded the note from.

### Raw Markdown

The published `raw` field keeps attachment links. When **Obscure wikilinks** is
on, the vault folder path is dropped, so `[[Media/2024/song.mp3]]` becomes
`[[song.mp3]]`. The folder path never leaves the vault.

### In the site (`infrastructure/assets/index/index.html`)

Edit the source template and run `npm run synth:site`. Never hand-edit
`src/publish/siteAssets.ts`.

- `fetchNoteJson(hash)` already tries each area in turn. It also returns the
  `prefix` it succeeded with (`''` or `restricted/<g>/`).
- After a note's HTML is inserted, and the same for transcluded embeds, which
  go through `fetchNoteJson` with their own prefix, rewrite every
  `[data-cpn-attachment]` element:
  - `img`, `audio`, `video` get `src`, and `a` gets `href`, set to
    `/<prefix>attachments/<key>`, with each path segment URI-encoded.
  - The element is scoped to the note it came from, so an embedded gated note's
    files resolve in the embedded note's area, not the host note's.
- A file that fails to load (404/403) shows a small "Attachment unavailable"
  state. There is no retry loop.

Upgrade note: notes published before this feature keep their old HTML.
Attachment rendering appears only after the notes republish (their hashes
change once the mode is on) and the site assets are re-pushed with the new
template.

## 7. Access areas and cleanup

### Which areas get a file

At upload, a staged note revision's areas are its access areas: public if it
has no groups, otherwise each `restricted/<group>/`. Each of its attachment
keys is ensured in each of those areas (§3, upload manifest).

### Which files an area needs

The set of files an area needs is **derived**, not reference-counted:

> required(area) = ⋃ `attachment-refs[h]` for every revision `h` in
> `publish-history[uid]`, for every UID currently published (present in the
> profile's mappings / access map) whose current access areas include `area`.

This works because existing code keeps revisions in the right places:

- All of a UID's revisions live in its current areas. An access change deletes
  every historical revision from the areas the note left
  (`applyAccessTransitions`).
- A deleted UID leaves the mappings (`Publisher.deletePublishedUid`), even
  though its publish history is kept.

Orphans(area) = manifest(area) − required(area).

### When to delete orphans

Orphans can only appear when published revisions are removed. Editing an
attachment never creates one, because the old revision still references the old
bytes.

1. **After `applyAccessTransitions`** removes revisions from areas a note left.
   This is the important one. Without it, a note moving from public to gated
   would leave its audio publicly fetchable. Delete orphans only in the areas
   touched by that transition, after the new mappings are live, as the
   existing code does for notes.
2. **After `deletePublishedUid`** (delete picker), in that UID's areas.
3. **After `purgeRestrictedPartition`** removes a whole group area (its
   `attachments/` goes with it, because the deletion is prefix-based). Drop that
   area from the manifest.

Deletes use `DeleteObjects` in batches. They need no CloudFront invalidation:
objects in the public area are immutable and nobody can reach them once
unreferenced. However, **an access change already forces an invalidation**
(`removedAny` in `pushLocalJsonsToS3`). Include the deleted attachment keys in
that invalidation's paths, so a cached copy of a formerly public file is
evicted at the edge.

### Fail-closed rules

- An attachment publishes only to the areas of the note revisions that
  reference it. A note that fails access resolution (`access.ok === false`) is
  blocked today. Its attachments are not staged.
- The edge contract is unchanged. `/restricted/<group>/attachments/*` sits under
  `/restricted/<group>/` and is enforced like notes. The existing "refuse to
  detach while `restricted/` has objects" check already covers attachment
  objects, because it lists the prefix.

### Audit

Extend **Audit published notes** to also list (in the console summary):

- Bucket objects under `attachments/` and `restricted/*/attachments/` that are
  not in required(area). These come from out-of-band changes or a lost
  manifest. Offer to delete them.
- Manifest entries whose object is missing. Clear them so the next publish
  re-uploads.

## 8. Implementation outline

| Area | Change |
|------|--------|
| `src/types.ts`, settings defaults, profile settings tab | `attachments` settings (§1) |
| new `src/utils/attachments.ts` | Reference collection, filters, hash cache, MIME map, key building, required/orphan derivation |
| `src/utils/notes.ts` | Collect refs in `queueNote`, add the `::att=` hash segment, write `attachment-refs.json` and `staged-attachments.json` in `commitPendingNotes` |
| `src/utils/remarkObsidianLinks.ts` (+ Markdown-link path) | Render selected refs as `data-cpn-attachment` elements (§6) |
| `src/publish/awsUpload.ts` | Upload attachments (manifest, HEAD, multipart, headers) before note JSON. Orphan sweep after access transitions, plus invalidation paths |
| `src/publish/publisher.ts` | `getUpdatedNotes` attachment-mtime rule. Orphan sweep in `deletePublishedUid`. Audit extension |
| `src/main.ts` | Vault `rename` / `delete` handling for the hash cache. Phase 2 `modify` notice |
| `infrastructure/assets/index/index.html` (+ `npm run synth:site`) | `fetchNoteJson` returns the prefix. Attachment rewriting. Unavailable state. CSS |
| `docs/publishing-model.md`, `docs/settings.md` | Replace the "attachments aren't published" limitation. Document settings, pinning and access behavior |

**Order of upload within one publish**, so no mapping ever points at a missing
object:

1. Membership sync.
2. Attachments.
3. Note JSON.
4. Mappings.
5. Access transitions, then the orphan sweep.
6. Invalidation.

## 9. Testing

**Unit tests:**

- Reference filtering: mode, extensions, deny-list, excluded directories, size.
- Hash cache hit and miss on size/mtime.
- MIME map.
- Key encoding for odd filenames: spaces, `#`, `?`, unicode.
- The `::att=` segment is order-independent and absent when there are no refs.
- required/orphan derivation across an access change and a UID delete.

**End-to-end** (see the `write-e2e-test` skill), on a sandbox AWS account only:

1. Embed an mp3 in a public note and publish. The player loads from
   `attachments/`.
2. Replace the mp3's bytes and publish updates. The note gets a new revision
   and the new audio. The old permalink still plays the old audio.
3. Gate the note to a group and publish. The file appears under
   `restricted/<g>/attachments/`. The public copy is gone, and an anonymous
   fetch of the old public URL returns 403/404.
4. Make two notes, one public and one gated, share a file. It exists in both
   areas. Ungating or deleting one leaves the other's copy intact.
5. Use a note with two groups. A member of only the second group can play it.
6. Embed a gated note that has attachments into a public note visible to group
   members. The files resolve from the embedded note's area.
7. With the mode `off`, rendering matches today's byte for byte, and no
   attachment objects are written.

## Open questions

- **Restricted cache lifetime.** `private, max-age=86400` is proposed in §3.
  Shorten it if removing a member should also stop replays from their browser
  cache sooner.
- **Multipart dependency.** Use `@aws-sdk/lib-storage` or manual multipart,
  depending on the bundle-size impact on `main.js`.
