# Phase 2: Core attachment publishing (Beta)

Part of [Publishing attachments](design.md). **Beta.** Ships in the same
release as [phase 3](phase-3-cleanup.md): on its own it would leave public
copies behind when a note is gated.

Depends on phase 1: excluded-directory matching (P1 §2), the raw-scrub fixes
(P1 §3) and the Obscure attachment names scrubber (P1 §4).

Sections:

1. [Prerequisites](#1-prerequisites): publish lock, `handlePublishError`,
   publish timestamp
2. [Settings](#2-settings)
3. [Collecting references](#3-collecting-references)
4. [Rendering](#4-rendering)
5. [Pinning](#5-pinning)
6. [Local state](#6-local-state)
7. [Upload](#7-upload)
8. [Publish updates](#8-publish-updates)
9. [The site](#9-the-site)
10. [Tests](#10-tests)
11. [Docs and release](#11-docs-and-release)

## 1. Prerequisites

Each of these stands alone and may land before the rest of phase 2, including
with phase 1.

### Per-profile publish lock

Nothing stops two publishes, or a publish and the delete picker, from running
at once for the same profile today. The `discardQueued` call at the start of
`publishNotes` already drops notes another running publish has queued. With
attachments it gets worse: `publishNotes` reloads `attachments.json` from disk
at the start (§6), so a second publish can overwrite `refs` that the first holds
in memory and hasn't saved yet, and a later sweep (P3 §2) could then delete a
file that a live revision uses.

- [x] New module `src/utils/publishLock.ts`:

  ```ts
  /** Runs fn while holding profileId's lock. Returns { ran: false, heldBy } without
   *  running fn if the lock is held. Releases in finally. Not re-entrant. */
  withProfileLock<T>(profileId: string, label: string, fn: () => Promise<T>):
    Promise<{ ran: true; result: T } | { ran: false; heldBy: string }>;
  ```

  The lock is in memory, one per profile ID. Different profiles never block
  each other. It is released in `finally`, and quitting Obsidian releases it.
- [x] When the lock is held, the second request is **refused, not queued**:
      notice "`<profile>` is busy (`<heldBy>`). Try again when it finishes." It
      returns without doing anything. A queued request could run against a
      selection or settings that changed meanwhile.
- [ ] Held for the whole of:
  - [x] `Publisher.publishNotes`, from setup through upload, sweeps (P3 §2) and
        invalidation. This covers every publish command (`publishSingle`,
        `publishConnected`, **Publish updates since last full publish**,
        **Publish all notes**), because they all go through it. Label:
        "publishing".
  - [x] `Publisher.deletePublishedUid` (delete picker). Label: "deleting a
        note".
  - [x] The group purge in `src/settings/profile/accessGroups.ts`
        (`purgeRestrictedPartition`). Label: "removing a group's notes".
  - [x] `rebuildContentIndex` in `src/main.ts`, which writes the content index
        and may mint UIDs. Label: "rebuilding the content index".
  - [ ] From phase 3: the attachment-state rebuild and the audit's delete offer
        (P3 §3, P3 §4). Label: "checking attachments".
- [x] Callers inside a locked operation call the unlocked internals, never a
      locked entry point, because the lock isn't re-entrant.
- [x] Settings changes aren't locked. The re-check before upload (§7) handles a
      settings change in the middle of a publish.

The lock covers one machine. Several machines publishing one profile is still
out of scope (design.md, Assumptions).

### `handlePublishError` stops clearing staging

Today `handlePublishError` (`src/publish/publisher.ts`) copies staging into the
error session directory and then calls `cleanupStagedFiles`. That throws away
an earlier failed batch, whose history and mappings were already saved locally,
so the next successful publish pushes mappings that point at note JSON that was
never uploaded. The `uidConflicts` throw in `publishNotes` already hits this.

- [x] `handlePublishError` only copies. It no longer calls
      `cleanupStagedFiles`.
- [x] Staging is cleared only after a successful upload, so its entries are
      retried on the next publish. Uploading a staged note JSON that no mapping
      uses is harmless, because the site never fetches it.
- [x] It also copies `staged-attachments.json` (§6) into the error session
      directory.

### Publish timestamp taken at the start

`publishNotes` sets `lastFullPublishTimestamp = Date.now()` after the upload
finishes. A note or attachment edited during a long full publish, after it was
read, is then older than the timestamp and missed by the next **Publish updates
since last full publish**.

- [x] Record `const startedAt = Date.now()` at the start of `publishNotes`,
      before anything is queued, and write `startedAt` on success. An edit made
      during the publish is then picked up by the next updates run. A note
      re-queued that way with unchanged bytes has an unchanged hash, so it
      records no new revision.

## 2. Settings

- [x] New optional field on `PublishingProfile` (`src/types.ts`):

  ```ts
  interface AttachmentSettings {
    /** Which links to non-Markdown files publish the file. */
    mode: 'off' | 'embeds' | 'embedsAndLinks';
    /** Lowercase extensions without the dot. `*` allows every extension. */
    allowedExtensions: string[];
    /** Files larger than this are skipped with a notice. 1–500. */
    maxFileSizeMB: number;
  }

  attachments?: AttachmentSettings; // absent ≡ { mode: 'off', …defaults }
  ```

- **`off`** (default): no file publishes. Rendering changes only as §4
  describes for unpublished attachment links.
- **`embeds`**: `![[file.ext]]` and `![](file.ext)` publish the file.
- **`embedsAndLinks`**: plain `[[file.ext]]` and `[text](file.ext)` publish it
  too.

### Allow-list

- [x] Default allow-list:
  - Images: `png jpg jpeg gif webp avif svg`
  - Audio: `mp3 m4a aac ogg oga opus wav flac`
  - Video: `mp4 m4v webm mov`
  - Documents: `pdf`
- [x] The field accepts any entry. `*` allows every extension, including files
      that have none.

The default list only sets what publishes out of the box. **There is no
deny-list.** The user can add any extension: `html`, `js`, `zip`, `canvas`,
`base`, anything.

The only distinction kept is between notes and files. A link to a Markdown file
resolves to a note and publishes through `cpn-publish-contexts`, never as an
attachment (§3). This is the existing note pipeline, not a file-type rule.

Sharing a type doesn't mean the site renders it. Types that could run code at
the site's origin, if opened directly, are served as downloads (§7, Headers).

### Size cap

- [x] Default 50 MB. The field accepts 1–500.

Files are streamed from disk for hashing and upload (§6, §7), so the ceiling
bounds upload time and storage, not memory.

### Excluded directories

The profile's **Excluded directories** apply to attachments too
(`Publisher.isFileExcluded`, with the rules in P1 §2). A file under an excluded
folder never publishes, whichever note links it.

### UI

- [x] A new **Attachments (Beta)** group in the profile's content settings
      (`src/settings/profile/content.ts`, or a new `attachments.ts` beside it):
      a mode dropdown, an extensions text field (space- or comma-separated) and
      a size field.
- [x] The group's description starts: "Beta: attachment publishing is new and
      may change."
- [x] Extensions help text: "HTML, JavaScript and other active files download
      instead of opening."
- [x] Mode help text: changing the mode gives affected notes a new revision on
      their next publish. Narrowing it or turning it off leaves files in the
      bucket while older revisions reference them (§5, P3 §2).
- [x] On Local profiles the group shows but is disabled, with the note
      "Attachments publish on AWS profiles only."
- [x] When the mode is first changed from `off`, show a notice: run **Publish
      all notes** once so existing notes pick up their attachments (§8).

## 3. Collecting references

The attachment list comes **only** from Obsidian's metadata cache. This is the
single source of truth for what uploads, what joins the note hash and what the
renderer may show.

While queuing a note (`NoteManager.queueNote`, `src/utils/notes.ts`), for AWS
profiles whose mode isn't `off`:

- [x] **Read.** `metadataCache.getFileCache(file)`. Take its `embeds`, and in
      `embedsAndLinks` mode also its `links`. Both cover wikilink and Markdown
      syntax. Frontmatter links (`frontmatterLinks`) are ignored.
- [x] **Resolve** each `link` with
      `metadataCache.getFirstLinkpathDest(getLinkpath(link), file.path)`.
      `getLinkpath` drops a `#page=3`-style fragment.
- [x] **Filter.** Keep it if it resolves to a `TFile` that:
  - is not Markdown,
  - has an allowed extension (case-insensitive), or the allow-list holds `*`,
  - is not under an excluded directory (P1 §2),
  - is within the size cap (`size` from the file's stat, below).
- [x] **Size notice.** A file that fails only the size cap is skipped. The batch
      shows one notice naming the skipped files ("2 attachments over 50 MB were
      not published: talk.mov, raw.wav").
- [x] **De-duplicate** by vault path. Hash each kept file (§6, hash cache) and
      attach the list to the note's state:

  ```ts
  interface AttachmentRef {
    vaultPath: string;   // for upload and notices only; never published
    sha256: string;      // hex, 64 chars
    fileName: string;    // basename, e.g. "song.mp3"
    ext: string;         // lowercase
    size: number;        // fs.stat size
    mtime: number;       // fs.stat mtimeMs (see §7, change detection)
    ctime: number;       // fs.stat ctimeMs (§6, hash cache)
    kind: 'image' | 'audio' | 'video' | 'file';
  }
  // NoteState gains: attachments: AttachmentRef[]
  ```

- [x] **One stat per file.** `size`, `mtime` and `ctime` all come from a single
      Node `fs.stat` on the file's full path (`FileSystemAdapter.getFullPath`),
      taken **before** hashing. Obsidian's `file.stat` is not used for these:
      it is cached and can lag a write made outside Obsidian, which is exactly
      the tag-editor case §6 guards against. The same stat feeds the size cap,
      the hash-cache key (§6), the pre-staging re-check and the re-check before
      upload (§7). Because the stat precedes the hash, a write during hashing
      leaves a stat that no longer matches the file, so the next check
      re-hashes instead of trusting a torn hash.
- [x] **Kind** comes from the extension: the default image, audio and video sets
      above, otherwise `file`. An extension the user adds to the allow-list is
      `file`.
- [x] If `getFileCache` returns null (the note isn't indexed yet), the list is
      empty. The note then publishes with every attachment link unpublished,
      which fails closed.
- [x] A note blocked by access resolution (`access.ok === false`) returns before
      this step, so its attachments are never collected or staged.
- [x] This step runs **before** the raw scrub and the hash in `queueNote`,
      because obscured `raw` (§4) needs each published file's hash.
- [x] The shared scrub helper used by `rebuildContentIndex` (P1 §4) collects the
      list the same way, using the hash cache, so the index can't drift from
      the published `raw`.

Links inside code blocks and inline code are ignored, because the metadata
cache already excludes them.

## 4. Rendering

### New built-in parser stage: `remark-attachments`

- [x] New scaffold `src/utils/parser/scaffolds/remark-attachments.ts`, stage
      `remark`, **order 38**: after `remark-block-ids` (35), before
      `remark-obsidian-links` (40). Registered in `scaffolds/index.ts`.
- [x] The plugin itself in `src/utils/remarkAttachments.ts`, exposed to vault
      stages as `libs.remarkAttachments`.
- [x] The scaffold's doc block states the contract with the site: the
      `data-cpn-attachment` attribute, `data-cpn-fragment` and the classes.

A separate stage, rather than more code in `remarkObsidianLinks`, keeps
existing vault overrides of `remark-obsidian-links` working unchanged.
Attachment references never reach that stage.

- [x] `ParserContext` (`src/utils/parser/types.ts`) gains:

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

- [x] `NoteManager.markdownToHtml` takes the note's `AttachmentRef[]` and builds
      `resolveAttachment` from it. It resolves the linkpath with
      `getFirstLinkpathDest`. If the target is a non-Markdown file, it returns
      `published: true` when the file is in the note's list, otherwise
      `published: false`. On Local profiles, and with the mode `off`, every
      vault file is `published: false`.

The renderer is therefore an allow-list: it can't show a file that won't be
uploaded. Once a file is in the list, **every** reference to it in the note
renders as an attachment. In `embeds` mode, a plain link to a file that is also
embedded becomes a working link, because the file is published anyway.

The stage handles:

- [x] **Wikilinks** in `text` nodes (`[[…]]` and `![[…]]`), parsed with the
      shared `parseWikilinkInner`. Matching text is split out of the text node.
      The rest of the text node, including any note wikilinks, stays for
      `remark-obsidian-links`.
- [x] **Markdown** `image` and `link` mdast nodes whose `url` is relative: no
      scheme (`/^[a-z][a-z0-9+.-]*:/i`), not starting with `#`, `/` or `//`.
      The URL is percent-decoded before lookup.
- [x] Inside a heading, embeds render as attachment links (as transclusions do:
      a heading can't hold media).

### Output

| Reference | Output |
|-----------|--------|
| embed, `image` | `<img class="cpn-attachment cpn-attachment-image" data-cpn-attachment="<key>" alt="…" loading="lazy">`. `\|300` sets `width`; `\|300x200` sets `width` and `height`. The same applies to Markdown `![alt\|300](pic.png)`. |
| embed, `audio` | `<audio class="cpn-attachment cpn-attachment-audio" controls preload="metadata" data-cpn-attachment="…"></audio>` |
| embed, `video` | `<video class="cpn-attachment cpn-attachment-video" controls preload="metadata" data-cpn-attachment="…"></video>`, sized as for images |
| embed, `file` (pdf, other) | `<a class="cpn-attachment cpn-attachment-file" data-cpn-attachment="…" target="_blank" rel="noopener">fileName</a>` |
| plain link (any kind) | `<a class="cpn-attachment cpn-attachment-file" data-cpn-attachment="…" target="_blank" rel="noopener">display text</a>` |
| `published: false` | `<span class="unpublished-link">display text</span>`, the same markup as today, built as an mdast node (below) |

- [x] `<key>` is `<sha256>/<fileName>`, HTML-attribute-escaped. File names can
      hold `"`, `<`, `&`, `#`, `?`, spaces and Unicode.
- [x] A `#page=N` fragment on a PDF link is kept as `data-cpn-fragment="page=N"`.
      The site appends it to the URL.
- [x] The HTML never contains an `src` or `href` for an attachment (see "Why no
      URL in the HTML" below).
- [x] **`alt`** for an image is the wikilink's alias (when it isn't a size
      alias) or the Markdown alt text without its size suffix, otherwise the
      file name.
- [x] **Display text** for links and unpublished spans is the alias when there
      is one (not a size alias), otherwise the file name. The HTML never shows
      the folder path.

`img`, `audio` and `video` are phrasing content, so they stay inside their
`<p>`. No block-mode retagging is needed; CSS makes audio and video
block-level.

Neither obscure setting changes the HTML: readers of the note see the file's
real name, as they see note titles. This holds for unpublished links too. As
with note links, an alias is the only way to keep a name out of the rendered
note.

### Escaping

- [x] Output elements are built as mdast nodes with `data.hName` and
      `data.hProperties` (as `noteLink` in `remarkObsidianLinks.ts` does), not
      as raw `html` strings, so hast escapes every attribute and every text
      child.
- [x] This includes the `published: false` span:
      `{ data: { hName: 'span', hProperties: { className: ['unpublished-link'] } }, children: [{ type: 'text', value }] }`.
- [x] `unpublishedSpan` in `remarkObsidianLinks.ts` switches to the same form,
      so unpublished note links get the same escaping. Today it builds a raw
      `html` node from unescaped text, so a file named `a&b.png` or `x<y.mp3`
      would break the markup. The HTML for names without `&`, `<` or `>` is
      unchanged.

### Why no URL in the HTML

A note with groups `[a, b]` is published byte for byte into both
`restricted/a/` and `restricted/b/` (`src/utils/access.ts`). A member of `b`
only can't fetch `restricted/a/…`. So the HTML can't name one area. The site
fills in the area it actually loaded the note from (§9).

### Behavior change with the mode `off`

Markdown links and images that resolve to vault files render as unpublished
spans instead of passing through as broken relative URLs. Wikilinks to vault
files show the file name rather than the folder path. External URLs and links
that don't resolve are untouched. This closes the HTML side of the leak phase 1
left open.

A note's hash doesn't change from this alone, but every publish that queues the
note re-uploads its current revision's JSON with the new HTML (§9, "Upgrade
note").

### Known limitations

- [x] Written into the scaffold doc block and `docs/parser-extensions.md`:

- **Mixed paragraphs.** A paragraph that mixes an attachment embed with a note
  embed (`![[pic.png]] ![[Note]]`) now has several children, so the note embed
  takes the inline transclusion path instead of the block one.
- **Raw HTML and reference-style links.** Notes keep their raw HTML
  (`allowDangerousHtml` in `remark-rehype` and `rehype-stringify`), and
  Obsidian's metadata cache doesn't index it. So `<img src="Media/x.png">`,
  `<audio src=…>` and `<a href=…>` that point at vault files are never
  collected, never published, and pass through as written, folder path
  included. Reference definitions (`[ref]: Media/a.pdf`, used by `![alt][ref]`
  and `[text][ref]`) are `definition` mdast nodes, which this stage doesn't
  visit, so they behave the same way. The docs recommend wikilinks or inline
  Markdown links for attachments.
- **Links Obsidian and remark read differently.** References come from
  Obsidian's metadata cache (§3), while rendering and the raw scrub use remark.
  A link Obsidian indexes that remark doesn't parse as one wikilink in one text
  node, or as one `image`/`link` node, is uploaded with the note but neither
  rendered nor obscured in `raw`, so its folder path stays in `raw`. Access is
  unaffected: the file goes only to the note's areas. Known cases: a wikilink
  holding emphasis markers (`![[my *draft* take.mp3]]`), which remark splits
  into several nodes.
- [x] Check whether Obsidian indexes a Markdown destination with a bare space
      (`![](Media/my pic.png)`), which CommonMark doesn't parse as an image. If
      it does, list it as a known case in the docs. *Checked on the sandbox
      in Obsidian: it isn't indexed, so the file never publishes and the
      text passes through as written, like raw HTML. Documented with the raw
      HTML limitation. `%20`-encoded destinations are indexed and publish.*

### Raw scrub: published targets

- [x] `NoteManager.rewriteRawWikilinks` passes
      `{ kind: 'file', sha256, ext }` with the file's hash when the file is in
      the note's attachment list, so published files get `<sha256>.<ext>`
      (P1 §4, Targets). Files not in the list keep `null.<ext>`.

## 5. Pinning

### Note hash

- [x] The content hash (`notes.ts`, `currentHash`) gains an attachment segment
      **only when the note has attachment references**, the way access groups
      and `cpn-style` are added:

  ```ts
  const att = [...new Set(refs.map(r => `${r.sha256}/${r.fileName}`))].sort();
  … + (att.length ? `::att=${att.join(',')}` : '')
  ```

As a result:

- **Notes without links to non-Markdown files keep their hashes.**
- **Notes with such links got a new hash once** in phase 1 when Obscure
  attachment names is on (the default), from the `raw` change.
- **Editing an attachment changes the hash of every note that references it.**
  The next publish that includes those notes records a new revision, and the old
  revision keeps pointing at the old bytes.
- **Turning the mode on, or widening it, changes the hashes of the affected
  notes**, so they republish with working attachments. Narrowing it, or turning
  it off, also gives them a new revision, without the files. The files stay in
  the bucket because older revisions still reference them (P3 §1).
- **Renaming the file** changes the note text and `fileName`, giving a new
  revision.
- A note hash always maps to the same attachment keys, because the keys are part
  of the hash whenever there are any.

### Note JSON

- [x] Each staged note JSON (`writeNoteToStaging`) gains, when non-empty:

  ```jsonc
  "attachments": [
    { "key": "<sha256>/song.mp3", "name": "song.mp3", "size": 1234567 }
  ]
  ```

- [x] Sorted by key. It is the same in every area copy and relative to the area,
      like the HTML.
- [x] Omitted when empty, so notes without attachments keep their JSON shape.

It is used by:

- the local-state rebuild (P3 §3), which makes the bucket recoverable without
  the plugin's local files;
- the diff notice (§9);
- a future attachment list in the note UI.

## 6. Local state

`attachments.json` and `staged-attachments.json` live in the profile directory
(`ProfileManager.getProfileDir`: `<configDir>/plugins/commonplace-notes/profiles/<profileId>/`),
next to `publish-history.json`. The hash cache is shared by all profiles and
lives one level up, in the plugin folder. See design.md, Assumptions, for how
these reach other machines.

- [x] New module `src/utils/attachmentState.ts` owns `attachments.json` and the
      hash cache.

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

- [x] `refs` entries are written in `commitPendingNotes`, next to the publish
      history. Revisions without attachments are omitted.
- [x] `uploaded` entries are added as uploads succeed (§7).
- [x] **Load or create at the start of every AWS publish** whose attachment mode
      isn't `off`, in the setup step beside `accessManager.load`, so **before**
      `commitPendingNotes` writes `refs` and before anything uploads. With the
      mode `off`, an existing file is still loaded, so the sweeps (P3 §2) can
      use it. The publish lock (§1) makes loading from disk here safe.
- [x] **Completeness on creation.** `complete` starts as `true` when either:
  1. the profile's publish history is empty, or
  2. a **bucket probe** finds no attachment objects: `ListObjectsV2` with
     `MaxKeys: 1` on `<s3Prefix>attachments/`, and on
     `<s3Prefix>restricted/<g>/attachments/` for each group prefix (listed with
     `Prefix: <s3Prefix>restricted/` and `Delimiter: '/'`). It uses the same
     `s3:ListBucket` permission as `hasRestrictedObjects`.

  Otherwise (attachments were already published from this or another machine,
  then the file was lost, or never synced here) it starts `false`.
- [x] **If the probe fails** (credentials, network), the file is still created,
      with `complete: false`. The publish continues and writes `refs` and
      `uploaded` into it.

Why it starts complete: a sweep can only wrongly delete an object that exists,
so a file that starts when the bucket holds no attachment objects can't miss
anything that matters. This covers every profile upgraded before attachments
were turned on, so they never need a rebuild. A rebuild (P3 §3) is needed only
when attachments already exist in the bucket and the local file doesn't.

Why a failed probe still creates the file: skipping it would lose the `refs`
that publish commits. A later probe could then find the bucket still empty,
because that publish's upload also failed or hadn't reached the attachments, and
mark a file missing those `refs` complete. A sweep could then delete a file that
a live revision uses. A failed probe therefore costs one rebuild, at the first
sweep or audit delete that needs the file.

The probe is used rather than a local "attachments were enabled" flag because a
local flag can't tell whether another machine has published attachments.

### Hash cache

Hashing a large file on every publish is wasteful. One cache serves every
profile, because a file's hash doesn't depend on the profile.

- [x] **Machine ID.** A random ID (`crypto.randomUUID()`) stored with
      `app.saveLocalStorage('cpn-machine-id', …)` and read with
      `app.loadLocalStorage`. Obsidian's local storage is per device and never
      synced.
- [x] **Raise `minAppVersion` to 1.8.7** in `manifest.json`, because
      `loadLocalStorage` and `saveLocalStorage` are `@since 1.8.7` and the
      plugin requires 1.7.2 today. `version-bump.mjs` then records 1.8.7 in
      `versions.json` for this release. The release notes say so (§11).
- [x] **File.** `<configDir>/plugins/commonplace-notes/attachment-hash-cache.<machineId>.json`
      (`manifest.dir`). Each machine reads and writes only its own file, so a
      synced plugin folder never makes two machines overwrite each other's
      cache, and `ctimeMs` (local to each machine) is only ever compared on the
      machine that recorded it. Other machines' files are ignored.

```jsonc
{ "<vaultPath>": { "size": 1234567, "mtime": 1763900000000, "ctime": 1763900000123, "sha256": "…" } }
```

- [x] **Re-hash** when `size`, `mtime` or `ctime` differ from the cached values.
      All three come from one `fs.stat`, taken before hashing (§3, "One stat per
      file").
- [x] `ctime` is Node's `fs.stat(fullPath).ctimeMs`, the inode change time,
      **not** Obsidian's `file.stat.ctime`, which is the creation time.
- [x] **Eviction on mismatch.** Any mismatch found at upload (§7) deletes the
      file's cache entry, so a stale entry can never cause a second failure.
- [x] **Streamed hashing.** `fs.createReadStream` on the adapter's full path
      (`FileSystemAdapter.getFullPath`) piped through Node's
      `crypto.createHash('sha256')`. The plugin is desktop-only and bundled for
      Node, and `src/utils/ssoLogin.ts` already uses `fs`. `vault.readBinary` and
      `crypto.subtle.digest` would need the whole file in memory.
- [x] **Rename and delete.** In `src/main.ts`, a vault `rename` or `delete`
      event drops the entry for the old path. A rename isn't carried over to the
      new path: renaming updates `ctimeMs` on macOS and Linux, so a moved entry
      would usually miss anyway, and dropping it costs at most one re-hash.

Why `ctime`: size and mtime alone aren't enough. Audio taggers (Mp3tag, Picard)
can keep a file's modification time, and ID3 padding usually keeps its size, so
a tag edit would otherwise reuse the old hash. The site would then keep serving
the old bytes, or every publish would fail the upload hash check. Every write
changes `ctimeMs`, and `utimes` can't set it back.

The cache only saves work, so losing it costs nothing but re-hashing.

### Staging: `staged-attachments.json`

Binary files are **not** copied into staging, which would double disk use for
large media. A profile-level `staged-attachments.json` lists what the staged
batch needs:

```jsonc
[ { "area": "", "key": "<sha256>/song.mp3", "vaultPath": "Media/song.mp3",
    "sha256": "…", "fileName": "song.mp3", "size": 1234567 } ]
```

- [x] It sits **beside** `staged-notes/`, not inside it, because
      `listStagedNoteUploads` treats every top-level `.json` in `staged-notes/`
      as a note.
- [x] Written by `commitPendingNotes`, one entry per (area, key) of each staged
      revision (§7, "Which areas get a file").
- [x] Entries are keyed by `area + key` and **merged** with any entries a failed
      earlier batch left. The next upload sends everything in staging, so the
      two must stay in step.
- [x] `cleanupStagedFiles` deletes it.
- [x] `handlePublishError` copies it into the error session directory with the
      staged notes, and keeps it (§1).

## 7. Upload

### Order within one publish

In `pushLocalJsonsToS3` (`src/publish/awsUpload.ts`), so no mapping ever points
at a missing object:

1. Membership sync.
2. **Attachments.** A failure stops the publish here, before any note JSON.
3. Note JSON.
4. Mappings.
5. Access transitions, then the orphan sweep (P3 §2).
6. Invalidation.

- [x] Add the attachment step between membership sync and note JSON.
- [x] **On any attachment failure, `pushLocalJsonsToS3` returns `false`**, as it
      does today when a note upload fails. It doesn't throw. `publishNotes`
      then shows "Publishing failed. Staged files preserved for retry.", keeps
      staging and doesn't run `handlePublishError`.

### Which areas get a file

A staged note revision's areas are its access areas (`partitionsFor`): public if
it has no groups, otherwise each `restricted/<group>/`. Each of its attachment
keys is ensured in each of those areas.

### Re-check before upload

- [x] At the start of the attachment step, every entry in
      `staged-attachments.json` is checked against the profile's **current**
      settings, and against the vault:
  - the vault file still exists at `vaultPath`;
  - it is not under an excluded directory (P1 §2);
  - its extension is still allowed and its size is within the cap;
  - the attachment mode is not `off`;
  - its bytes still match the entry's `sha256`, looked up in the hash cache
    (§6), which re-hashes only when size, mtime or `ctimeMs` changed.
- [x] Entries that fail any of the first four checks are **dropped**: they
      aren't uploaded, they're removed from `staged-attachments.json`, and
      they're logged to the console. The publish continues.
- [x] One notice covers the batch: "2 attachments weren't uploaded because
      they're now excluded, no longer allowed, or changed since they were
      staged: take1.wav, scan.pdf."

This closes the gap where entries left by a failed batch (§6) would upload after
the user excluded their folder. It also covers a settings change in the middle
of a publish.

**Hash mismatches** depend on which batch staged the entry. An entry belongs to
this batch when this publish's `commitPendingNotes` staged it or merged into it
(§6). The set is kept in memory for the length of the publish.

- [x] **This batch's entry:** the file changed after the pre-staging check
      (change detection, item 1, below). Delete its hash-cache entry and stop
      the publish before any upload, keeping staging, as for a mismatch at
      upload (item 2).
- [x] **An earlier batch's entry:** drop it with a console warning and name it
      in the notice above. Its revision shows "Attachment unavailable" (item 3).

On the next publish, an entry that stopped this one belongs to an earlier
batch, so it's dropped instead of stopping that publish too. Without this
check, a staged entry whose file had changed would reach the upload's own hash
check (item 2) on every publish and fail each one, and staging would never
clear.

The staged note JSON and `refs` still list the dropped keys. Those revisions
show "Attachment unavailable" for the file, and the audit (P3 §4) lists the keys
as "referenced, never uploaded". Republishing the note under the new settings
records a revision without them.

### Per (area, key)

```
<s3Prefix>attachments/<sha256>/<fileName>                  # public area
<s3Prefix>restricted/<group>/attachments/<sha256>/<fileName>
```

This runs only on entries that passed the re-check above.

- [x] **Step 1.** If `uploaded[area]` lists it, skip it.
- [x] **Step 2.** Otherwise, send a `HeadObject`. On 200, record it and skip it.
      This recovers a lost manifest. On 404 continue. A 403 also counts as
      missing, because without `s3:ListBucket` S3 reports a missing key as 403.
- [x] **Step 3.** Upload, hashing the bytes **as they are sent** (see change
      detection below), so the object can only ever hold bytes that match its
      key:
  - [x] Files up to 16 MB: read into memory, hash, compare, then one
        `PutObject`.
  - [x] Larger files: multipart, through `CreateMultipartUpload` /
        `UploadPart` / `CompleteMultipartUpload`. Parts are 8 MB, read in order
        from an `fs.promises.open` file handle and fed to the running hash, with
        up to 4 part uploads in flight. Before `CompleteMultipartUpload`, the
        final digest is compared with the key's hash. On a mismatch, or any
        other failure, call `AbortMultipartUpload`, so no object is created.
  - [x] **Checksums.** The bundled `@aws-sdk/client-s3` (3.744) adds a CRC32
        checksum to `PutObject` and `UploadPart` by default (since 3.729).
        Make the multipart path consistent with that, without changing the
        shared S3 client's defaults: pass `ChecksumAlgorithm: 'CRC32'` on
        `CreateMultipartUpload`, and give `CompleteMultipartUpload` each part's
        `ChecksumCRC32` from its `UploadPart` response, beside its `ETag` and
        `PartNumber`. The multipart end-to-end check (§10) confirms it against
        S3.
  - [x] Headers (below) are set on `PutObject` and on `CreateMultipartUpload`.
- [x] **Step 4.** Record it in `uploaded[area]`. Save `attachments.json` after
      the attachment step, including on failure, so finished uploads aren't
      repeated.
- [x] Uploads run with the existing `runWithConcurrency` (5) and a progress
      notice counting files.
- [x] Large (multipart) files also take one of **two** slots in a separate
      limiter, so at most two of them upload at once.

Peak memory is about 4 × 8 MB per large file in flight, whatever the file size.
With the limiter, peak upload memory is about 2 × 4 × 8 MB for large files plus
3 × 16 MB for small ones in the remaining slots, roughly 112 MB at worst.
Without it, five large files at once would hold about 160 MB. These commands are
already in the bundled `@aws-sdk/client-s3`, so there is **no new dependency**.

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

Every allowed file publishes. The headers only decide whether the browser
**shows** a file or **downloads** it. Anything a browser could run as a page at
the site's origin must download: same-origin script would run with the reader's
session cookie and could read their gated notes.

- [x] **`Content-Type`** comes from an extension map in a new pure module
      `src/utils/attachments.ts`. The map deliberately holds only **passive**
      types, which browsers display without running site code:

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
  | pdf | application/pdf | *(anything else)* | application/octet-stream |

- [x] **Active types are never mapped**, whatever the user allows: `html htm
      xhtml xht xml xsl xslt js mjs cjs wasm`, and any other type a browser can
      render as a document with script. They are served as
      `application/octet-stream`, the same as any unmapped extension. The unit
      tests pin this list, so adding a passive type to the map can't map one of
      these by accident.
- [x] **`Content-Disposition`**:
  - `inline; filename*=UTF-8''<percent-encoded name>` for mapped types except
    `svg`, so a PDF opens in the browser's viewer in the new tab, under its own
    name.
  - `attachment; filename*=UTF-8''…` for `svg` and for everything served as
    `application/octet-stream`, including every active type. A shared
    `page.html` or `script.js` downloads under its own name instead of opening.
    `<img>` ignores the header and renders SVG normally, while opening an SVG's
    URL directly downloads it instead of running any script it holds.
- [x] **`Cache-Control`**:

  | Area | Site | Value |
  |------|------|-------|
  | public | public site (`readGateMode` `none`) | `public, max-age=31536000, immutable` |
  | public | whole-site gate (`cognito`, `password`, `byo`) | `private, max-age=31536000, immutable` |
  | `restricted/<g>/` | any | `private, max-age=<session length in seconds>, immutable` |

The session length is `effectiveSessionHours(profile)` (P1 §1): the persisted
value, 12 h by default on new sites, or 1 h on a pool deployed before the
setting existed.
Notes in restricted areas use `private, no-store` (`RESTRICTED_CACHE_CONTROL`),
but re-downloading a 20 MB file on every play is not acceptable. The `private`
directive keeps shared caches out. The edge function runs on every viewer
request, before CloudFront's cache, so access is still checked on each request
that reaches CloudFront. A member removed from a group can replay only bytes
their own browser already holds, for at most one session length.

S3 and CloudFront already serve byte-range requests, which `<audio>` and
`<video>` seeking needs.

**Edge caching of `private` files.** The site's default behavior uses the
managed CachingOptimized policy (`full-stack-oac.ts`, `full-stack-oai.ts`),
whose minimum TTL is 1 second. With `private`, CloudFront caches an object for
only that minimum, so restricted and whole-site-gated media are fetched from S3
on almost every request, while each reader's browser cache still holds them for
the max-age. This is accepted for v1: S3-to-CloudFront transfer is free, and the
cost is S3 GETs and latency, not correctness. A dedicated `/*/attachments/*`
cache behavior could restore edge caching later. Because the edge function runs
before the cache, that change wouldn't weaken access control.

**No `X-Content-Type-Options: nosniff` (accepted for v1).** The site sends no
`nosniff` header today, and S3 can't set one on an object, because only system
metadata such as `Content-Type`, `Content-Disposition` and `Cache-Control` is
stored. The protection above doesn't rely on it: every active or unmapped type
is `application/octet-stream` with `attachment`, which browsers download without
sniffing, and current browsers don't sniff a declared `image/*`, `audio/*`,
`video/*` or `application/pdf` response into HTML. Adding `nosniff` for defense
in depth would take a CloudFront response headers policy on the site stacks.
That is a possible follow-up, not part of v1.

**Headers are fixed at upload.** A key never re-uploads (step 1), so changing
the site's read gate or the session length later doesn't change the headers on
files already in the bucket. Only new keys get the new values. A file uploaded
while the site was public keeps `public` after a whole-site gate is added. This
is accepted: the edge function still checks every request, and `public` only
lets intermediate caches store bytes that any reader could already fetch. The
docs say so.

### Change detection between queue and upload

A file can change while a publish is running:

- [x] **Item 1, before staging.** In `publishNotes`, after queuing and
      **before** the staging step's `frontmatterManager.process()` and
      `commitPendingNotes`, compare each pending note's refs against the file's
      current size, mtime and `ctimeMs`. If any differ, re-run `queueNote` for
      that note (which re-hashes). If it differs again on that second check,
      **abort without throwing**: call `discardQueued(profile.id)`, show
      "`song.mp3` is still changing. Publish again when it is saved.", and
      return. Nothing commits, staging from earlier batches stays as it was, and
      `handlePublishError` doesn't run. Any frontmatter queued this batch is
      written at the start of the next publish, as it is today after a failed
      run.
- [x] **Item 2, at upload.** If the hash of the bytes sent in step 3 above
      doesn't match (the multipart upload is aborted, or the `PutObject` never
      sent), delete the file's hash-cache entry (§6) and return `false` before
      any note JSON uploads, keeping staged files as other upload failures do:
      "`song.mp3` changed while publishing. Publish the notes that use it
      again."
- [x] **Item 3, the next publish.** History and mappings were already committed
      for the staged revision, and its bytes are gone from the vault. The
      re-check before upload (above) **drops** the staged entry, now an earlier
      batch's, because its vault file no longer matches its hash, and logs a
      console warning. Entries that fail the re-check's other checks are
      dropped the same way. Their notes still upload, and those revisions show
      "Attachment unavailable" for that file.

Republishing the note records a newer revision with the current bytes, which
becomes the live one. The dropped keys stay in `refs`, and the audit (P3 §4)
lists them as "referenced, never uploaded".

## 8. Publish updates

Editing a file doesn't touch the notes that reference it, so mtime-based scopes
would miss the change.

- [x] **Publish updates since last full publish** (`Publisher.getUpdatedNotes`):
      when the mode isn't `off`, also include every publishable note whose
      `metadataCache.resolvedLinks` reach an attachment file that passes the §3
      filters (an allowed extension, not under an excluded directory, within the
      size cap) and changed after `lastFullPublishTimestamp`.
- [x] A file has changed when the later of `mtimeMs` and `ctimeMs` from the
      file's `fs.stat` (§3, §6) is after that timestamp. This takes one
      `fs.stat` per linked attachment file.

mtime alone would miss a tag editor that keeps it (§6). `ctimeMs` also moves on
a rename, a permissions change or a sync tool's rewrite. Those re-queue the
note, but its hash doesn't change, so it records no new revision. Edits to
excluded files never re-queue notes. `resolvedLinks` doesn't separate embeds
from links (and includes frontmatter links), so `embeds` mode may include a note
that only links the file. Its hash doesn't change either.

**Publish active and connected notes** and **Publish current note** need no
change. They re-queue the note, and the hash check picks up the new bytes.

## 9. The site

Edit `infrastructure/assets/index/index.html` and run `npm run synth:site`.
Never hand-edit `src/publish/siteAssets.ts`.

### Area prefix

- [x] `fetchNoteJson(hash)` already tries each area in turn. It also returns the
      `prefix` it succeeded with (`''` or `restricted/<g>/`).
- [x] `loadNoteByParameter` and `fetchTranscludedNote` keep it on the note data
      (`noteData.areaPrefix`). The home note's `index.json` is public, so its
      prefix is `''`.

### Resolving attachment elements

- [x] A new `hydrateAttachments(root, prefix)` processes every
      `[data-cpn-attachment]:not([data-cpn-att])` element under `root`:
  - Build the URL `/<prefix>attachments/<sha256>/<encodeURIComponent(fileName)>`,
    plus `#<data-cpn-fragment>` if present.
  - `img`, `audio` and `video` get their `error` listener (below), then `src`.
    `a` gets `href` (it already has `target="_blank" rel="noopener"`).
  - Mark the element `data-cpn-att="1"` so a later pass skips it.
  - Everything is set through DOM properties, never `innerHTML`.

**Scoping**, so an embedded note's files resolve in that note's area, not the
host's. A public note can't embed a gated one (`linkVisibleFrom` renders it
unpublished), so the case that matters is a gated host embedding a public note:
the embedded note's files live under `attachments/`, not the host's
`restricted/<g>/attachments/`.

- [x] `createPanel` calls `hydrateAttachments(contentEl, noteData.areaPrefix)`
      **before** `hydrateTransclusions`, inside the same
      `!isError && !isDiff` check.
- [x] `hydrateOne` (transclusions) calls `hydrateAttachments` on the extracted
      nodes with the **embedded** note's prefix before inserting them.

Attachment links are not `a[href^="#"]`, so `bindNoteLinks` never intercepts or
clones them.

**Pinning and transclusions.** A transclusion always loads the embedded note's
**latest** revision (existing behavior, `fetchTranscludedNote` → `uid-to-hash`).
So an old permalink of the host note shows the embedded note's current
attachments, as it already shows the embedded note's current text. Pinning (§5)
covers a note's own attachments only.

### Unavailable and expired states

A media element's `error` event says nothing about why it failed: browsers
report a 401, a 403, a 404 and an unplayable codec alike, mostly as
`MEDIA_ERR_SRC_NOT_SUPPORTED`. So the handler asks the server once.

- [x] `img`, `audio` and `video` listen for `error`. The handler sends one `HEAD`
      request for the element's URL (`cache: 'no-store'`), with no retry loop,
      and picks the label from its status. Each label is a small inline element
      after the media, which also gets a `cpn-attachment-unavailable` class.

| `HEAD` result | Meaning | Label |
|---------------|---------|-------|
| **401** | The session expired on a whole-site Cognito or password gate. Both edge functions answer a signed-out data request with 401 and `x-cpn-auth: required`. | "Your session has ended. **Sign in again** to play this." The link reloads the page, as `cpnAuthGate` does, so the edge serves the sign-in redirect or the unlock page as the document. |
| **403** on a `restricted/<g>/` URL | Signed out on a public site with access groups (the edge answers 403 there, never 401), or signed in without membership. The handler fetches `/restricted/whoami` (`cache: 'no-store'`) to tell them apart. | If `signedIn` is false: "**Sign in again** to play this", with the existing sign-in link (`hostedUiLoginUrl`). Otherwise "Attachment unavailable". |
| **2xx** on `audio` or `video` | The file is there but this browser can't decode it, such as HEVC in a `.mov` on Chrome or Firefox. | "This browser can't play this file", with a **Download** link to the same URL. |
| anything else | A missing object (behind OAC a missing key is 403, because the site stacks define no custom error responses, so 403 and 404 look the same), a 2xx on `img` (a corrupt image), or a network failure. | "Attachment unavailable" |

- [x] The 401 case never reloads on its own: a media error mustn't take the
      page away from a reader mid-note. Reading on, the next note fetch reaches
      `cpnAuthGate` as it does today.
- [x] The 401 case doesn't go through `getMyIdentity`, which caches its result
      and would itself reload on a 401.
- [x] This covers a session that expires during a long recording (P1 §1).

Links can't detect failure. A new tab for a missing or forbidden file shows the
raw response: S3's error, or the edge's `{"error":"cpn_forbidden"}` on a
public-reads site when signed out. On a whole-site gate, a signed-out new tab is
a navigation, so the edge redirects to sign-in and back to the file. This is the
accepted v1 behavior.

### Diff panel

Attachments get no diff of their own.

- [x] **Hashes become names first.** With Obscure attachment names on (the
      default), new bytes change `raw` (`![[3fa9….mp3]]` → `![[77ab….mp3]]`), so
      comparing `raw` directly would show a hash swap rather than "the text is
      identical". Before comparing, `buildDiff` rewrites each revision's `raw`
      with **its own** `attachments` list:
  - every `<sha256>.<ext>` becomes that entry's `name`;
  - a bare `<sha256>` (a file without an extension) is replaced too, after the
    dotted forms;
  - if one hash has several names in a list (identical bytes under two names),
    the first by key is used;
  - `null.<ext>` targets, and revisions without a list, are left as they are.

  Each key's hash is 64 hex characters, so a plain string replace of the listed
  hashes can't hit other text. Readers already see these names in the rendered
  note (§4), so nothing new is shown. The diff, and the identical-text check
  below, use the rewritten text.
- [x] Then compare the two revisions' `attachments` lists by key:
  - If the rewritten `raw` differs and the lists differ, show a notice above the
    diff: "Attachments changed: song.mp3, cover.png."
  - If the rewritten `raw` is identical and the lists differ, replace "No
    differences between these two versions." with "The text is identical.
    Attachments changed: song.mp3."

### CSS

Both light and dark themes:

- [x] `.cpn-attachment-image`: `max-width: 100%; height: auto`.
- [x] `.cpn-attachment-audio`: `display: block; width: 100%; margin: .5em 0`.
- [x] `.cpn-attachment-video`: `display: block; max-width: 100%; height: auto`.
- [x] `.cpn-attachment-file`: an "opens in a new tab" icon after the text.
- [x] `.cpn-attachment-unavailable`: muted, with a small inline label.

### Upgrade note

Every publish re-stages and re-uploads each note it queues
(`commitPendingNotes` writes staging for every queued note), under the same
`notes/<hash>.json` key when the hash didn't change. So:

- A note whose files now publish gets a new hash (§5) and a new revision on its
  next publish.
- Any other note gets the new HTML (for example, unpublished spans showing file
  names, §4) on the next publish that includes it. **Publish all notes**
  refreshes every note's current revision. Because the key is unchanged, readers
  see it once the profile's CloudFront invalidation scheme invalidates, or the
  cached copy expires.
- Old revisions (permalinks) that aren't re-queued keep their old HTML.
- The site assets are re-pushed on the next publish through the existing
  fingerprint check.

## 10. Tests

### `test-publish-lock.ts` (new)

- [x] A second `withProfileLock` on the same profile while the first runs
      returns `{ ran: false, heldBy }` and doesn't run its function.
- [x] Different profiles run concurrently.
- [x] The lock is released when the function throws.
- [x] Two publishes started together: the second is refused, and the first's
      `refs` are all in `attachments.json` afterwards.
- [x] The delete picker during a publish is refused.

### `test-attachments.ts` (new)

For `src/utils/attachments.ts`:

- [x] Reference filtering: mode, extensions, `*`, files without an extension,
      user-added types such as `html` and `canvas`, excluded directories, size.
- [x] Kind and MIME/disposition maps, RFC 5987 file names.
- [x] Every active type (`html`, `js`, `xml`, `wasm`, …) maps to
      `application/octet-stream` with `attachment`, even when allowed, and `svg`
      gets `attachment`.
- [x] Key encoding for odd file names: spaces, `#`, `?`, `%`, `"`, Unicode.
- [x] The `::att=` segment is order-independent, de-duplicated, and absent when
      there are no refs.
- [x] Staged-entry merge across a failed batch.
- [x] Re-check before upload: a staged entry from a failed batch whose folder
      was excluded afterwards is dropped, and so are entries whose extension
      was removed from the allow-list, entries over a lowered cap, entries under
      the mode `off`, and entries whose file was moved or deleted. Entries that
      still pass are kept.
- [x] Re-check hash check: an earlier batch's entry whose file changed is
      dropped and the publish continues. This batch's entry whose file changed
      stops the publish with staging kept, and on the next publish the same
      entry is dropped rather than stopping it again. An entry from an earlier
      batch that this batch merged into counts as this batch's.
- [x] The updated-since rule (§8): a file whose mtime is before
      `lastFullPublishTimestamp` but whose `ctimeMs` is after it counts as
      changed.
- [x] The large-file limiter: with five large files queued, no more than two are
      mid-upload at once.

### `test-attachment-state.ts` (new)

- [x] Completeness on creation: `true` with an empty history.
- [x] `true` with a non-empty history when the probe finds no attachment objects
      (public or any group).
- [x] `false` when the probe finds one in any area.
- [x] When the probe fails, the file is still created, with `complete: false`.
      It keeps the `refs` that publish commits, and a later probe of an empty
      bucket doesn't turn it `true`.
- [x] The file exists before `commitPendingNotes` runs.
- [x] Hash cache hit and miss on size, mtime and `ctime`: a rewrite that keeps
      size and restores mtime with `utimes` still misses.
- [x] Eviction on an upload mismatch.
- [x] Rename and delete both drop the old path's entry.
- [x] A write during hashing: the stat taken first no longer matches, so the
      next check re-hashes.
- [x] A streamed hash matches `crypto.subtle.digest` on the same bytes.
- [x] Two machine IDs use two cache files, and neither reads the other's.

### Publish error handling

- [x] After a batch fails at upload (staged and committed), a second publish
      that throws while staging (e.g. `uidConflicts`) leaves the first batch's
      staged note JSON and `staged-attachments.json` in place, and the next
      successful publish uploads them.
- [x] An attachment upload failure returns `false`, keeps staging and doesn't
      run `handlePublishError`.
- [x] The "still changing" abort leaves staging untouched and commits nothing.
- [x] `lastFullPublishTimestamp` is the publish's start time.

### `test-obscure-wikilinks.ts` (extended)

- [x] Published targets become `<sha256>.<ext>`, unpublished ones stay
      `null.<ext>`, and files without an extension `<sha256>` / `null`.
- [x] A plain link to a file the note also embeds gets `<sha256>.<ext>` in
      `embeds` mode.

### Parser

- [x] Cases for `remark-attachments`: each output row in §4, headings, size
      aliases, `alt` from alias, alt text and file name, mixed paragraphs,
      escaping, `published: false`.
- [x] Unpublished file and note links whose names hold `&`, `<` or `>` (escaped
      in the span's text).
- [x] Re-capture `e2e/fixtures/parser-golden.json`, reviewing every diff.
      Expected diffs are only attachment links, and unpublished links whose
      text holds `&`, `<` or `>`.

### Site

In the style of `test-transclusions-runtime.ts`:

- [x] `hydrateAttachments` URL building and encoding.
- [x] Embedded-note scoping.
- [x] Each `HEAD` branch of the error handler: 401 on a whole-site Cognito gate
      and on a password gate (sign-in label, no automatic reload); 403 on a
      restricted URL with whoami `signedIn: false` (sign-in link) and `true`
      (unavailable); 403 on a public URL (unavailable); 404; a 2xx for `audio`
      and `video` (can't play, with Download) and for `img` (unavailable); a
      network failure (unavailable).
- [x] The diff's hash-to-name rewriting: dotted and bare hashes, one hash under
      two names, `null.<ext>` and missing lists left alone.
- [x] A bytes-only change with Obscure attachment names on reports "The text is
      identical", plus the notice wording.

### End-to-end (sandbox `random` only)

- [x] Embed an mp3 in a public note and publish. The player loads from
      `attachments/` and can seek (range requests).
- [x] Replace the mp3's bytes and publish updates. The note gets a new revision
      and the new audio. The old permalink still plays the old audio. The diff
      says "The text is identical. Attachments changed: …".
- [x] Use a note with two groups. A member of only the second group can play it.
- [x] Embed a public note that has attachments into a gated note. A group member
      sees the embedded files load from `attachments/`, not from the host's
      `restricted/<g>/attachments/`.
- [x] A PDF embed and a plain `[[file.pdf]]` link open in a new tab with the
      browser's viewer and the file's own name. An `svg` opened directly
      downloads. With `html` and `js` added to the allow-list, `[[page.html]]`
      and `[[script.js]]` publish, and opening them downloads the file instead
      of running it.
- [x] With the mode `off`, no attachment objects are written, and attachment
      links render as unpublished spans showing the file name.
- [x] With `**/private/` excluded, a note embedding `Projects/private/a.mp3` and
      `Media/b.mp3` publishes `b.mp3` only. `a.mp3` renders as an unpublished
      span, is `null.mp3` in `raw`, and no object exists for it in any area.
- [x] Make a publish fail at its first upload, before any attachment is sent
      (e.g. credentials without `s3:PutObject`), so the batch stays staged.
      Restore the credentials, add the attachment's folder to Excluded
      directories, and publish again. The file isn't uploaded, the notice names
      it, and the note shows "Attachment unavailable".
- [x] Upload a file over 16 MB (multipart). `CompleteMultipartUpload` accepts
      the CRC32 part checksums, the file plays, and no incomplete multipart
      upload remains (`ListMultipartUploads`).
- [x] On a whole-site Cognito gate, open a note with an mp3, clear the `cpn_id`
      cookie and press play. The sign-in label shows, the page doesn't reload
      by itself, and the link leads through sign-in back to the note. On a
      public site with access groups, the same steps on a gated note show the
      sign-in link.
- [x] Upload one near the cap and watch Obsidian's memory: it stays near the
      in-flight parts, not the file size.
- [x] Overwrite a large file while it uploads: the multipart upload is aborted,
      no object exists under its key, and the publish stops with the "changed
      while publishing" notice.
- [x] Edit an mp3's tags with a tool that keeps size and mtime, and publish
      updates for the note: it records a new revision and plays the new bytes.
- [x] Start **Publish all notes**, then **Publish current note** for the same
      profile before it finishes: the second is refused with the busy notice.

## 11. Docs and release

- [x] `docs/publishing-model.md`: replace the "attachments aren't published"
      limitation, marking attachment publishing as **Beta**. Cover pinning,
      access areas, the publish lock, the one-publishing-machine assumption and
      the known limitations (§4).
- [x] `docs/settings.md`: the **Attachments (Beta)** group, the allow-list and
      active types, the size cap, and the **Publish all notes** advice.
- [x] `docs/parser-extensions.md`: the `remark-attachments` stage, its order,
      `resolveAttachment`, and the site contract.
- [x] `docs/auth-and-access.md`: attachment access per area, private caching for
      one session length, headers fixed at upload.
- [x] The S3 permissions publishing now uses: `s3:GetObject` for HEAD,
      `s3:ListBucket` for the completeness probe, `s3:AbortMultipartUpload`.
- [ ] Release notes (with phase 3): "Attachments (Beta)", off by default. The
      release requires Obsidian 1.8.7 or later (§6, Machine ID).

## Done when

- [ ] Every box in §1–§11 is ticked.
- [ ] Phase 3 is done too, because they ship together.
- [x] `npm run build`, `npm run synth:site` and all unit tests pass, and the
      parser golden file is re-captured and reviewed.
- [x] The end-to-end checks in §10 pass on the sandbox site.
