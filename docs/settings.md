# Settings reference

Open **Settings → Commonplace Notes**. This reference mirrors the tab's on-screen
layout, top to bottom. Defaults are listed at the end.

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

- **CPN directory** — the vault folder for CPN extension files (default `cpn`).
  Parser stages live in `<dir>/parsers/`.
- **Built-in stages** — one row per built-in parser stage, each with an **Open**
  button (materialize the stage as an editable vault file, then open it) and, once
  materialized, a **Reset** button (delete the vault file to restore the
  built-in). Overridden stages are marked.
- **Export all built-in stages** — materialize every stage to the vault at once.
- A **Parser extension errors** row appears if any stage failed to load on the
  last publish.

Full guide: [Parser extensions](parser-extensions.md).

## Publishing profiles

At the top: an **Active profile** dropdown and an **Add profile** button. The
rest of this section configures the active profile, in these subsections:

### Profile Identity
- **Profile name** — display name.
- **Profile ID** — the identifier used in frontmatter. This is what
  `cpn-publish-contexts` references, so changing it affects which notes publish.
- **Indicator** — style (color block or emoji) and its color/emoji, shown on the
  title/tab of notes that publish to this profile.

### Content
- **Home Page** — the note that serves as the site's home page (with a Browse
  picker).
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
- **Allowed extensions** (`attachments.allowedExtensions`) — space- or
  comma-separated, case-insensitive. Default: `png jpg jpeg gif webp avif svg`
  (images), `mp3 m4a aac ogg oga opus wav flac` (audio), `mp4 m4v webm mov`
  (video), `pdf`. There's no deny-list: add any extension, or `*` for every file
  (including files without one). Images, audio and video in the default lists
  play in the note; every other type opens in a new tab.
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
  The four subsections below appear only for **AWS** profiles.
- **Base URL** — the site's base URL, used to build copied links.
- *(AWS)* **S3 bucket name**, **S3 prefix** (optional path within the bucket).

### Infrastructure *(AWS only)*
Status badge, deployed stack name/region/domain, origin-access method, and
actions to **Deploy Infrastructure**, **Import existing stack**, or (once
deployed) view outputs. See [Infrastructure deployment](infrastructure-deployment.md).

### Authentication & Delivery *(AWS only)*
- **AWS account ID**, **AWS profile**, **AWS region**.
- **Credential mode** — **SDK** (standard credential chain: env vars, shared
  credentials file, SSO) or **Custom command** (shell commands to refresh creds).
- **Credential refresh commands** — shown when mode is Custom command; supports
  `${awsAccountId}` and `${awsProfile}` variables.
- **CloudFront invalidation scheme** — `individual` / `connected` / `sinceLast` /
  `all` / `manual` (see the [publishing model](publishing-model.md#publish-mechanism-and-cache-invalidation)).
- **CloudFront Distribution ID**.
- **Auth Lambda@Edge**, **Google authorized JavaScript origin / redirect URI**
  (copyable), **Commenting** status, **Sync settings from stack**, and **Manage
  DNS** appear here once relevant. See [Authentication & access](auth-and-access.md).
- **AWS CLI Path** — *deprecated*, shown only if a legacy value is present; the
  plugin uses the AWS SDK directly now. Safe to clear.

### Site Customization *(AWS only)*
- **Push site assets** — upload `index.html`, styles, scripts, and config to S3
  now, without re-publishing notes. Publishing also re-uploads them whenever
  they've changed since the last push (after a plugin update, a site-look
  change, or an asset snippet edit), so this button is only needed to apply a
  change without publishing.
- **Site title**, **Font family**, **Panel width** (default **600** px),
  **Header links**, and collapsible **Theme color overrides** (light/dark).
- **Named styles (per-note)** — see below.
- For raw HTML/CSS/JS injection beyond these, see
  [Site asset customizations](site-asset-customizations.md).

#### Named styles (per-note)

A **named style** lets an individual note opt into a different look. Set
`cpn-style: <name>` in the note's frontmatter, and the site applies that style's
overrides to only that note's panel — everything else keeps the site theme.

Define styles under **Named styles (per-note)** in a profile's Site Customization.
Each style has:

- **Style name** — the value a note puts in `cpn-style` (e.g. `cpn-style: ai`).
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

This pairs with [custom parser stages](parser-extensions.md): a stage can read
`context.noteStyle` and emit custom classes, which you then style here per group.

A note referencing an undefined style name falls back to default styling. Editing
a style ships on the next publish (or **Push site assets**).

### Access groups *(AWS only)*
Groups a note can list in its `cpn-access-groups` frontmatter to restrict who can
read it. See [per-note access groups](auth-and-access.md#per-note-access-groups).

- **Status** — whether this profile can publish gated notes, and why not if it
  can't.
- **Group name**, **Description**, **Members** (one email per line). Renaming a
  group doesn't edit notes; notes still listing the old name stop publishing.
- **Remove** — deletes the group's published files from the site.
- **Sync membership now** — upload member lists immediately (also done on every
  publish).
- **My edge function enforces access groups** — `byo` read gate only.
- **Gate notes on this public site** — `none` read gate only. Attaches the
  access-groups edge function to every request (a small per-request cost);
  public notes stay anonymous. Then run **Deploy access-groups edge function**
  under Infrastructure. See
  [access groups on a public site](auth-and-access.md#per-note-access-groups-on-a-public-site).

### Danger Zone
- **Destroy infrastructure** — tear down the profile's stacks (bucket retained).
- **Force-clean leftover infrastructure** — appears after a failed/interrupted
  teardown to finish removing leftover stacks.
- **Delete profile** — click-to-confirm; the last remaining profile can't be
  deleted.

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
