# Settings reference

Open **Settings → Commonplace Notes**. This reference mirrors the tab's on-screen
layout, top to bottom. Defaults are listed at the end.

The tab uses Obsidian's own settings pages (Obsidian 1.13.1 or later). The root
holds the General rows, links to the **Markdown parser** and **Note routing**
pages, and the **Publishing profiles** list. Each profile opens as its own page
of groups, with the less-used areas (**Theme color overrides**, **Named styles**,
**Deploy hooks**, **Access groups**, **Danger Zone**) as sub-pages. Every row is
also reachable from Obsidian's settings search (the search box at the top of
Settings): search "S3 bucket", "Cognito" or "Base URL", and a result opens the
page and highlights the row. Results are grouped under the page they sit on, so
each profile's rows appear under that profile's name.

<!-- SCREENSHOT: settings tab, General + Markdown parser sections -->

## General

- **UID length** — number of characters for newly generated `cpn-uid` values
  (Crockford Base32). Range **4–26**, default **8** (~1 trillion IDs). Only
  affects *new* UIDs; existing notes are unchanged.
- **Debug mode** — verbose logging to the developer console.
- **URL stack window (seconds)** — how long the sliding window stays open for
  append-mode URL stacking (see the [publishing model](publishing-model.md#url-scheme-and-stacked-urls)).
  Range **1–120**, default **10**. Only applies under the `current` URL scheme.

> The **URL scheme** (`current` vs `original`) is no longer shown here — it
> defaults to `current`. Power users can override `urlScheme` in the plugin's
> `data.json`.

## Markdown parser

A page under the General rows.

- **CPN directory** — the vault folder for CPN extension files (default `cpn`).
  Parser stages live in `<dir>/parsers/`.
- **Built-in stages** — one row per built-in parser stage, each with an **Open**
  icon (materialize the stage as an editable vault file, then open it) and, once
  materialized, a **Reset** icon (delete the vault file to restore the
  built-in). Overridden stages are marked.
- **Export all built-in stages** — materialize every stage to the vault at once.
- A **Parser extension errors** row appears if any stage failed to load on the
  last publish.

Full guide: [Parser extensions](parser-extensions.md).

## Note routing

A page under the General rows.

- **Title prompt** — when routing prompts to (re)name the note: **Always
  prompt**, **Only if named "Untitled…"** (default), or **Never prompt**.
  Options can override it.
- **Built-in actions** — one row per built-in routing action, with the same
  **Open** / **Reset** icons as parser stages.
- **Routing options** — one row per built-in option, likewise, plus **Export
  all routing files**.
- A **Routing errors** row appears if any routing file failed to load on the
  last run.

Actions and options live in `<cpn-dir>/routes/`.

## Publishing profiles

A list with one row per profile. Each row shows the site's domain (or the
publish mechanism, if no base URL is set) and a warning icon when an AWS profile
isn't set up yet (no bucket or region) or its last deploy failed. The **+**
button in the list header adds a profile. Click a profile to open its page,
which has the groups and sub-pages below.

A renamed profile keeps its old name in the list and page title until you close
and reopen Settings. Profiles are deleted from their **Danger Zone** page, not
from the list.

### Profile Identity
- **Profile name** — display name.
- **Profile ID** — the identifier used in frontmatter. This is what
  `cpn-publish-contexts` references, so changing it affects which notes publish.
- **Indicator** — style (color block or emoji) and its color/emoji, shown on the
  title/tab of notes that publish to this profile.

### Content
- **Home Page** — the note that serves as the site's home page. The picker
  suggests Markdown notes outside the excluded directories, and a note this
  profile doesn't publish (its `cpn-publish-contexts` lacks the profile ID) is
  rejected with a message.
- **Include site-wide content search** (`publishContentIndex`) — upload a content
  index so the published site has search.
- **Obscure wikilinks in published Markdown** (`obscureRawWikilinks`, default on)
  — replace note paths with UIDs in the published raw Markdown (`[[Note]]` →
  `[[UID|Note]]`). Rendered HTML and search are unaffected.
- **Obscure attachment names in published Markdown** (`obscureRawAttachments`,
  default on) — replace links to images, audio, PDFs and other non-Markdown
  vault files in the published raw Markdown with the file's content hash, or
  `null` when the file isn't published, keeping the extension:
  `![[Media/song.mp3]]` → `![[3fa9….mp3]]` (or `![[null.mp3]]`),
  `![](Media/pic.png)` → `![](null.png)`. Folder paths stay out of the raw Markdown, the content index
  and the chat corpus. Aliases, alt text and link text are kept, so as with note
  titles, a file's name still shows unless the link has an alias. Applies to
  wikilinks and inline Markdown links; raw HTML (`<img src>`) and reference
  definitions (`[ref]: path`) are left as written. Rendered HTML and search are
  unaffected.
- **Excluded directories** — notes in these folders are never published, and
  neither are files in them. See [Excluded directories](#excluded-directories)
  below.
- **Attachments (Beta)** — see [Attachments](#attachments-beta) below.

#### Attachments (Beta)

*Beta: attachment publishing is new and may change.* Publishes the files your
notes link to. AWS profiles only: on Local profiles the group shows but is
disabled. See [Attachments](publishing-model.md#attachments-beta) for how
publishing, access and pinning work.

- **Publish attachments** (`attachments.mode`, default **Off**) — which links
  publish a file: **Off**, **Embeds** (`![[file]]`, `![](file)`), or **Embeds and
  links** (also `[[file]]`, `[text](file)`). Changing it gives affected notes a
  new revision on their next publish. Narrowing it or turning it off leaves files
  in the bucket while older revisions reference them. When you first turn it on,
  run **Publish all notes** once so existing notes pick up their attachments.
- **Show PDFs inline** (`attachments.inlinePdfs`, default off) — show PDF embeds
  (`![[file.pdf]]`, `![](file.pdf)`) in the note in the browser's PDF viewer,
  with a link under each to open it in a new tab. Plain links (`[[file.pdf]]`)
  still open in a new tab, and so do embeds inside headings. `|600` or
  `|600x800` on the embed sets the viewer's size. Phone browsers often show only
  the link. This changes how notes render, not their content, so it doesn't give
  them new revisions: run **Publish all notes** after changing it, which
  rewrites each published note in place (older permalinks show the new look
  too).
- **Allowed extensions** (`attachments.allowedExtensions`) — space- or
  comma-separated, case-insensitive. Default: `png jpg jpeg gif webp avif svg`
  (images), `mp3 m4a aac ogg oga opus wav flac` (audio), `mp4 m4v webm mov`
  (video), `pdf`. There's no deny-list: add any extension, or `*` for every file
  (including files without one). Images, audio and video in the default lists
  play in the note; every other type opens in a new tab (PDF embeds can show in
  the note with **Show PDFs inline**).
  **Active files download.** Types that a browser could run as a page on your
  site (`html`, `htm`, `xhtml`, `xml`, `xsl`, `js`, `mjs`, `wasm`, …) and any
  type the site doesn't know are served as `application/octet-stream` with
  `Content-Disposition: attachment`, so opening them downloads the file under
  its own name instead of running it. An SVG shows in the note but downloads
  when opened directly.
- **Maximum file size (MB)** (`attachments.maxFileSizeMB`, default 50, 1–500) —
  larger files are skipped, and one notice per publish names them. Files are
  streamed from disk for hashing and upload, so the cap bounds upload time and
  storage, not memory.

Files under an excluded directory never publish, whichever note links them.

#### Excluded directories

One folder pattern per line, matched from the vault root:

| Entry | Excludes | Doesn't exclude |
|-------|----------|-----------------|
| `private/` (also `private`, `/private`) | `private/…` | `Projects/private/…`, `privateer/…`, `private.md` |
| `Projects/private/` | `Projects/private/…` | `private/…` |
| `**/private/` | `private/…`, `a/private/…`, `a/b/private/…` | `a/privateer/…` |
| `*-private/` | `work-private/…` | `a/work-private/…` |
| `Projects/*/drafts/` | `Projects/alpha/drafts/…` | `Projects/drafts/…` |
| `Archive/**/raw/` | `Archive/raw/…`, `Archive/2024/05/raw/…` | `raw/…` |

- Lines are trimmed; a leading `/` or `./` and the trailing `/` are optional.
- Patterns match whole folder names, never file names. A file is excluded when
  any folder above it matches.
- `*` matches any run of characters within one folder name; a `**` segment
  matches any number of folders, including none.
- Matching is case-insensitive. Other characters (`?`, `[`, `{`, `\`) are
  literal; there's no escaping or negation.

**Upgrading from earlier versions.** Entries used to match by substring, so
`private` also excluded `Projects/private/` and `privateer/`. On the first load
after upgrading, CPN keeps every folder the old rule excluded: for each entry
without a trailing `/` it appends `**/<entry>/` and `<entry>*/`. Your own
entries are kept as typed, and entries ending in `/` (like the default
`private/`) gain nothing. A notice per profile lists what was added. Files the
old rule matched only by their own name (a root `private.md` from the entry
`private`) can't be kept by a folder pattern; the notice lists them as no
longer excluded, so move them into an excluded folder. It runs once per profile.

### Destination
- **Publish mechanism** — **AWS** (primary) or **Local** (minimal/experimental).
  Infrastructure, Authentication & Delivery, Site Customization and Deploy
  hooks appear only for **AWS** profiles; switching to Local hides them at once.
- **Base URL** — the site's base URL, used to build copied links.
- *(AWS)* **S3 bucket name**, **S3 prefix** (optional path within the bucket).

### Infrastructure *(AWS only)*
Status badge, deployed stack name/region/domain, origin-access method, and
actions to **Deploy Infrastructure**, **Import existing deployment**, or (once
deployed) **Sync settings from stack**, **Manage DNS**, and **Unlink from AWS
backend**. Rows that depend on the deployment appear once relevant: **Auth
Lambda@Edge**, **Bucket cleanup rule**, **Password gate**, **Cognito gate**,
**Sign-in session length**, **Google authorized JavaScript origin / redirect
URI** (copyable), **Sync Google sign-in with site domain**, and the
**Commenting** rows. The Cognito gate, session length and bucket cleanup rows
show a live log while they run, which stays visible if the page redraws. See
[Infrastructure deployment](infrastructure-deployment.md) and
[Authentication & access](auth-and-access.md).

### Authentication & Delivery *(AWS only)*
- **AWS account ID**, **AWS profile**, **AWS region**.
- **Credential mode** — **SDK** (standard credential chain: env vars, shared
  credentials file, SSO) or **Custom command** (shell commands to refresh creds).
- **Credential refresh commands** — shown when mode is Custom command; supports
  `${awsAccountId}` and `${awsProfile}` variables.
- **CloudFront invalidation scheme** — `individual` / `connected` / `sinceLast` /
  `all` / `manual` (see the [publishing model](publishing-model.md#publish-mechanism-and-cache-invalidation)).
- **CloudFront Distribution ID**.
- **AWS CLI path (optional)** — shown in SDK mode: the `aws` binary to fall back
  on for `aws sso login` when SDK-native renewal can't refresh an expired SSO
  session.

### Site Customization *(AWS only)*
- **Push site assets** — upload `index.html`, styles, scripts, and config to S3
  now, without re-publishing notes. Publishing also re-uploads them whenever
  they've changed since the last push (after a plugin update, a site-look
  change, or an asset snippet edit), so this button is only needed to apply a
  change without publishing.
- **Site title**, **Font family**, **Panel width** (default **600** px).
- **Header links** — a list of label + URL rows: **+** adds one, the **×**
  removes it, and rows can be dragged to reorder.
- **Theme color overrides** — a sub-page with light and dark color pickers. Each
  picker's **Restore default** button returns it to the theme color.
- **Named styles** — a sub-page; see below.
- For raw HTML/CSS/JS injection beyond these, see
  [Site asset customizations](site-asset-customizations.md).

#### Named styles (per-note)

A **named style** lets an individual note opt into a different look. Set
`cpn-style: <name>` in the note's frontmatter, and the site applies that style's
overrides to only that note's panel — everything else keeps the site theme.

Define styles on the **Named styles** sub-page in a profile's Site Customization.
**+** adds a style; each style opens as its own page with:

- **Style name** — the value a note puts in `cpn-style` (e.g. `cpn-style: ai`).
  Applied when you leave the field; an empty or duplicate name is refused.
- **Font family** — optional; overrides the site font for these notes.
- **Light / Dark** — the same five color overrides as the global theme
  (background, text, link, border), layered on top of it. A style only declares
  what it changes; everything unset inherits the site theme.
- **Custom CSS** — arbitrary CSS applied to notes using this style. It is
  **auto-scoped** to the style group: whatever you write is wrapped in
  `.cpn-style-<name> { … }` on the site (via native CSS nesting), so it can't
  affect other notes.
  - **Use theme tokens for colors** — reference `var(--text-primary)`,
    `var(--bg-primary)`, `var(--link-color)`, `var(--border-color)`,
    `var(--bg-secondary)` so light/dark follow the theme automatically.
    Hard-coded colors won't adapt.
  - **Highlight colors** — `==highlights==` read `--highlight-default` and
    `--highlight-red` / `-orange` / `-yellow` / `-green` / `-blue` / `-purple`
    (RGB triplets, e.g. `--highlight-red: 200, 0, 0;`) plus
    `--highlight-bg-opacity`. Set them here to recolor one style's highlights,
    or in the global `extra-css` slot for the whole site.
  - **Prefer class or `&`-nested selectors** (`.my-class { … }`, `& p { … }`)
    over bare element selectors (`p { … }`); the latter need a newer browser for
    CSS nesting. On browsers without nesting support the block is simply ignored
    (the note falls back to the base look).
  - Injected **verbatim** — you're the trusted author of your own site (same
    boundary as the [`extra-css` slot](site-asset-customizations.md)). Top-level
    at-rules like `@keyframes` / `@font-face` can't be nested; put those in the
    global `extra-css` slot instead.

**Remove style** at the bottom of the page deletes it.

This pairs with [custom parser stages](parser-extensions.md): a stage can read
`context.noteStyle` and emit custom classes, which you then style here per group.

A note referencing an undefined style name falls back to default styling. Editing
a style ships on the next publish (or **Push site assets**).

### Deploy hooks *(AWS only)*
A sub-page for custom code that runs around the profile's full-stack deploy: the
profile's hooks folder, **Validate hooks** (discover and compile them without
deploying), and **Export example hook**. See
[Infrastructure deployment](infrastructure-deployment.md).

### Access groups
A sub-page. Groups a note can list in its `cpn-access-groups` frontmatter to restrict who can
read it. See [per-note access groups](auth-and-access.md#per-note-access-groups).

- **Status** — whether this profile can publish gated notes, and why not if it
  can't.
- **Groups** — a list; **+** adds one, and each group opens as its own page with
  **Group name**, **Description** and **Members** (one email per line; entries
  that aren't email addresses are flagged). Renaming a group doesn't edit notes;
  notes still listing the old name stop publishing.
- **Remove group** (on the group's page) — after a confirmation, deletes the
  group's published files from the site.
- **Sync membership now** — upload member lists immediately (also done on every
  publish).
- **My edge function enforces access groups** — `byo` read gate only.
- **Gate notes on this public site** — `none` read gate only. Attaches the
  access-groups edge function to every request (a small per-request cost);
  public notes stay anonymous. Then run **Deploy access-groups edge function**
  under Infrastructure. See
  [access groups on a public site](auth-and-access.md#per-note-access-groups-on-a-public-site).

### Danger Zone
A sub-page.

- **Destroy infrastructure** — after a confirmation, tear down the profile's
  stacks (buckets retained unless you tick **Also delete S3 data**).
- **Force-clean leftover infrastructure** — appears after a failed/interrupted
  teardown to finish removing leftover stacks.
- **Clean up orphaned edge resources** — appears while a force-clean's orphaned
  Lambda@Edge resources are waiting for CloudFront to release them.
- **Delete profile** — click twice to confirm; the last remaining profile can't
  be deleted.

## Defaults

Lifted from `DEFAULT_SETTINGS` (`src/main.ts`):

| Setting | Default |
|---------|---------|
| UID length | `8` |
| URL scheme | `current` |
| URL stack window (seconds) | `10` |
| CPN directory | `cpn` |
| Debug mode | `false` |

Default profile (`Default AWS Profile`, ID `default`):

| Field | Default |
|-------|---------|
| Excluded directories | `['private/']` |
| Public | `false` |
| Include site-wide content search | `true` |
| Obscure wikilinks | `true` |
| Obscure attachment names | `true` |
| Publish mechanism | `AWS` |
| Indicator | color block, `#3366cc` |
| CloudFront invalidation scheme | `individual` |
| Credential mode | `sdk` |

Site customization defaults (when first enabled): panel width `600`, empty site
title / font family / header links / theme overrides.
