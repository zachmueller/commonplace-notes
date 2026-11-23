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
| File types | **No type is ever refused.** The allow-list is the user's to widen, and `*` allows every extension. Types that could run code at the site's origin (HTML, JavaScript, XML, SVG opened directly, …) are still published, but served as downloads (§6). |
| Public exposure | A file becomes public as soon as **any** public note references it. That note shows it to everyone anyway. |
| Source of a note's attachment list | **Obsidian's metadata cache only** (§2). The renderer never adds to it; it only renders what the list contains. |
| Reader experience | **Embeds play inline, everything else opens in a new tab.** `![[image]]`, `![[audio]]` and `![[video]]` render in the note. PDF and other embeds, and every plain link, open the file in a new browser tab. |
| Attachment list in note JSON | **Yes.** Each published note JSON lists its attachment keys (§4). |
| Diffing attachments | **No.** Attachments get no diff link or diff view. The note diff shows file names in place of content hashes and says when attachments changed (§8). |
| Raw Markdown | A separate **Obscure attachment names** setting (default on) replaces every link to a non-Markdown vault file in the published `raw` with the file's content hash, or `null` when it didn't publish, in both wikilink and Markdown syntax, whatever the attachment mode. Like **Obscure wikilinks**, it affects only `raw` and what is built from it. It hides folder paths, not file names: as with note titles, the rendered note shows a file's name unless the author wrote an alias. New note hashes from this are accepted (§3). |
| Excluded directories | Entries match **from the vault root**: `private/` excludes only the top-level `private` folder. `*` matches within one folder name and `**` matches any depth, so `**/private/` excludes a `private` folder anywhere. This applies to notes and attachments alike. Existing entries keep their text. A one-time upgrade appends patterns so every folder the old rule excluded stays excluded, and a notice says what it added (§1). |
| Large files | **Streamed from disk** with Node's `fs` (the plugin is desktop-only) for hashing and multipart upload, so memory use doesn't grow with file size (§5, §6). |
| File excluded after staging | Every staged attachment is re-checked against the current exclusion rules, allow-list and size cap just before upload. Files that now fail are dropped, not uploaded (§6). |
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
  /** Lowercase extensions without the dot. `*` allows every extension. */
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

The default list only sets what publishes out of the box. **There is no
deny-list.** The user can add any extension: `html`, `js`, `zip`, `canvas`,
`base`, anything. The entry `*` allows every extension, including files that
have none. The settings field accepts any entry.

The only distinction kept is between notes and files. A link to a Markdown file
resolves to a note and publishes through `cpn-publish-contexts`, never as an
attachment (§2). This is the existing note pipeline, not a file-type rule.

Sharing a type doesn't mean the site renders it. Types that could run code at
the site's origin, if opened directly, are served as downloads (§6, Headers).
The settings help text says so: "HTML, JavaScript and other active files
download instead of opening."

**Default cap:** 50 MB. The field accepts 1–500. Files are streamed from disk
for hashing and upload (§5, §6), so the ceiling bounds upload time and storage,
not memory.

The profile's **Excluded directories** apply to attachments too
(`Publisher.isFileExcluded`, with the matching rules below). A file under an
excluded folder never publishes, whichever note links it.

### Obscure attachment names

A new profile field beside `obscureRawWikilinks`:

```ts
obscureRawAttachments?: boolean; // absent ≡ true
```

It is a top-level profile field rather than part of `AttachmentSettings`,
because it applies whatever the attachment mode, including `off`, and on Local
profiles too. Like `obscureRawWikilinks`, it is filled in as `true` on load when
missing (`src/main.ts`, beside the existing default). §3 describes its effect.

**UI:** a toggle directly below **Obscure wikilinks in published Markdown** in
the content settings: "Obscure attachment names in published Markdown. Replace
links to images, audio and other files in the published raw Markdown with the
file's content hash (e.g. `![[Media/song.mp3]]` → `![[3fa9….mp3]]`), so folder
paths stay private. As with note titles, the rendered note still shows a file's
name unless the link has an alias. Rendered HTML and search are unaffected."

The setting matches **Obscure wikilinks** in scope: it hides where a file lives
in the vault, not what it is called. Readers see the file name wherever the
author didn't write an alias, and a published file's name is also part of its
key and URL (§6).

### Excluded directories: matching rules

Today's check (`filePath.startsWith(dir) || filePath.includes('/' + dir + '/')`)
does raw string matching. With the documented `private/` form, the second clause
looks for `/private//` and never matches. Without the slash, `private` also
matches `privateer/` and `private.md`. An entry with a trailing space matches
nothing. Attachments rely on this check, so the rules are redefined.

