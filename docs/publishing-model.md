# Publishing model

How Commonplace Notes decides what to publish, where, and under what URL.

## Publishing profiles

A **profile** is a named publish target: an S3 bucket, a base URL, its own
infrastructure, and its own site look & feel. One vault can define several
profiles, each producing an independent site — e.g. a public "digital garden" and
a private work site from the same notes. The bundled profile has the ID
`default`. Manage profiles under **Settings → Commonplace Notes → Publishing
profiles**; see the [settings reference](settings.md).

## Publish contexts

Notes are **private by default**. A note publishes to a profile only when that
profile's ID appears in the note's `cpn-publish-contexts` frontmatter, which is an
**array** of profile IDs:

```yaml
---
cpn-publish-contexts:
  - default
  - work
---
```

The easiest way to set this is the per-profile **Toggle publishing context:
<profile>** command, which adds or removes the ID for you.

> **String vs. list:** `cpn-publish-contexts` must be a YAML **list**. If a note
> has it as a plain string, CPN still treats it functionally as a single-element
> list but flags the note with a notice pointing you to the console fix
> `app.plugins.plugins['commonplace-notes'].fixPublishContextsFormat()`. CPN does
> **not** silently rewrite it. See [Troubleshooting](troubleshooting.md#publishing).

## Note identity

- **`cpn-uid`** — a stable per-note identifier that drives the note's site URL.
  It uses the [Crockford Base32](https://www.crockford.com/base32.html) alphabet
  (digits + uppercase, excluding I/L/O/U) and defaults to 8 characters. CPN
  generates it **the first time the note is published** (or when a published
  note links to it), so a note that has never been published has no UID yet.
  Once a note has a `cpn-uid`, CPN never replaces it. Don't edit it by hand
  either: a new UID publishes the note again under a new URL, and the old copy
  stays on the site until you remove it with **Audit published notes for stale
  or duplicate UIDs** (see [Troubleshooting](troubleshooting.md#publishing)).
  (Adjust the length for *new* UIDs via the UID length setting; existing notes
  are untouched.)
- **`cpn-access-groups`** — optional list of access groups that may read the
  note. Absent or empty means the note uses the site-wide read access. See
  [per-note access groups](auth-and-access.md#per-note-access-groups).
- **`cpn-title`** — optional; overrides the filename as the note's display title
  on the site.

## What gets published

For a given profile, CPN publishes every non-excluded Markdown note whose
`cpn-publish-contexts` includes that profile's ID. Three per-profile settings
shape the output:

- **Excluded directories** — folders skipped entirely (default `private/`),
  matched from the vault root, with `*` and `**` patterns. See
  [Settings](settings.md#excluded-directories).
- **Include site-wide content search** (`publishContentIndex`) — when on, CPN
  builds a per-profile `contentIndex.json` of each note's plaintext to power
  site-wide search.
- **Obscure wikilinks** (`obscureRawWikilinks`, default on) — rewrites note paths
  in wikilinks to UIDs in the *published raw Markdown* (e.g. `[[Note]]` →
  `[[UID|Note]]`) so note titles/paths aren't leaked in the raw source. Rendered
  HTML and search are unaffected. Turn it off if your own tooling consumes the
  raw Markdown and needs literal titles.
- **Obscure attachment names** (`obscureRawAttachments`, default on) — rewrites
  links to non-Markdown vault files in the published raw Markdown to the file's
  content hash, or `null` when it isn't published, keeping the extension (e.g.
  `![[Media/song.mp3]]` → `![[3fa9….mp3]]`, or `![[null.mp3]]` for a file that
  doesn't publish). It covers wikilinks and inline Markdown links and images,
  not raw HTML or reference definitions. It applies whatever the
  [attachment mode](#attachments-beta). The rendered HTML never shows folder
  paths: links to vault files show the file name (or the link's alias).

Both obscure settings change the note's content hash, so turning either on or
off republishes the notes it affects on the next publish.

## Attachments (Beta)

> **Beta.** Attachment publishing is new and may change. It is off by default.

A note can publish the images, audio, video, PDFs and other files it links to.
Turn it on per profile in **Settings → Content → Attachments (Beta)**, then run
**Publish all notes** once so existing notes pick up their files.

**What publishes.** The **mode** decides which links publish a file:

- **Off** (default): none.
- **Embeds**: `![[file.ext]]` and `![](file.ext)`.
- **Embeds and links**: also plain `[[file.ext]]` and `[text](file.ext)`.

A file also has to have an allowed extension, be within the size cap, and not
sit in an [excluded directory](settings.md#excluded-directories). Links to
Markdown files are always notes, never attachments. The list of files comes only
from Obsidian's metadata cache, so a note Obsidian hasn't indexed yet publishes
with every file link unpublished. Attachments publish on AWS profiles only.

**How readers see them.** `![[image]]`, `![[audio]]` and `![[video]]` play in the
note. PDF and other embeds, and every plain link, open the file in a new tab. A
file that didn't publish shows its name as an unpublished link. HTML, JavaScript
and other files that could run code on the site download instead of opening.

**Access follows the notes.** A file is uploaded to every access area that has a
note referencing it: the public area, and each `restricted/<group>/` area of a
gated note. It is readable by exactly the readers who can read some note that
references it. A file becomes public as soon as any public note references it.
See [Authentication & access](auth-and-access.md#attachments).

**Pinning.** A note revision references the exact bytes it was published with.
The note's content hash includes each attachment's SHA-256 and file name, so:

- editing a file gives every note that uses it a new revision on its next
  publish, and old permalinks keep the old bytes;
- turning the mode on, widening it, narrowing it or turning it off changes the
  hashes of the notes it affects;
- notes without links to non-Markdown files keep their hashes.

Files are stored under `attachments/<sha256>/<file name>` in each area. A key's
bytes never change, so files are cached for a long time and never need a
CloudFront invalidation. **Publish updates since last full publish** also picks
up notes whose files changed (it checks each linked file's modification and
change time, so a tag editor that keeps the modification time is still seen).

**Diffs.** Attachments get no diff of their own. The note diff shows file names
instead of content hashes, and says **Attachments changed: …** when the files
differ. A change to a file's bytes alone shows **The text is identical.
Attachments changed: …**.

**Publishing safety.**

- **Publish lock.** A publish, a delete, a group purge, a content-index
  rebuild or an attachment check (the audit and its delete offer) for one
  profile never overlap. A second request while one runs is refused with a
  "busy" notice; run it again when the first finishes.
- Every staged file is re-checked against the current settings just before
  upload. Files that are now excluded, no longer allowed, over the cap, moved,
  or changed since an earlier failed publish staged them are dropped with a
  notice. Their notes show **Attachment unavailable** for them.
- A file that changes while a publish reads or uploads it stops the publish
  with "`<file>` is still changing" or "`<file>` changed while publishing".
  Publish again once it is saved.
- Files are uploaded before any note, so a note never points at a missing file.
- Turning the mode off or narrowing it leaves files in the bucket while older
  revisions still reference them.

**Cleanup.** A file stays in an area while any published revision of a note in
that area references it, old revisions included. Files are removed only when
revisions leave an area:

- **An access change.** When a note moves from public to gated, between groups,
  or is unpublished because its groups can't publish, the files only its
  revisions used are deleted from each area it left, right after its note
  copies. Gating a note therefore makes its files unreadable to the public as
  soon as the publish finishes.
- **Delete a published note.** The deleted note's files are removed from every
  area, unless another published note there still uses them.
- **Removing an access group** deletes its whole `restricted/<group>/` area,
  attachments included.

Cleanup runs whatever the attachment mode, including **Off**, so turning the
mode off never leaves a gated note's files public. A file two notes share stays
in each area that still has a note using it. Cleanup works from the profile's
local `attachments.json`. When that file is missing or incomplete (for example
it never synced to this machine) and the bucket already holds attachments, the
plugin first rebuilds it by reading every published note's file list from the
bucket, with a progress notice. If cleanup can't finish (no credentials, no
network, a delete refused), the note change still happens, and a notice that
stays until dismissed names the note and the area whose files may still be
readable. Run **Audit published notes** then.

**Audit published notes** also lists the bucket's attachment objects (it needs
`s3:ListBucket`) and reports in the console:

- **Unreferenced objects**: files no published revision in their area uses,
  left by a cleanup that couldn't finish or by changes made outside the plugin.
  The audit offers to delete them; it rebuilds `attachments.json` first if it is
  incomplete, and checks the bucket again before deleting.
- **Missing objects**: files a published revision uses that aren't in the
  bucket. If the vault still has the same bytes, the next publish of a note that
  uses the file uploads it again. Otherwise they are listed as "referenced,
  never uploaded (bytes no longer in the vault)".

Deleted files stay in the bucket as old versions until the
[bucket cleanup rule](infrastructure-deployment.md#bucket-cleanup-rule) expires
them (30 days by default). They can't be fetched through the site meanwhile.

**One publishing machine per profile.** The profile's local state
(`publish-history.json`, the mappings, `access.json` and `attachments.json`)
lives in the plugin folder and reaches other machines only through whatever
syncs it: Obsidian Sync with community plugins included, or a file sync of the
whole vault. Publish each profile from one machine, or let the plugin folder
finish syncing before publishing from another. Cleanup trusts that local state:
if two machines publish the same profile before sync catches up, one machine's
cleanup can delete a file the other's newer revision uses. **Audit published
notes** finds such missing objects and has the next publish upload them again.
The publish lock only prevents overlapping work on one machine.

**Known limitations.**

- **Raw HTML and reference-style links.** `<img src="Media/x.png">`,
  `<audio src=…>`, `<a href=…>` and reference definitions
  (`[ref]: Media/a.pdf`, used by `![alt][ref]` and `[text][ref]`) aren't in
  Obsidian's metadata cache. They are never published and pass through as
  written, folder path included. The same goes for a Markdown destination with
  a bare space (`![](Media/my pic.png)`): Markdown doesn't read it as a link and
  Obsidian doesn't index it. Write `my%20pic.png` or `<Media/my pic.png>`, or use
  a wikilink.
- **Links Obsidian and remark read differently.** A link Obsidian indexes but
  the Markdown parser doesn't read as one link is uploaded with the note but
  neither rendered nor obscured in the published raw Markdown, so its folder
  path stays there. Known cases: a wikilink holding emphasis markers
  (`![[my *draft* take.mp3]]`), and a file name holding something that reads as
  an HTML tag (`![[a<b>.png]]`).
- **Mixed paragraphs.** A paragraph that mixes an attachment embed with a note
  embed (`![[pic.png]] ![[Note]]`) renders the note embed inline.
- **Headers are fixed at upload.** Changing the read gate or the session length
  later doesn't change the caching headers of files already uploaded.
- **Media and sign-in sessions.** Playback stops when a reader's sign-in session
  ends; the player then offers **Sign in again**.

> **Upgrading.** Every publish re-uploads the current revision of each note it
> includes, so notes pick up the new link rendering (file names instead of
> folder paths, escaped unpublished links) on their next publish. **Publish all
> notes** refreshes every note. Old permalinks keep their old HTML. The release
> with attachments requires Obsidian 1.8.7 or later.

## Embeds (transclusions)

Obsidian embeds of other published notes render their content in place:

- `![[Note]]` — the whole note.
- `![[Note#Heading]]` — that heading's section: the heading and everything
  after it up to the next heading of the same or higher level.
- `![[Note#^abc]]` — one block, marked in the target with a trailing ` ^abc`
  (or a `^abc` line right after a table, list, quote or code block). A
  numbered-list item keeps its number.

Embeds are **live**. The published note stores only the target's UID; the site
fetches the target's *latest* published revision when the page is viewed. Editing
and republishing the target updates every note that embeds it — including old
revisions opened by permalink — without republishing those notes, and their
content hashes don't change.

Visibility follows the same rule as links: an embed renders only when every
reader who can see the embedding note could also see the target. Otherwise it
appears as an unpublished link, without the target's UID or title. The site also
re-checks each reader's access when it loads the target, and shows **Embedded
note unavailable** (or **Embedded section unavailable**, when the heading or
block no longer exists) instead of the content. A note embedding itself, or a
chain more than four embeds deep, stops at a plain link.

Limitations:

- Embedded notes show their own *latest* attachments, as they show their latest
  text. Pinning (below) covers a note's own attachments only.
- Site search and chat index each note's own text only, not embedded content.
- A target republished while the page is open appears after a reload.
- `\![[Note]]` (escaped) is still treated as an embed.

> **Upgrading.** Notes published before embeds were supported keep their old
> HTML until republished, because their content hash doesn't change. Run
> **Publish all notes** with CloudFront invalidation once after upgrading. For
> local publishing, delete the cached `local-template.html` so the updated
> template is downloaded.

## Publish scope

Four commands publish different sets of notes (all resolve notes for a chosen
profile):

- **Publish current note** — just the active note.
- **Publish active and connected notes** — the active note plus its outgoing
  links and backlinks (that are themselves publishable).
- **Publish updates since last full publish** — notes modified since the
  profile's `lastFullPublishTimestamp` (updated on every full publish).
- **Publish all notes** — every publishable note for the profile.

See the [commands reference](commands.md).

## URL scheme and stacked URLs

The published site reads which notes to show from the URL **hash fragment**.

- **`current` scheme (default)** — slash-delimited fragments. A single note is
  `#/uABC123`; several notes **stack** into one link as `#/uA/uB/uC`, opening
  side by side in the reader.
- **`original` scheme (legacy)** — `#u=ABC123`. It cannot stack notes.

The scheme is no longer exposed in the settings UI; it defaults to `current`.
Power users can still override `urlScheme` directly in the plugin's `data.json`.

Two commands produce links:

- **Copy link to current note URL** copies the active note's URL. Invoked
  **again within the URL-stack window** (default 10s, configurable), each call
  appends the active note to a growing stacked URL on the clipboard — so you can
  click through a few notes and end up with one link that opens all of them. The
  window resets on each copy and only applies under the `current` scheme.
- **Copy open notes as stacked URL** builds one stacked URL from every note open
  in the main editor area, in tab order (requires the `current` scheme).

## Publish mechanism and cache invalidation

Each profile publishes via one **mechanism**:

- **AWS** — the primary, fully-supported path (uploads to S3, invalidates
  CloudFront). Set up via the [deployment wizard](infrastructure-deployment.md).
- **Local** — minimal/experimental; not the recommended path today.

For AWS profiles, the **CloudFront invalidation scheme** sets a threshold: a
publish invalidates the CDN cache only if its scope is **at least as broad** as
the configured scheme. The scopes, narrowest to broadest, are `individual` <
`connected` < `sinceLast` < `all`.

| Configured scheme | Publishes that invalidate |
|-------------------|---------------------------|
| `individual` | every publish (all four commands) |
| `connected` | Publish active and connected notes, updates, and all |
| `sinceLast` | Publish updates and Publish all |
| `all` | only Publish all notes |
| `manual` | never automatically — you invalidate yourself |

Invalidation also requires the profile to have a CloudFront distribution ID. If
content looks stale on the site, see [Troubleshooting](troubleshooting.md).
