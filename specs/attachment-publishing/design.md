# Spec: Publishing attachments (audio, images, PDFs, …)

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

## Decisions

| Question | Decision |
|----------|----------|
| Which version a note shows | **Pinned.** A note revision references the exact bytes it was published with. Editing the file creates a new note revision. |
| Access control | **One copy per access area.** The file is uploaded to every area (public, `restricted/<group>/`) that has a referencing note. No edge-function change. |
| What gets published | **Per-profile setting**, default **off**, with levels for how broadly links are followed, plus an extension allow-list and a size cap. |
| Public exposure | A file becomes public as soon as **any** public note references it. That note shows it to everyone anyway. |
| Source of a note's attachment list | **Obsidian's metadata cache only** (§2). The renderer never adds to it; it only renders what the list contains. |
| Reader experience | **Embeds play inline, everything else opens in a new tab.** `![[image]]`, `![[audio]]` and `![[video]]` render in the note. PDF and other embeds, and every plain link, open the file in a new browser tab. |
| Attachment list in note JSON | **Yes.** Each published note JSON lists its attachment keys (§4). |
| Diffing attachments | **No.** Attachments get no diff link or diff view. The note diff only says when they changed (§8). |
| Raw Markdown | Links to non-Markdown vault files lose their folder path when **Obscure wikilinks** is on, in both wikilink and Markdown syntax, whatever the attachment mode. New note hashes from this are accepted (§3). |
| File changed mid-publish | Re-check before commit and re-queue. If the bytes still mismatch at upload, fail the publish with staged files kept (§6). |
| Deleted bytes | Add an S3 lifecycle rule that expires noncurrent versions and aborts stale multipart uploads (§10). |
| Sign-in session | Raise the session from 1 hour to **12 hours** by default, configurable per profile in the infrastructure settings. Accept media stopping at session expiry (§11). |

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
  /** Files larger than this are skipped with a notice. 1–500. */
  maxFileSizeMB: number;
}

attachments?: AttachmentSettings; // absent ≡ { mode: 'off', …defaults }
```

- **`off`** (default): no file publishes. Rendering changes only as §3 describes
  for unpublished attachment links.
- **`embeds`**: `![[file.ext]]` and `![](file.ext)` publish the file.
- **`embedsAndLinks`**: plain `[[file.ext]]` and `[text](file.ext)` publish it too.

**Default allow-list:**

- Images: `png jpg jpeg gif webp avif svg`
- Audio: `mp3 m4a aac ogg oga opus wav flac`
- Video: `mp4 m4v webm mov`
- Documents: `pdf`

**Hard deny-list**, regardless of settings: `md html htm xhtml xml js mjs wasm`,
plus Obsidian's own file types (`canvas`, `base`). `md` files are notes and
publish through `cpn-publish-contexts`. The others would run as same-origin code
if opened directly. The settings field rejects denied extensions as they are
typed, with an inline message.

**Default cap:** 50 MB. The field accepts 1–500. The whole file is read into
memory at upload, and 500 MB is the most that is reasonable for that.

The profile's **Excluded directories** apply to attachments too
(`Publisher.isFileExcluded`). A file under `private/` never publishes, whichever
note links it.

**UI:** a new **Attachments** group in the profile's content settings
(`src/settings/profile/content.ts`, or a new `attachments.ts` beside it): a mode
dropdown, an extensions text field (space- or comma-separated) and a size field.
On Local profiles the group shows but is disabled, with the note "Attachments
publish on AWS profiles only."

When the mode is first changed from `off`, show a notice: run **Publish all
notes** once so existing notes pick up their attachments (§7).

## 2. Which files a note references

The attachment list comes **only** from Obsidian's metadata cache. This is the
single source of truth for what uploads, what joins the note hash and what the
renderer may show.

While queuing a note (`NoteManager.queueNote`, `src/utils/notes.ts`), for AWS
profiles whose mode isn't `off`:

1. Read `metadataCache.getFileCache(file)`. Take its `embeds`, and in
   `embedsAndLinks` mode also its `links`. Both cover wikilink and Markdown
   syntax. Frontmatter links (`frontmatterLinks`) are ignored.
2. Resolve each `link` with
   `metadataCache.getFirstLinkpathDest(getLinkpath(link), file.path)`.
   `getLinkpath` drops a `#page=3`-style fragment.