**Rules:**

1. Each line is a folder pattern relative to the vault root. Lines are trimmed,
   and empty lines are ignored. A leading `/` or `./` and a trailing `/` are
   optional: `private`, `/private` and `private/` mean the same thing.
2. A pattern is a sequence of `/`-separated segments, matched against **whole
   folder names**. `private` never matches `privateer`.
3. A pattern without wildcards names one folder from the vault root:
   `private/` excludes `private/…` and nothing else, and `Projects/private/`
   excludes only `Projects/private/…`.
4. `*` within a segment matches any run of characters except `/`, including
   none: `*-private/` matches `work-private/`, and `Projects/*/drafts/` matches
   `Projects/alpha/drafts/`.
5. A segment that is exactly `**` matches zero or more folders: `**/private/`
   matches `private/`, `a/private/` and `a/b/private/`. `Archive/**/raw/`
   matches `Archive/raw/` and `Archive/2024/05/raw/`. A `**` inside a longer
   segment (`a**b`) is treated as `*`.
6. Matching is **case-insensitive**, so `Private/` still excludes `private/` on
   the case-insensitive file systems macOS and Windows use. This can only
   exclude more, which is the safe direction.
7. Other characters (`?`, `[`, `{`, `\`) are literal. There is no escaping and
   no negation.
8. Patterns match folders, never file names. A file is excluded when **any of
   its ancestor folders** matches a pattern in full: a pattern matching
   `Projects/private` excludes `Projects/private/2024/x.mp3`. A pattern such as
   `**/*.wav` matches only a folder named like that, not `.wav` files.

The matcher is a pure function in a new `src/utils/excludedDirectories.ts`
(`compileExcludePatterns(lines) → (path) => boolean`). `Publisher.isFileExcluded`
delegates to it, so notes (`getAllPublishableNotes`, `getConnectedNotes`,
`publishSingle`, `publishConnected`, the audit, the file-tree indicators) and
attachments share one implementation.

**Settings help text:** "One folder per line, from the vault root. `private/`
excludes only the top-level private folder. Use `*` for any folder name and
`**/` for any depth, e.g. `**/private/` excludes every folder named private."

**Upgrade (one time, per profile).** Existing entries are kept as typed and
take the new meaning. Entries without a trailing slash used to match at any
depth (`filePath.includes('/' + dir + '/')`) and by prefix
(`filePath.startsWith(dir)`), which the new rules read more narrowly. Users are
told to run **Publish all notes** right after turning attachments on (below),
which is exactly when a note the old rule excluded would go live. So the
upgrade keeps those folders excluded rather than only warning. On the first
load after upgrading:

1. For each profile, for every entry that, once trimmed, doesn't end in `/`,
   append the patterns that reproduce the old rule's folder matches:
   `**/<entry>/` (any depth) and `<entry>*/` (prefix), skipping any already in
   the list. This runs per entry, not per affected file, so a matching folder
   created later is still excluded. `private` gains `**/private/` and
   `private*/`, and `Projects/private` gains `**/Projects/private/` and
   `Projects/private*/`. Entries ending in `/` meant the same thing under both
   rules and gain nothing, so the default `private/` is unchanged.
2. Compare the old rule against the new list over every vault file, not only
   Markdown. What remains are files the old rule matched only by their own name
   (`private.md` at the root, from the entry `private`), which no folder
   pattern can express.
3. If step 1 added anything or step 2 found anything, show a persistent notice
   per profile: "Excluded directories now match from the vault root. In
   `<profile>`, added `**/private/` and `private*/` so the same folders stay
   excluded. Open settings". Files from step 2 are listed (up to five, then
   "and N more") with "No longer excluded. Move it into an excluded folder."
   The full file list goes to the console.
4. Record `excludedDirsRulesVersion: 2` on the profile, whether or not anything
   changed, so the upgrade runs once.

The added lines only ever exclude more. The upgrade doesn't edit or remove the
user's own entries, and it doesn't block publishing. Profiles created after the
upgrade start at version 2 and skip it.

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
   - has an allowed extension (case-insensitive), or the allow-list holds `*`,
   - is not under an excluded directory (§1, matching rules),
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

This step runs **before** the raw scrub and the hash in `queueNote`, because
obscured `raw` (§3) needs each published file's hash.

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

**Display text:** the alias when there is one (not a size alias), otherwise the
file name. The HTML never shows the folder path. Neither obscure setting changes
the HTML: readers of the note see the file's real name, as they see note titles.
This holds for unpublished links too. As with note links, an alias is the only
way to keep a name out of the rendered note.

The output elements are built as mdast nodes with `data.hName` and
`data.hProperties` (as `noteLink` in `remarkObsidianLinks.ts` does), not as raw
`html` strings, so hast escapes every attribute.

**Why no URL in the HTML:** a note with groups `[a, b]` is published byte for
byte into both `restricted/a/` and `restricted/b/` (`src/utils/access.ts`). A
member of `b` only can't fetch `restricted/a/…`. So the HTML can't name one
area. The site fills in the area it actually loaded the note from (§8).

**Behavior change with the mode `off`:** Markdown links and images that resolve
to vault files render as unpublished spans instead of passing through as broken
relative URLs. Wikilinks to vault files show the file name rather than the
folder path. External URLs and links that don't resolve are untouched.

The scaffold's doc block states the contract with the site: the
`data-cpn-attachment` attribute and the classes.

### Raw Markdown

**Obscure attachment names** (`obscureRawAttachments`, §1, default on) does for
file links what **Obscure wikilinks** does for note links: it replaces the link
target in the published `raw` with an opaque ID. It applies to every link that
resolves to a non-Markdown vault file, **whatever the attachment mode**, and is
independent of `obscureRawWikilinks`.

The new target is:

- `<sha256>.<ext>` when the file is in the note's attachment list (§2), so it
  is published. `<sha256>` is the file's full hash, matching the `key` in the
  note JSON's `attachments` (§4), so a raw consumer can map it to the file.
- `null.<ext>` when it isn't: excluded, over the size cap, not on the
  allow-list, a plain link in `embeds` mode, the mode `off`, or a Local profile.
  This mirrors the `null` used for unpublishable note links, but keeps the
  extension so the link still reads as media.
- For a file without an extension, `<sha256>` or `null`.

| Written | Published `raw` (setting on) |
|---------|------------------------------|
| `![[Media/2024/song.mp3]]` | `![[3fa9….mp3]]` |
| `![[Media/pic.png\|300]]` | `![[81be….png\|300]]` |
| `[[Docs/slides.pdf#page=3\|deck]]` | `[[c044….pdf#page=3\|deck]]` |
| `[[Docs/slides.pdf]]` | `[[c044….pdf]]` |
| `![[private/scan.pdf]]` (excluded) | `![[null.pdf]]` |
| `[[private/scan.pdf\|my scan]]` (excluded) | `[[null.pdf\|my scan]]` |
| `![](Media/2024/my%20pic.png)` | `![](9d12….png)` |
| `![alt\|300](<Media/my pic.png>)` | `![alt\|300](9d12….png)` |
| `[notes](Docs/a.pdf)` | `[notes](e7a0….pdf)` |

(`3fa9…` stands for the full 64-character hash.)

- **Aliases, alt text and link text are kept**, as wikilink aliases are. Unlike
  note links, an attachment link with no alias **never falls back to its path**
  as display text, because that would bring the file name back.
- **Known limitation:** text the author wrote is kept as written, even when it
  repeats the file name (`[song.mp3](Media/song.mp3)` → `[song.mp3](3fa9….mp3)`).
  This matches how a wikilink alias that repeats a note's title is kept.
- The fragment (`#page=3`) and the embed `!` are kept.
- Wikilinks: the scrubber callback (`scrubRawWikilinks` in
  `src/utils/rewriteRawWikilinks.ts`) becomes
  `resolveTarget(path) => { kind: 'note', uid: string | null } | { kind: 'file', sha256: string | null, ext: string } | null`,
  and the scrubber takes `{ notes: boolean, attachments: boolean }` from the two
  settings. Note targets behave exactly as today when `notes` is on and are left
  alone when it's off. File targets are rewritten when `attachments` is on and
  left as written when it's off.
- Markdown links: the same pass visits `image` and `link` nodes. A relative URL
  that resolves to a non-Markdown vault file has its destination replaced by the
  new target. A `<…>` destination drops its brackets, since the target has no
  spaces. It is spliced by source offset, as for wikilinks.
- Unresolved targets and external URLs are left as today.
- `queueNote` runs the scrub when **either** setting is on (today:
  `obscureRawWikilinks` only).
- The content-index and chat-corpus rebuild in `src/main.ts` (beside its
  "Mirror the scrub applied in queueNote" comment) runs the same scrub outside
  a publish. It must collect the note's attachment list the same way (§2),
  using the hash cache, or the index would drift from the published `raw`.
  Both call sites share one helper.
- Today, with Obscure wikilinks on, a wikilink to a vault file becomes
  `[[null|Media/song.mp3]]`, because the scrubber falls back to the path as
  display text. The folder path is therefore already published. This setting
  closes that leak.

With the setting on, neither the folder path nor the file name appears in `raw`,
or in anything built from it (the content index, the chat corpus). The HTML, the
note JSON's `attachments` list and the attachment URLs keep the file name (§4,
§6). The setting keeps folder paths private, not file names. With it off,
attachment links in `raw` stay exactly as written, including the folder path, as
note links do with **Obscure wikilinks** off.

Notes with attachment links get new hashes once, and republish, on the first
publish after upgrading. Toggling the setting does the same. That is accepted:
what they publish changes.

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
- **Notes with such links get a new hash once** when Obscure attachment names
  is on (the default), from the `raw` change in §3.
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
- **Completeness.** Any orphan deletion (§9) and the audit's delete offer first
  run a **rebuild** when `complete` is `false`. Without this, a fresh file
  holding only new revisions would look authoritative and could delete files
  that older live revisions still use.
- **Starting complete.** A sweep can only wrongly delete an object that exists,
  so a file that starts when the bucket holds no attachment objects can't
  miss anything that matters. The file is created the first time a publish
  or a sweep loads it, **before** that publish uploads anything. `complete`
  starts as `true` when either:
  1. the profile's publish history is empty, or
  2. a **bucket probe** finds no attachment objects: `ListObjectsV2` with
     `MaxKeys: 1` on `<s3Prefix>attachments/`, and on
     `<s3Prefix>restricted/<g>/attachments/` for each group prefix (listed
     with `Prefix: <s3Prefix>restricted/` and `Delimiter: '/'`). It uses the
     same `s3:ListBucket` permission as `hasRestrictedObjects`.

  Otherwise (attachments were already published from this or another
  machine, then the file was lost, or never synced here) it starts `false`.
  This covers every profile upgraded before attachments were turned on, so
  they never need a rebuild. A rebuild is needed only when attachments
  already exist in the bucket and the local file doesn't. If the probe fails
  (credentials, network), the file isn't created. The publish continues, and
  the next load probes again. A sweep in that publish is skipped as when a
  rebuild fails (§9).

  The probe is used rather than a local "attachments were enabled" flag
  because a local flag can't tell whether another machine has published
  attachments.
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

Re-hash only when `size` or `mtime` differ from the cached values. Hashing
streams the file: `fs.createReadStream` on the adapter's full path
(`FileSystemAdapter.getFullPath`) piped through Node's
`crypto.createHash('sha256')`. The plugin is desktop-only and bundled for Node,
and `src/utils/ssoLogin.ts` already uses `fs`. `vault.readBinary` and
`crypto.subtle.digest` would need the whole file in memory. In `src/main.ts`, a vault
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

### Re-check before upload

At the start of the attachment step, every entry in `staged-attachments.json`
is checked against the profile's **current** settings, and against the vault:

- the vault file still exists at `vaultPath`;
- it is not under an excluded directory (§1, matching rules);
- its extension is still allowed and its size is within the cap;
- the attachment mode is not `off`.

Entries that fail are **dropped**: they aren't uploaded, they're removed from
`staged-attachments.json`, and they're logged to the console. One notice covers
the batch: "2 attachments weren't uploaded because they're now excluded or no
longer allowed: take1.wav, scan.pdf." The publish continues. This closes the gap
where entries left by a failed batch (§5) would upload after the user excluded
their folder. It also covers a settings change in the middle of a publish.

The staged note JSON and `refs` still list the dropped keys. Those revisions show
"Attachment unavailable" for the file, and the audit lists the keys as
"referenced, never uploaded". Republishing the note under the new settings
records a revision without them.

### Per (area, key)

```
<s3Prefix>attachments/<sha256>/<fileName>                  # public area
<s3Prefix>restricted/<group>/attachments/<sha256>/<fileName>
```

This runs only on entries that passed the re-check above.

1. If `uploaded[area]` lists it, skip it.
2. Otherwise, send a `HeadObject`. On 200, record it and skip it. This recovers
   a lost manifest. On 404 continue. A 403 also counts as missing, because
   without `s3:ListBucket` S3 reports a missing key as 403.
3. Upload, hashing the bytes **as they are sent** (see change detection
   below), so the object can only ever hold bytes that match its key:
   - Files up to 16 MB: read into memory, hash, compare, then one `PutObject`.
   - Larger files: multipart, through `CreateMultipartUpload` / `UploadPart` /
     `CompleteMultipartUpload`. Parts are 8 MB, read in order from an
     `fs.promises.open` file handle and fed to the running hash, with up to 4
     part uploads in flight. Before `CompleteMultipartUpload`, the final digest
     is compared with the key's hash. On a mismatch, or any other failure, call
     `AbortMultipartUpload`, so no object is created.

   Peak memory is about 4 × 8 MB per large file in flight, whatever the file
   size. These commands are already in the bundled `@aws-sdk/client-s3`, so
   there is **no new dependency** (this settles the former
   `@aws-sdk/lib-storage` question).
4. Record it in `uploaded[area]`. Save `attachments.json` after step 2 of the
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

Every allowed file publishes. The headers only decide whether the browser
**shows** a file or **downloads** it. Anything a browser could run as a page at
the site's origin must download: same-origin script would run with the
reader's session cookie and could read their gated notes.

**`Content-Type`** comes from an extension map in `src/utils/attachments.ts`.
The map deliberately holds only **passive** types, which browsers display
without running site code:

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

**Active types are never mapped**, whatever the user allows: `html htm xhtml
xht xml xsl xslt js mjs cjs wasm`, and any other type a browser can render as a
document with script. They are served as `application/octet-stream`, the same as
any unmapped extension. The unit tests pin this list, so adding a passive type
to the map can't map one of these by accident.

**`Content-Disposition`**:

- `inline; filename*=UTF-8''<percent-encoded name>` for mapped types except
  `svg`, so a PDF opens in the browser's viewer in the new tab, under its own
  name.
- `attachment; filename*=UTF-8''…` for `svg` and for everything served as
  `application/octet-stream`, including every active type. A shared `page.html`
  or `script.js` downloads under its own name instead of opening. `<img>`
  ignores the header and renders SVG normally, while opening an SVG's URL
  directly downloads it instead of running any script it holds.

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

**Headers are fixed at upload.** A key never re-uploads (step 1), so changing
the site's read gate or the session length later doesn't change the headers on
files already in the bucket. Only new keys get the new values. A file uploaded
while the site was public keeps `public` after a whole-site gate is added. This
is accepted: the edge function still checks every request, and `public` only
lets intermediate caches store bytes that any reader could already fetch. The
docs say so.

### Change detection between queue and upload

A file can change while a publish is running:

1. **Before commit.** At the start of `commitPendingNotes`, compare each pending
   note's refs against the file's current `stat.size` and `stat.mtime`. If any
   differ, re-run `queueNote` for that note (which re-hashes). If it differs
   again on that second check, stop the publish before anything commits:
   "`song.mp3` is still changing. Publish again when it is saved."
2. **At upload.** If the hash of the bytes sent in step 3 above doesn't match
   (the multipart upload is aborted, or the `PutObject` never sent), stop the
   publish before any note JSON uploads, keeping staged files as other upload
   failures do: "`song.mp3` changed while publishing. Publish the notes that use it
   again."
3. **The next publish.** History and mappings were already committed for the
   staged revision, and its bytes are gone from the vault. Staged entries whose
   vault file no longer matches its hash, or that fail the re-check before
   upload (above), are **dropped** with a console warning. Their notes still
   upload, and those revisions show "Attachment unavailable" for that file.
   Republishing the note records a newer revision with the current bytes, which
   becomes the live one. The dropped keys stay in `refs`, and the audit lists
   them as "referenced, never uploaded".

## 7. Noticing changed attachments

Editing a file doesn't touch the notes that reference it, so mtime-based scopes
would miss the change.

- **Publish updates since last full publish** (`Publisher.getUpdatedNotes`):
  when the mode isn't `off`, also include every publishable note whose
  `metadataCache.resolvedLinks` reach an attachment file that passes the §2
  filters (an allowed extension, not under an excluded directory, within the
  size cap) with `mtime > lastFullPublishTimestamp`. Edits to excluded files
  therefore never re-queue notes. `resolvedLinks` doesn't separate embeds
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

**Pinning and transclusions.** A transclusion always loads the embedded note's
**latest** revision (existing behavior, `fetchTranscludedNote` →
`uid-to-hash`). So an old permalink of the host note shows the embedded note's
current attachments, as it already shows the embedded note's current text.
Pinning (§4) covers a note's own attachments only.

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

Attachments get no diff of their own.

**Hashes become names first.** With Obscure attachment names on (the default),
new bytes change `raw` (`![[3fa9….mp3]]` → `![[77ab….mp3]]`), so comparing
`raw` directly would show a hash swap rather than "the text is identical".
Before comparing, `buildDiff` rewrites each revision's `raw` with **its own**
`attachments` list. Every `<sha256>.<ext>` becomes that entry's `name`. A bare
`<sha256>` (a file without an extension) is replaced too, after the dotted
forms. Each key's hash is 64 hex characters, so a plain string replace of the
listed hashes can't hit other text. If one hash has several names in a list
(identical bytes under two names), the first by key is used. `null.<ext>`
targets, and revisions without a list, are left as they are. Readers already see
these names in the rendered note (§3), so nothing new is shown. The diff, and
the identical-text check below, use the rewritten text.

Then compare the two revisions' `attachments` lists by key:

- If the rewritten `raw` differs and the lists differ, show a notice above the
  diff: "Attachments changed: song.mp3, cover.png."
- If the rewritten `raw` is identical and the lists differ, replace "No
  differences between these two versions." with "The text is identical.
  Attachments changed: song.mp3."

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
| `src/types.ts`, settings defaults, profile settings tab | `attachments` and `obscureRawAttachments` settings (§1). `excludedDirsRulesVersion`. `bucketLifecycleDays`, `sessionHours` state. |
| new `src/utils/excludedDirectories.ts` (pure), `Publisher.isFileExcluded`, `src/main.ts`, `src/settings/profile/content.ts` | Exclusion matching rules, the old rule kept only for the one-time upgrade, the pattern additions and the upgrade notice, help text (§1) |
| new `src/utils/attachments.ts` (pure, no Obsidian imports) | Reference filters, extension sets (including `*`), kind, MIME and disposition (passive map, active types), key building and URL encoding, `::att=` segment, staged-entry merge, required/candidate/orphan derivation |
| new `src/utils/attachmentState.ts` | `attachments.json` load/save, completeness (bucket probe on creation), rebuild from bucket. Hash cache with streamed hashing (Node `fs` + `crypto`). |
| `src/utils/notes.ts` | Collect refs in `queueNote` before the raw scrub (§2), scrub when either obscure setting is on, `::att=` segment, pre-commit re-check, `refs` in `commitPendingNotes`, `attachments` in note JSON, `staged-attachments.json` |
| new `src/utils/parser/scaffolds/remark-attachments.ts`, `src/utils/remarkAttachments.ts`, `ParserContext.resolveAttachment`, `libs.remarkAttachments` | Rendering (§3) |
| `src/utils/rewriteRawWikilinks.ts` | File targets (`<sha256>.<ext>` / `null.<ext>`) and Markdown links in the raw scrub, with separate note and attachment switches (§3) |
| `src/publish/awsUpload.ts` | Attachment upload step (re-check against current settings, manifest, HEAD, streamed multipart with hash-while-sending and abort on mismatch, headers). Sweep after access transitions and partition purge. |
| `src/publish/publisher.ts` | `getUpdatedNotes` attachment-mtime rule. Sweep in `deletePublishedUid`. Audit extension. Staged-file cleanup and error copy. |
| `src/main.ts` | Vault `rename` / `delete` for the hash cache. The content-index / chat-corpus rebuild uses the shared scrub helper with attachment refs (§3). Phase 4 `modify` notice. |
| `infrastructure/assets/index/index.html` (+ `npm run synth:site`) | `fetchNoteJson` prefix, `hydrateAttachments`, transclusion scoping, unavailable/expired states, hash-to-name rewrite and diff notice, CSS |
| `infrastructure/lib/cognito-auth-stack.ts`, `infrastructure/assets/lambda/auth-callback.js`, `src/infrastructure/cloudFormationManager.ts`, wizard, `src/settings/profile/infrastructure.ts` | Session length (§11) |
| `infrastructure/lib/full-stack-oac.ts`, `full-stack-oai.ts`, `cloudFormationManager.ts`, `src/settings/profile/infrastructure.ts` (+ `npm run synth`) | Lifecycle rule (§10) |
| `docs/publishing-model.md`, `docs/settings.md`, `docs/parser-extensions.md`, `docs/auth-and-access.md`, `docs/infrastructure-deployment.md` | Replace the "attachments aren't published" limitation. Document the excluded-directory matching rules with examples, Obscure attachment names, settings, pinning, access, the new stage, session length, the lifecycle rule, and the S3 permissions publishing now uses (`s3:GetObject` for HEAD and rebuild, `s3:ListBucket` for the completeness probe, audit and rebuild, `s3:AbortMultipartUpload`). |

**Phases.** Each is a reviewable unit.

1. **Session length (§11)**, **excluded-directory matching (§1)** and
   **Obscure attachment names with `null` targets only (§1, §3)**. All three
   are independent of attachment publishing and can ship first. The matching
   rules must ship no later than phase 2, because attachment collection relies
   on them.

   The raw scrub closes a leak that exists today: with Obscure wikilinks on, a
   link to a vault file is published as `[[null|Media/song.mp3]]`, exposing the
   folder path. Phase 1 ships:
   - the `obscureRawAttachments` field, its default fill and its toggle;
   - the scrubber's file targets and Markdown `image` / `link` handling, with
     the separate note and attachment switches;
   - the same scrub in the content-index / chat-corpus rebuild in
     `src/main.ts`.

   Nothing publishes as an attachment yet, so every file target becomes
   `null.<ext>` (or `null`) and no hashing is needed. Notes with attachment
   links get a new hash once. In phase 2 the notes whose files then publish
   get a second new hash, as their targets become `<sha256>.<ext>`. That is
   accepted. Phase 1 doesn't touch the HTML. Unpublished wikilinks to vault
   files still show their path there (`displayTextFor` in
   `remarkObsidianLinks.ts`) until phase 2's `remark-attachments` stage
   renders the file name instead.
2. **Core attachments (§1–§8).** Settings, collection, hash, note JSON, the new
   stage, `<sha256>.<ext>` targets in the raw scrub, local state, upload, site
   rendering, `getUpdatedNotes`.
3. **Cleanup (§9, §10).** Sweeps, rebuild, audit, lifecycle rule.
   **Phases 2 and 3 ship in the same release.** Phase 2 alone would leave
   public copies behind when a note is gated.
4. **Change notice (§7).**

## 13. Testing

**Unit tests** (`npx tsx e2e/scripts/…`, one `package.json` script each, as
existing tests do):

- `test-attachments.ts`, for `src/utils/attachments.ts`:
  - reference filtering: mode, extensions, `*`, files without an extension,
    user-added types such as `html` and `canvas`, excluded directories, size;
  - kind and MIME/disposition maps, RFC 5987 file names;
  - every active type (`html`, `js`, `xml`, `wasm`, …) maps to
    `application/octet-stream` with `attachment`, even when allowed, and `svg`
    gets `attachment`;
  - key encoding for odd file names: spaces, `#`, `?`, `%`, `"`, Unicode;
  - the `::att=` segment is order-independent, de-duplicated, and absent when
    there are no refs;
  - staged-entry merge across a failed batch;
  - the re-check before upload: a staged entry from a failed batch whose folder
    was excluded afterwards is dropped, and so are entries whose extension was
    removed from the allow-list, entries over a lowered cap, entries under the
    mode `off`, and entries whose file was moved or deleted; entries that still
    pass are kept;
  - required/candidate/orphan derivation across an access change, a UID delete,
    a blocked note, and two notes sharing a file in different areas.
- `test-excluded-directories.ts`, for `src/utils/excludedDirectories.ts`:
  - `private/`, `private` and `/private` all exclude `private/a.mp3` and
    `private/x/a.md`, but not `Projects/private/a.mp3`, `privateer/a.mp3` or
    `private.md`;
  - `Projects/private/` excludes `Projects/private/a.mp3` only;
  - `**/private/` excludes `private/…`, `a/private/…` and `a/b/private/…`, but
    not `a/privateer/…`;
  - `*-private/`, `Projects/*/drafts/` and `Archive/**/raw/` (zero and several
    middle folders), and `a**b` treated as `*`;
  - trimming (`private/ `, ` private/`), empty lines, `./private/`;
  - case-insensitivity (`Private/` excludes `private/a.md`);
  - literal `?`, `[`, `{` in folder names;
  - patterns never match file names (`**/*.wav` doesn't exclude `a/b.wav`);
  - the upgrade: the entry `private` gains `**/private/` and `private*/`, so
    `Projects/private/…` and `privateer/…` stay excluded, as does a matching
    folder created after the upgrade. `Projects/private` gains
    `**/Projects/private/` and `Projects/private*/`. `private/` gains nothing.
    Patterns already in the list aren't added twice. Only root `private.md` is
    reported as no longer excluded. A second run (version 2) changes nothing.
- `test-attachment-state.ts`: completeness on creation. It is `true` with an
  empty history, and with a non-empty history when the probe finds no
  attachment objects (public or any group). It is `false` when the probe finds
  one in any area. No file is created when the probe fails. Also: rebuild
  merge, hash cache hit and miss on size/mtime, rename and
  delete, and a streamed hash that matches `crypto.subtle.digest` on the same
  bytes.
- `test-obscure-wikilinks.ts`, extended: every row of the §3 raw table.
  File-target wikilinks with alias, size alias, fragment and embed `!`.
  Published targets become `<sha256>.<ext>`, unpublished ones `null.<ext>`, and
  files without an extension `<sha256>` / `null`. No path fallback when there is
  no alias. Markdown images and links in percent-encoded and `<…>` forms. The
  two switches independently: notes only, attachments only, both, neither.
  Unresolved targets unchanged. External URLs unchanged. The `null` rows ship
  in phase 1, with no attachment list (every file target unpublished). The
  phase 1 cases include today's leak: `[[Media/song.mp3]]` no longer becomes
  `[[null|Media/song.mp3]]`.
- **Parser:** add cases for `remark-attachments` (each output row in §3,
  headings, size aliases, mixed paragraphs, escaping, `published: false`), then
  re-capture `e2e/fixtures/parser-golden.json`, reviewing every diff. Expected
  diffs are only attachment links.
- `test-auth-callback.ts` (new): `Max-Age` from `exp`, the floor at 0, the
  fallback when `exp` is missing.
- **Site** (in the style of `test-transclusions-runtime.ts`):
  `hydrateAttachments` URL building and encoding, embedded-note scoping, the
  unavailable state, the expired-session label, and the diff: hash-to-name
  rewriting (dotted and bare hashes, one hash under two names, `null.<ext>` and
  missing lists left alone), so a bytes-only change with Obscure attachment
  names on reports "The text is identical", plus the notice wording.

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
   downloads. With `html` and `js` added to the allow-list, `[[page.html]]` and
   `[[script.js]]` publish, and opening them downloads the file instead of
   running it.
8. With the mode `off`, no attachment objects are written, and attachment links
   render as unpublished spans showing the file name. With Obscure attachment
   names on, the note's `raw` shows `null.<ext>` targets. With it off, the links
   appear as written.
9. With `**/private/` excluded, a note embedding `Projects/private/a.mp3` and
   `Media/b.mp3` publishes `b.mp3` only. `a.mp3` renders as an unpublished
   span, is `null.mp3` in `raw`, and no object exists for it in any area.
10. Make a publish fail at its first upload, before any attachment is sent (e.g.
    credentials without `s3:PutObject`), so the batch stays staged. Restore the
    credentials, add the attachment's folder to Excluded directories, and
    publish again. The file isn't uploaded, the notice names it, and the note
    shows "Attachment unavailable".
11. Delete `attachments.json` and gate a note that has attachments. The probe
    finds attachment objects, so the publish rebuilds the state from the
    bucket, then sweeps the public copy. On a profile with publish history but
    no attachment objects, the first publish with attachments on creates the
    file as complete and never rebuilds.
12. Upload a file over 16 MB (multipart). It plays, and no incomplete multipart
    upload remains (`ListMultipartUploads`). Upload one near the cap and watch
    Obsidian's memory: it stays near the in-flight parts, not the file size.
    Overwrite a large file while it uploads: the multipart upload is aborted,
    no object exists under its key, and the publish stops with the "changed
    while publishing" notice.
13. Apply a session length of 12 h. After signing in, the `cpn_id` cookie's
    `Max-Age` is about 43200 and the token's `exp` is about 12 h out. A
    pre-upgrade pool's Google sign-in still works after Apply.
14. Apply the bucket cleanup rule. `GetBucketLifecycleConfiguration` shows both
    rules, and the site's routes (`/auth/*`, comments, chat) still work.

## Defaults chosen

These were settled while writing the spec. Change any you disagree with:

- Noncurrent versions expire after **30 days** (§10).
- The size cap's ceiling is **500 MB** (§1).
- Shared HTML, JavaScript and other active files **download** rather than
  render (§6). Rendering them on the site would mean serving them from a
  separate origin, which is an infrastructure change.
- Inline images aren't clickable (no lightbox, no open-in-new-tab) in v1.
- **Obscure attachment names** is on by default, like Obscure wikilinks (§1).
- Excluded-directory matching is case-insensitive (§1).
- The excluded-directories upgrade appends `**/<entry>/` and `<entry>*/` for
  each entry without a trailing slash, so nothing the old rule excluded becomes
  publishable, apart from root files it matched only by name, which are
  reported. It doesn't edit or remove the user's entries or block publishing
  (§1).
- Obscure attachment names hides folder paths, not file names, matching
  Obscure wikilinks: only an author-written alias keeps a name out of the
  rendered note (§1, §3).
- A mixed paragraph (`![[pic.png]] ![[Note]]`) renders its note embed inline
  (§3).