3. Keep it if it resolves to a `TFile` that:
   - is not Markdown,
   - has an allowed, non-denied extension (case-insensitive),
   - is not under an excluded directory,
   - is within the size cap (`file.stat.size`).

   A file that fails only the size cap is skipped. The batch shows one notice
   naming the skipped files ("2 attachments over 50 MB were not published:
   talk.mov, raw.wav").
4. De-duplicate by vault path. Hash each kept file (§5, hash cache) and attach
   the list to the note's state:

```ts
interface AttachmentRef {
  vaultPath: string;   // for upload and notices only; never published
  sha256: string;      // hex, 64 chars
  fileName: string;    // basename, e.g. "song.mp3"
  ext: string;         // lowercase
  size: number;
  mtime: number;       // file.stat.mtime when hashed (see §6, change detection)
  kind: 'image' | 'audio' | 'video' | 'file';
}
// NoteState gains: attachments: AttachmentRef[]
```

`kind` comes from the extension: the default image, audio and video sets above,
otherwise `file`. An extension the user adds to the allow-list is `file`.

If `getFileCache` returns null (the note isn't indexed yet), the list is empty.
The note then publishes with every attachment link unpublished, which fails
closed. Links inside code blocks and inline code are ignored, because the
metadata cache already excludes them.

A note blocked by access resolution (`access.ok === false`) returns before this
step, so its attachments are never collected or staged.

## 3. Rendering in the plugin

### New built-in parser stage: `remark-attachments`

A new scaffold in `src/utils/parser/scaffolds/remark-attachments.ts`, stage
`remark`, **order 38**: after `remark-block-ids` (35), before
`remark-obsidian-links` (40). A separate stage, rather than more code in
`remarkObsidianLinks`, keeps existing vault overrides of `remark-obsidian-links`
working unchanged. Attachment references never reach that stage.

`ParserContext` (`src/utils/parser/types.ts`) gains:

```ts
/**
 * Look up a link target. null: not a non-Markdown vault file (a note, an
 * unresolved link, an external URL), so leave it alone.
 */
resolveAttachment: (linkpath: string) => AttachmentRender | null;

type AttachmentRender =
  | { published: true; key: string; fileName: string; kind: AttachmentRef['kind'] }
  | { published: false; fileName: string };
```

`NoteManager.markdownToHtml` builds it from the note's `AttachmentRef[]`. It
resolves the linkpath with `getFirstLinkpathDest`. If the target is a
non-Markdown file, it returns `published: true` when the file is in the note's
list, otherwise `published: false`. The renderer is therefore an allow-list: it
can't show a file that won't be uploaded. Once a file is in the list, **every**
reference to it in the note renders as an attachment. In `embeds` mode, a plain
link to a file that is also embedded becomes a working link, because the file is
published anyway. On Local profiles, and with the mode `off`, every vault file
is `published: false`.

The stage handles:

- **Wikilinks** in `text` nodes (`[[…]]` and `![[…]]`), parsed with the shared
  `parseWikilinkInner`. Matching text is split out of the text node. The rest of
  the text node, including any note wikilinks, stays for
  `remark-obsidian-links`.
- **Markdown** `image` and `link` mdast nodes whose `url` is relative: no scheme
  (`/^[a-z][a-z0-9+.-]*:/i`), not starting with `#`, `/` or `//`. The URL is
  percent-decoded before lookup.

Inside a heading, embeds render as attachment links (as transclusions do: a
heading can't hold media).

### Output

| Reference | Output |
|-----------|--------|
| embed, `image` | `<img class="cpn-attachment cpn-attachment-image" data-cpn-attachment="<key>" alt="…" loading="lazy">`. `\|300` sets `width`; `\|300x200` sets `width` and `height`. The same applies to Markdown `![alt\|300](pic.png)`. |
| embed, `audio` | `<audio class="cpn-attachment cpn-attachment-audio" controls preload="metadata" data-cpn-attachment="…"></audio>` |
| embed, `video` | `<video class="cpn-attachment cpn-attachment-video" controls preload="metadata" data-cpn-attachment="…"></video>`, sized as for images |
| embed, `file` (pdf, other) | `<a class="cpn-attachment cpn-attachment-file" data-cpn-attachment="…" target="_blank" rel="noopener">fileName</a>` |
| plain link (any kind) | `<a class="cpn-attachment cpn-attachment-file" data-cpn-attachment="…" target="_blank" rel="noopener">display text</a>` |
| `published: false` | today's `<span class="unpublished-link">display text</span>` |

- `<key>` is `<sha256>/<fileName>`, HTML-attribute-escaped. File names can hold
  `"`, `<`, `&`, `#`, `?`, spaces and Unicode.
- A `#page=N` fragment on a PDF link is kept as `data-cpn-fragment="page=N"`.
  The site appends it to the URL.
- The HTML never contains an `src` or `href` for an attachment, for the reason
  below.
- `img`, `audio` and `video` are phrasing content, so they stay inside their
  `<p>`. No block-mode retagging is needed; CSS makes audio and video
  block-level.
- Known limitation: a paragraph that mixes an attachment embed with a note embed
  (`![[pic.png]] ![[Note]]`) now has several children, so the note embed takes
  the inline transclusion path instead of the block one.

**Display text:** the alias when there is one (not a size alias). Otherwise, with
**Obscure wikilinks** on, the file name. With it off, the link as written.

**Why no URL in the HTML:** a note with groups `[a, b]` is published byte for
byte into both `restricted/a/` and `restricted/b/` (`src/utils/access.ts`). A
member of `b` only can't fetch `restricted/a/…`. So the HTML can't name one
area. The site fills in the area it actually loaded the note from (§8).

**Behavior change with the mode `off`:** Markdown links and images that resolve
to vault files render as unpublished spans instead of passing through as broken
relative URLs. Wikilinks to vault files show the file name rather than the
folder path when Obscure wikilinks is on. External URLs and links that don't
resolve are untouched.

The scaffold's doc block states the contract with the site: the
`data-cpn-attachment` attribute and the classes.

### Raw Markdown

The published `raw` field keeps attachment links, with the vault folder path
removed when **Obscure wikilinks** (`obscureRawWikilinks`) is on. This applies to
every link that resolves to a non-Markdown vault file, **whatever the attachment
mode**:

| Written | Published `raw` |
|---------|-----------------|
| `![[Media/2024/song.mp3]]` | `![[song.mp3]]` |
| `[[Docs/slides.pdf#page=3\|deck]]` | `[[slides.pdf#page=3\|deck]]` |
| `![](Media/2024/my%20pic.png)` | `![](my%20pic.png)` |
| `![alt\|300](<Media/my pic.png>)` | `![alt\|300](<my pic.png>)` |
| `[notes](Docs/a.pdf)` | `[notes](a.pdf)` |

- Wikilinks: the scrubber callback (`scrubRawWikilinks` in
  `src/utils/rewriteRawWikilinks.ts`) becomes
  `resolveTarget(notePath) => { kind: 'note', uid } | { kind: 'file', fileName } | null`.
  File targets are rewritten to the file name, keeping the alias and fragment.
  Note targets behave exactly as today.
- Markdown links: the same pass visits `image` and `link` nodes. A relative URL
  that resolves to a non-Markdown vault file has its destination replaced by the
  file name, keeping its encoding style (percent-encoded or `<…>`) and fragment.
  Spliced by source offset, as for wikilinks.
- Unresolved targets are left as today.

The folder path then never leaves the vault in `raw`, the HTML, the search index
or the chat corpus. Notes with such links get new hashes once, and republish, on
the first publish after upgrading. That is accepted: what they publish changes.

## 4. Pinning: attachments in the hash and the note JSON

### Note hash

The content hash (`notes.ts`, `currentHash`) gains an attachment segment **only
when the note has attachment references**. Access groups and `cpn-style` are
added the same way:

```ts
const att = [...new Set(refs.map(r => `${r.sha256}/${r.fileName}`))].sort();
… + (att.length ? `::att=${att.join(',')}` : '')
```

As a result:

- **Notes without links to non-Markdown files keep their hashes.**
- **Notes with such links get a new hash once** when Obscure wikilinks is on,
  from the `raw` change in §3.
- **Editing an attachment changes the hash of every note that references it.**
  The next publish that includes those notes records a new revision, and the
  old revision keeps pointing at the old bytes.
- **Turning the mode on, or widening it, changes the hashes of the affected
  notes**, so they republish with working attachments. Narrowing it, or turning
  it off, also gives them a new revision, without the files. The files stay in
  the bucket because older revisions still reference them (§9). The settings
  help text says so.
- **Renaming the file** changes the note text and `fileName`, giving a new
  revision.

### Note JSON

Each staged note JSON (`writeNoteToStaging`) gains, when non-empty:

```jsonc
"attachments": [
  { "key": "<sha256>/song.mp3", "name": "song.mp3", "size": 1234567 }
]
```

Sorted by key. It is the same in every area copy and relative to the area, like
the HTML. It is omitted when empty, so notes without attachments keep their JSON
shape. It is used by:

- the local-state rebuild (§5), which makes the bucket recoverable without the
  plugin's local files;
- the diff notice (§8);
- a future attachment list in the note UI.

## 5. Local state

All files live in the profile directory (`ProfileManager.getProfileDir`), next
to `publish-history.json`.

### `attachments.json`: references and upload manifest

One file, so its presence and completeness can be judged as a whole:

```jsonc
{
  "version": 1,
  // false until this file is known to cover every published revision (below)
  "complete": true,
  // note content hash -> attachment keys that revision uses
  "refs": { "<noteHash>": ["<sha256>/<fileName>", …] },
  // what each area already holds ("" = public, "restricted/<g>/")
  "uploaded": { "": ["<sha256>/<fileName>", …], "restricted/family/": [ … ] }
}
```

- `refs` entries are written in `commitPendingNotes`, next to the publish
  history. Revisions without attachments are omitted.
- `uploaded` entries are added as uploads succeed (§6).
- **Completeness.** When the file is first created, `complete` is `true` only if
  the profile's publish history is empty. Otherwise (an upgraded profile, a new
  machine, a lost file) it is `false`. Any orphan deletion (§9) and the audit's
  delete offer first run a **rebuild** when `complete` is `false`. Without this,
  a fresh file holding only new revisions would look authoritative and could
  delete files that older live revisions still use.
- **Rebuild:**
  1. List `notes/` and `restricted/*/notes/` with `ListObjectsV2`.
  2. GET each note JSON (concurrency 5, progress notice) and record its
     `attachments` keys under its hash. Pre-feature revisions have no field, so
     they correctly record nothing.
  3. List `attachments/` and `restricted/*/attachments/` to rebuild `uploaded`.
  4. Merge with the local file and set `complete: true`.

  If the rebuild fails (credentials, network), the operation that needed it
  skips its deletes and says so (§9).

### `attachment-hash-cache.json`

Hashing a large file on every publish is wasteful:

```jsonc
{ "<vaultPath>": { "size": 1234567, "mtime": 1763900000000, "sha256": "…" } }
```

Re-hash (with `vault.readBinary` and `crypto.subtle.digest('SHA-256', …)`) only
when `size` or `mtime` differ from the cached values. In `src/main.ts`, a vault
`rename` event moves the entry to the new path and a `delete` event drops it.
The cache only saves work, so losing it costs nothing but re-hashing.

### Staging: `staged-attachments.json`

Binary files are **not** copied into staging, which would double disk use for
large media. A profile-level `staged-attachments.json` lists what the staged
batch needs:

```jsonc
[ { "area": "", "key": "<sha256>/song.mp3", "vaultPath": "Media/song.mp3",
    "sha256": "…", "fileName": "song.mp3", "size": 1234567 } ]
```

- It sits **beside** `staged-notes/`, not inside it, because
  `listStagedNoteUploads` treats every top-level `.json` in `staged-notes/` as a
  note.
- Entries are keyed by `area + key` and **merged** with any entries a failed
  earlier batch left. The next upload sends everything in staging, so the two
  must stay in step.
- `cleanupStagedFiles` deletes it, and `handlePublishError` copies it into the
  error session directory with the staged notes.

## 6. Upload

### Order within one publish

In `pushLocalJsonsToS3`, so no mapping ever points at a missing object:

1. Membership sync.
2. **Attachments.** A failure stops the publish here, before any note JSON.
3. Note JSON.
4. Mappings.
5. Access transitions, then the orphan sweep (§9).
6. Invalidation.

### Which areas get a file

A staged note revision's areas are its access areas (`partitionsFor`): public if
it has no groups, otherwise each `restricted/<group>/`. Each of its attachment
keys is ensured in each of those areas.

### Per (area, key)

```
<s3Prefix>attachments/<sha256>/<fileName>                  # public area
<s3Prefix>restricted/<group>/attachments/<sha256>/<fileName>
```

1. If `uploaded[area]` lists it, skip it.
2. Otherwise, send a `HeadObject`. On 200, record it and skip it. This recovers
   a lost manifest. On 404 continue. A 403 also counts as missing, because
   without `s3:ListBucket` S3 reports a missing key as 403.
3. Read the bytes from the vault and **re-hash** them (see change detection
   below).
4. Upload. Files up to 16 MB use one `PutObject`. Larger files use multipart:
   8 MB parts, 4 in parallel, through `CreateMultipartUpload` / `UploadPart` /
   `CompleteMultipartUpload`, with `AbortMultipartUpload` on any failure. These
   commands are already in the bundled `@aws-sdk/client-s3`, so there is **no
   new dependency** (this settles the former `@aws-sdk/lib-storage` question).
5. Record it in `uploaded[area]`. Save `attachments.json` after step 2 of the
   publish, including on failure, so finished uploads aren't repeated.

Uploads run with the existing `runWithConcurrency` (5) and a progress notice
counting files.

Notes on the key design:

- The hash makes every key immutable. A key's bytes never change, so caches
  never go stale and attachment uploads need no CloudFront invalidation.
- Keeping `<fileName>` as the last segment gives downloads and new tabs a
  sensible name.
- If two vault files share bytes but not names, both keys exist. That duplicate
  is negligible and keeps the URL honest about the filename.
- Hashes are full SHA-256. Unlike note hashes, these URLs are fetched directly,
  so they should be unguessable.

### Headers

**`Content-Type`** comes from an extension map in `src/utils/attachments.ts`:

| Ext | Type | Ext | Type |
|-----|------|-----|------|
| png | image/png | mp3 | audio/mpeg |
| jpg, jpeg | image/jpeg | m4a | audio/mp4 |
| gif | image/gif | aac | audio/aac |
| webp | image/webp | ogg, oga | audio/ogg |
| avif | image/avif | opus | audio/opus |
| svg | image/svg+xml | wav | audio/wav |
| mp4, m4v | video/mp4 | flac | audio/flac |
| webm | video/webm | mov | video/quicktime |
| pdf | application/pdf | *(other allowed)* | application/octet-stream |

**`Content-Disposition`**:

- `inline; filename*=UTF-8''<percent-encoded name>` for mapped types, so a PDF
  opens in the browser's viewer in the new tab, under its own name.
- `attachment; filename*=UTF-8''…` for `svg` and every unmapped extension.
  `<img>` ignores the header and renders SVG normally. Opening the URL directly
  downloads it instead of running any script it holds at the site's origin.

**`Cache-Control`**:

| Area | Site | Value |
|------|------|-------|
| public | public site (`readGateMode` `none`) | `public, max-age=31536000, immutable` |
| public | whole-site gate (`cognito`, `password`, `byo`) | `private, max-age=31536000, immutable` |
| `restricted/<g>/` | any | `private, max-age=<session length in seconds>, immutable` |

The session length is the profile's sign-in session (§11), 12 h by default.
Notes in restricted areas use `private, no-store` (`RESTRICTED_CACHE_CONTROL`),
but re-downloading a 20 MB file on every play is not acceptable. The `private`
directive keeps shared caches out. The edge function runs on every viewer
request, before CloudFront's cache, so access is still checked on each request
that reaches CloudFront. A member removed from a group can replay only bytes
their own browser already holds, for at most one session length.

S3 and CloudFront already serve byte-range requests, which `<audio>` and
`<video>` seeking needs.

### Change detection between queue and upload

A file can change while a publish is running:

1. **Before commit.** At the start of `commitPendingNotes`, compare each pending
   note's refs against the file's current `stat.size` and `stat.mtime`. If any
   differ, re-run `queueNote` for that note (which re-hashes). If it differs
   again on that second check, stop the publish before anything commits:
   "`song.mp3` is still changing. Publish again when it is saved."
2. **At upload.** If the re-hash in step 3 above doesn't match, stop the publish
   before any note JSON uploads, keeping staged files as other upload failures
   do: "`song.mp3` changed while publishing. Publish the notes that use it
   again."
3. **The next publish.** History and mappings were already committed for the
   staged revision, and its bytes are gone from the vault. Staged entries whose
   vault file no longer matches its hash, or no longer exists, are **dropped**
   with a console warning. Their notes still upload, and those revisions show
   "Attachment unavailable" for that file. Republishing the note records a newer
   revision with the current bytes, which becomes the live one. The dropped keys
   stay in `refs`, and the audit lists them as "referenced, never uploaded".

## 7. Noticing changed attachments

Editing a file doesn't touch the notes that reference it, so mtime-based scopes
would miss the change.

- **Publish updates since last full publish** (`Publisher.getUpdatedNotes`):
  when the mode isn't `off`, also include every publishable note whose
  `metadataCache.resolvedLinks` reach an allowed attachment file with
  `mtime > lastFullPublishTimestamp`. `resolvedLinks` doesn't separate embeds
  from links, so `embeds` mode may include a note that only links the file. Its
  hash doesn't change, so it records no new revision.
- **Publish active and connected notes** and **Publish current note** need no
  change. They re-queue the note, and the hash check picks up the new bytes.
- **Change notice (phase 4, §12).** On a vault `modify` event for a file in the
  hash cache, debounced 5 s: if any currently published note references it,
  show "`song.mp3` changed. 3 published notes use it." with a **Republish them**
  button. The referencing notes are tracked in memory from the last publish.

## 8. The site

Edit `infrastructure/assets/index/index.html` and run `npm run synth:site`.
Never hand-edit `src/publish/siteAssets.ts`.

### Area prefix

- `fetchNoteJson(hash)` already tries each area in turn. It also returns the
  `prefix` it succeeded with (`''` or `restricted/<g>/`).
- `loadNoteByParameter` and `fetchTranscludedNote` keep it on the note data
  (`noteData.areaPrefix`). The home note's `index.json` is public, so its
  prefix is `''`.

### Resolving attachment elements

A new `hydrateAttachments(root, prefix)` processes every
`[data-cpn-attachment]:not([data-cpn-att])` element under `root`:

- Build the URL `/<prefix>attachments/<sha256>/<encodeURIComponent(fileName)>`,
  plus `#<data-cpn-fragment>` if present.
- `img`, `audio` and `video` get `src`. `a` gets `href` (it already has
  `target="_blank" rel="noopener"`).
- Mark the element `data-cpn-att="1"` so a later pass skips it.
- Everything is set through DOM properties, never `innerHTML`.

**Scoping**, so an embedded gated note's files resolve in that note's area, not
the host's:

1. `renderNote` calls `hydrateAttachments(contentEl, noteData.areaPrefix)`
   **before** `hydrateTransclusions`.
2. `hydrateOne` (transclusions) calls `hydrateAttachments` on the extracted
   nodes with the **embedded** note's prefix before inserting them.

Attachment links are not `a[href^="#"]`, so `bindNoteLinks` never intercepts
them.

### Unavailable and expired states

- `img`, `audio` and `video` listen for `error`. On error, the element gets a
  `cpn-attachment-unavailable` class and a small inline label, "Attachment
  unavailable", with no retry loop. A missing object behind OAC returns 403, so
  403 and 404 look the same here.
- In a restricted area, the error handler first fetches `/restricted/whoami`
  (`cache: 'no-store'`). If `signedIn` is false, the label instead reads
  "Sign in again to play this", with the existing sign-in link
  (`hostedUiLoginUrl`). This covers a session that expires during a long
  recording (§11).
- Links can't detect failure. A new tab for a missing or forbidden file shows
  the raw response: S3's error, or the edge's `{"error":"cpn_forbidden"}` on a
  public-reads site when signed out. On a whole-site gate, a signed-out new tab
  is a navigation, so the edge redirects to sign-in and back to the file. This
  is the accepted v1 behavior.

### Diff panel

Attachments get no diff of their own. In `buildDiff`, compare the two
revisions' `attachments` lists by key:

- If `raw` differs and the lists differ, show a notice above the diff:
  "Attachments changed: song.mp3, cover.png."
- If `raw` is identical and the lists differ, replace "No differences between
  these two versions." with "The text is identical. Attachments changed:
  song.mp3."

### CSS

- `.cpn-attachment-image`: `max-width: 100%; height: auto`.
- `.cpn-attachment-audio`: `display: block; width: 100%; margin: .5em 0`.
- `.cpn-attachment-video`: `display: block; max-width: 100%; height: auto`.
- `.cpn-attachment-file`: an "opens in a new tab" icon after the text.
- `.cpn-attachment-unavailable`: muted, with a small inline label.

Both light and dark themes are covered.

### Upgrade note

Notes published before this feature keep their old HTML. Attachment rendering
appears only after the notes republish (their hashes change once the mode is
on) and the site assets are re-pushed. A plugin update re-pushes them on the
next publish through the existing fingerprint check.

## 9. Access areas and cleanup

### Which files an area needs

The set of files an area needs is **derived**, not reference-counted:

> required(area) = ⋃ `refs[h]` for every revision `h` in `publish-history[uid]`,
> for every UID currently published (present in the profile's mappings / access
> map) whose current access areas include `area`.

This works because of how existing code places revisions:

- An access change deletes every historical revision from the areas the note
  left (`applyAccessTransitions`).
- A deleted UID leaves the mappings (`Publisher.deletePublishedUid`), even
  though its publish history is kept.

It is a **superset**, which is the safe direction. An access change doesn't
copy old revisions into the areas a note enters, so some required keys belong
to revisions that aren't in that area. The derivation can over-retain a file,
but it never deletes one a live revision uses.

### When to delete orphans

Orphans can only appear when published revisions are removed. Editing an
attachment never creates one, because the old revision still references the old
bytes.

1. **After `applyAccessTransitions`**, once the new mappings are live, in each
   area a note left. This includes blocked notes (`to: null`). This is the
   important one: without it, a note moving from public to gated would leave
   its audio publicly fetchable.
2. **After `deletePublishedUid`** (delete picker), in each area it deleted
   from.
3. **After `purgeRestrictedPartition`** removes a whole group area. Its
   `attachments/` goes with it, because the deletion is prefix-based. Drop that
   area from `uploaded`.

**Sweep, for one area:**

- candidates = ⋃ `refs[h]` for the removed revisions `h`.
- orphans = candidates − required(area).

Only keys of the removed revisions are candidates, which bounds what a sweep can
delete. Delete them with `DeleteObjects` (batches of 1000), and remove them from
`uploaded[area]`.

The sweep needs `attachments.json` to be `complete`. If it isn't, rebuild first
(§5). If the rebuild fails, skip the sweep and show a persistent notice:
"Couldn't check `<note>`'s attachments. They may still be readable in `<area>`.
Run **Audit published notes**." The note's own deletion still happens.

**Invalidation:** none is added. An access change already invalidates `/*`
(`removedAny` in `pushLocalJsonsToS3`, and `createCloudFrontInvalidation` always
sends `/*`), and so does `deletePublishedUid`. That evicts any cached copy of a
formerly public file.

### Fail-closed rules

- An attachment publishes only to the areas of the note revisions that
  reference it. A note that fails access resolution (`access.ok === false`) is
  blocked today, and its attachments are never collected (§2).
- The edge contract is unchanged. `/restricted/<group>/attachments/*` sits under
  `/restricted/<group>/` and is enforced like notes. The existing "refuse to
  detach while `restricted/` has objects" check already covers attachment
  objects, because it lists the prefix.
- The renderer can't show a file that isn't in the note's list (§3), and the
  list is staged with the note.

### Audit

**Audit published notes** reads only local files today. With attachments it
also lists the bucket (it needs `s3:ListBucket`) and reports in the console
summary:

- **Unreferenced objects:** keys under `attachments/` and
  `restricted/*/attachments/` that are not in required(area). These come from
  out-of-band changes or a skipped sweep. Offer to delete them, only after a
  rebuild if `complete` is false.
- **Missing objects:** keys in required(area) with no object. If the vault still
  has matching bytes, clear them from `uploaded`, so the next publish of a
  referencing note re-uploads them. Otherwise list them as "referenced, never
  uploaded (bytes no longer in the vault)".

## 10. Bucket lifecycle rule

The site bucket has versioning on and no lifecycle rule
(`infrastructure/lib/full-stack-oac.ts`, `full-stack-oai.ts`). A swept
attachment becomes a delete marker over a retained version: unreachable through
CloudFront, but stored and billed indefinitely. Abandoned multipart uploads
linger the same way.

**Template change** (both site stacks): a new parameter `NoncurrentVersionDays`
(Number, default **30**, `0` disables that rule) and a `LifecycleConfiguration`
on the bucket:

- `NoncurrentVersionExpiration: { NoncurrentDays: NoncurrentVersionDays }`,
  through `Fn::If` and `AWS::NoValue` when it is `0`;
- `AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 }`, always.

This applies to the whole bucket. Overwritten or deleted note JSON, mappings and
`config.json` also become unrecoverable 30 days after they stop being current.
That is the point of the rule, and the docs say so.

**Rollout:**

- New deployments get it from the wizard with the default.
- Existing deployments: a new row in **Settings → Infrastructure**, "Bucket
  cleanup rule", showing the current state, a days field and an **Apply**
  button. Apply runs a targeted site-stack update (the `updateFullStackOrigins`
  pattern: current template, `NoncurrentVersionDays` overridden, every other
  parameter `UsePreviousValue`, `preserveLiveDomain` applied). It polls to
  completion with the event log used elsewhere.
- Imported stacks show "Managed outside the plugin; add a lifecycle rule in
  CDK" instead of the button.
- The applied value is persisted as `InfrastructureState.bucketLifecycleDays`.

Run `npm run synth` to regenerate `src/infrastructure/templates.ts`.

## 11. Sign-in session length

### Why

The `cpn_id` session cookie is set with `Max-Age=3600`
(`infrastructure/assets/lambda/auth-callback.js`). The cookie holds a Cognito ID
token, which the edge function (`lib-jwt-verify.js`, `exp` check) and the
comment authorizer both reject once it expires. The pool's app client uses
Cognito's default ID token lifetime of 1 hour. Both must be raised together,
because a longer cookie holding a 1-hour token changes nothing. Media requests
can't trigger the site's reload-to-sign-in, so a long recording stops when the
session ends. A 12-hour default makes that rare, and the remaining risk is
accepted (§8 covers the message).

### Changes

**Cognito pool stack** (`infrastructure/lib/cognito-auth-stack.ts`):

- New parameter `SessionHours` (Number, default **12**, `MinValue` 1,
  `MaxValue` 24). 24 h is Cognito's maximum ID token lifetime.
- `UserPoolClient`: `idTokenValidity` and `accessTokenValidity` set to
  `SessionHours`, with `tokenValidityUnits: { idToken: 'hours', accessToken:
  'hours' }`. The refresh token keeps its default; the site doesn't use it.

**Callback Lambda** (`auth-callback.js`): the cookie's `Max-Age` becomes the ID
token's `exp` minus now. It decodes the token payload without verifying it;
the token came straight from Cognito's token endpoint over TLS. The value is
floored at 0 and falls back to 3600 if `exp` can't be read. The cookie can then
never outlive its token, and `SessionHours` is the only setting.

**Plugin:**

- `CloudFormationManager`: add `SessionHours` to `COGNITO_AUTH_PARAM_KEYS` and
  `buildCognitoAuthParameters`. `DeploymentConfig.sessionHours` and
  `CognitoAuthState.sessionHours` are persisted.
- **Deployment wizard**, Cognito step: a "Sign-in session length (hours)" field,
  default 12.
- **Settings → Infrastructure → Cognito gate**: a "Sign-in session length" row
  with an hours field (1–24) and an **Apply** button. It calls a new
  `updateCognitoSessionLength(profile, hours)`, which:
  - runs `UpdateStack` on the pool stack in us-east-1 with the **current**
    `COGNITO_AUTH_TEMPLATE` (older pools lack the parameter, so
    `UsePreviousTemplate` won't do), with
    `buildCognitoAuthUpdateParameters({ SessionHours }, deployedKeys)`, so the
    never-stored Google client secret stays `UsePreviousValue`;
  - polls to completion with the event log;
  - saves `sessionHours`.
  
  It is disabled, with a reason, on a legacy pool that still holds its inline
  edge function ("Run **Upgrade Cognito gate** first"), because the current
  template would remove that function without the upgrade's retain step. It is
  also disabled on imported stacks.
- `upgradeCognitoGate` and other pool-stack updates pass the persisted
  `sessionHours`, so they don't reset it to the default.

### Effect and trade-offs

- It applies at each reader's next sign-in. Existing cookies keep their
  expiry.
- It covers the whole-site Cognito gate, access-group sign-in on public sites,
  and comment sign-in. They share one app client.
- Removing someone from a group, or from the site, takes effect within one
  session length (12 h by default) instead of about an hour. A copied cookie is
  also valid that long.
- Restricted attachments are cached privately for one session length (§6).
- `docs/auth-and-access.md` ("Membership changes apply at a reader's next
  sign-in…") is updated to match.

## 12. Implementation outline

| Area | Change |
|------|--------|
| `src/types.ts`, settings defaults, profile settings tab | `attachments` settings (§1). `bucketLifecycleDays`, `sessionHours` state. |
| new `src/utils/attachments.ts` (pure, no Obsidian imports) | Reference filters, extension sets and deny-list, kind, MIME and disposition, key building and URL encoding, `::att=` segment, staged-entry merge, required/candidate/orphan derivation |
| new `src/utils/attachmentState.ts` | `attachments.json` load/save, completeness, rebuild from bucket. Hash cache. |
| `src/utils/notes.ts` | Collect refs in `queueNote` (§2), `::att=` segment, pre-commit re-check, `refs` in `commitPendingNotes`, `attachments` in note JSON, `staged-attachments.json` |
| new `src/utils/parser/scaffolds/remark-attachments.ts`, `src/utils/remarkAttachments.ts`, `ParserContext.resolveAttachment`, `libs.remarkAttachments` | Rendering (§3) |
| `src/utils/rewriteRawWikilinks.ts` | File targets and Markdown links in the raw scrub (§3) |
| `src/publish/awsUpload.ts` | Attachment upload step (manifest, HEAD, multipart, headers, re-hash). Sweep after access transitions and partition purge. |
| `src/publish/publisher.ts` | `getUpdatedNotes` attachment-mtime rule. Sweep in `deletePublishedUid`. Audit extension. Staged-file cleanup and error copy. |
| `src/main.ts` | Vault `rename` / `delete` for the hash cache. Phase 4 `modify` notice. |
| `infrastructure/assets/index/index.html` (+ `npm run synth:site`) | `fetchNoteJson` prefix, `hydrateAttachments`, transclusion scoping, unavailable/expired states, diff notice, CSS |
| `infrastructure/lib/cognito-auth-stack.ts`, `infrastructure/assets/lambda/auth-callback.js`, `src/infrastructure/cloudFormationManager.ts`, wizard, `src/settings/profile/infrastructure.ts` | Session length (§11) |
| `infrastructure/lib/full-stack-oac.ts`, `full-stack-oai.ts`, `cloudFormationManager.ts`, `src/settings/profile/infrastructure.ts` (+ `npm run synth`) | Lifecycle rule (§10) |
| `docs/publishing-model.md`, `docs/settings.md`, `docs/parser-extensions.md`, `docs/auth-and-access.md`, `docs/infrastructure-deployment.md` | Replace the "attachments aren't published" limitation. Document settings, pinning, access, the new stage, session length, the lifecycle rule, and the S3 permissions publishing now uses (`s3:GetObject` for HEAD and rebuild, `s3:ListBucket` for audit and rebuild, `s3:AbortMultipartUpload`). |

**Phases.** Each is a reviewable unit.

1. **Session length (§11).** Independent of attachments, and can ship first.
2. **Core attachments (§1–§8).** Settings, collection, hash, note JSON, the new
   stage, raw scrub, local state, upload, site rendering, `getUpdatedNotes`.
3. **Cleanup (§9, §10).** Sweeps, rebuild, audit, lifecycle rule.
   **Phases 2 and 3 ship in the same release.** Phase 2 alone would leave
   public copies behind when a note is gated.
4. **Change notice (§7).**

## 13. Testing

**Unit tests** (`npx tsx e2e/scripts/…`, one `package.json` script each, as
existing tests do):

- `test-attachments.ts`, for `src/utils/attachments.ts`:
  - reference filtering: mode, extensions, deny-list (including user-typed
    denied extensions), excluded directories, size;
  - kind and MIME/disposition maps, RFC 5987 file names;
  - key encoding for odd file names: spaces, `#`, `?`, `%`, `"`, Unicode;
  - the `::att=` segment is order-independent, de-duplicated, and absent when
    there are no refs;
  - staged-entry merge across a failed batch;
  - required/candidate/orphan derivation across an access change, a UID delete,
    a blocked note, and two notes sharing a file in different areas.
- `test-attachment-state.ts`: completeness on creation (empty versus non-empty
  history), rebuild merge, hash cache hit and miss on size/mtime, rename and
  delete.
- `test-obscure-wikilinks.ts`, extended: file-target wikilinks with alias,
  fragment and embed `!`. Markdown images and links in percent-encoded and
  `<…>` forms. Unresolved targets unchanged. External URLs unchanged.
- **Parser:** add cases for `remark-attachments` (each output row in §3,
  headings, size aliases, mixed paragraphs, escaping, `published: false`), then
  re-capture `e2e/fixtures/parser-golden.json`, reviewing every diff. Expected
  diffs are only attachment links.
- `test-auth-callback.ts` (new): `Max-Age` from `exp`, the floor at 0, the
  fallback when `exp` is missing.
- **Site** (in the style of `test-transclusions-runtime.ts`):
  `hydrateAttachments` URL building and encoding, embedded-note scoping, the
  unavailable state, the expired-session label, and the diff notice wording.

**End-to-end** (the `write-e2e-test` skill), on the **sandbox AWS account
(`random`) only**, never the real `notes` site:

1. Embed an mp3 in a public note and publish. The player loads from
   `attachments/` and can seek (range requests).
2. Replace the mp3's bytes and publish updates. The note gets a new revision and
   the new audio. The old permalink still plays the old audio. The diff says
   "The text is identical. Attachments changed: …".
3. Gate the note to a group and publish. The file appears under
   `restricted/<g>/attachments/`. The public copy is gone, and an anonymous
   fetch of the old public URL returns 403.
4. Make two notes, one public and one gated, share a file. It exists in both
   areas. Ungating or deleting one leaves the other's copy intact.
5. Use a note with two groups. A member of only the second group can play it.
6. Embed a gated note that has attachments into a public note visible to group
   members. The files resolve from the embedded note's area.
7. A PDF embed and a plain `[[file.pdf]]` link open in a new tab with the
   browser's viewer and the file's own name. An `svg` opened directly
   downloads.
8. With the mode `off`, no attachment objects are written, and attachment links
   render as unpublished spans showing the file name.
9. Delete `attachments.json` and gate a note that has attachments. The publish
   rebuilds the state from the bucket, then sweeps the public copy.
10. Upload a file over 16 MB (multipart). It plays, and no incomplete multipart
    upload remains (`ListMultipartUploads`).
11. Apply a session length of 12 h. After signing in, the `cpn_id` cookie's
    `Max-Age` is about 43200 and the token's `exp` is about 12 h out. A
    pre-upgrade pool's Google sign-in still works after Apply.
12. Apply the bucket cleanup rule. `GetBucketLifecycleConfiguration` shows both
    rules, and the site's routes (`/auth/*`, comments, chat) still work.

## Defaults chosen

These were settled while writing the spec. Change any you disagree with:

- Noncurrent versions expire after **30 days** (§10).
- The size cap's ceiling is **500 MB** (§1).
- Inline images aren't clickable (no lightbox, no open-in-new-tab) in v1.
- A mixed paragraph (`![[pic.png]] ![[Note]]`) renders its note embed inline
  (§3).
