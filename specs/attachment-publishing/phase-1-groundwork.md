# Phase 1: Groundwork

Part of [Publishing attachments](design.md). **Not beta.** Ships on its own,
before phases 2 and 3.

Four changes that don't depend on attachment publishing:

1. [Sign-in session length](#1-sign-in-session-length): 12 hours for new
   deployments; existing sites keep 1 hour until their author changes it.
2. [Excluded directories](#2-excluded-directories): matched from the vault
   root, with `*` and `**`.
3. [Raw-scrub fixes](#3-raw-scrub-fixes): correct splice offsets, escaped pipes
   in table cells, a narrower fast path.
4. [Obscure attachment names](#4-obscure-attachment-names): links to vault
   files in the published `raw` become `null.<ext>`.

Ordering within the phase:

- §3 lands with or before §4, because §4 splices more links the same way.
- §2 must ship no later than phase 2, because attachment collection relies on
  it.
- §1 is independent of the rest.

What this phase does to existing sites: notes with links to vault files, and
notes the offset bug corrupted, get a new hash once and republish. In phase 2,
notes whose files then publish get a second new hash, as their targets become
`<sha256>.<ext>`. That is accepted.

**This phase doesn't touch the HTML.** Until phase 2's `remark-attachments`
stage:

- unpublished wikilinks to vault files still show their folder path in the
  rendered note (`displayTextFor` in `remarkObsidianLinks.ts`);
- Markdown images and links to vault files still render as a broken relative
  `<img src="Media/pic.png">` or `<a href="Docs/a.pdf">`, folder path included.

## 1. Sign-in session length

### Why

The `cpn_id` session cookie is set with `Max-Age=3600`
(`infrastructure/assets/lambda/auth-callback.js`). The cookie holds a Cognito ID
token, which the edge function (`lib-jwt-verify.js`, `exp` check) and the
comment authorizer both reject once it expires. The pool's app client uses
Cognito's default ID token lifetime of 1 hour. Both must be raised together,
because a longer cookie holding a 1-hour token changes nothing.

Media requests (phase 2) can't trigger the site's reload-to-sign-in, so a long
recording stops when the session ends. A 12-hour default for new deployments
makes that rare, and the remaining risk is accepted. P2 §9 covers the message
readers see.

**Existing pools keep 1 hour.** A longer session also widens how long a removed
member keeps access (Effect and trade-offs, below), so an existing site's
session never changes unless its author chooses a new length with **Apply**.

### Cognito pool stack

`infrastructure/lib/cognito-auth-stack.ts`:

- [x] New parameter `SessionHours` (Number, default **12**, `MinValue` 1,
      `MaxValue` 24). 24 h is Cognito's maximum ID token lifetime.
- [x] `UserPoolClient`: `idTokenValidity` and `accessTokenValidity` set to
      `SessionHours`, with `tokenValidityUnits: { idToken: 'hours',
      accessToken: 'hours' }`. The refresh token keeps its default; the site
      doesn't use it.
- [x] `npm run synth` to regenerate `src/infrastructure/templates.ts`.

### Callback Lambda

`auth-callback.js`:

- [x] The cookie's `Max-Age` becomes the ID token's `exp` minus now. It decodes
      the token payload without verifying it; the token came straight from
      Cognito's token endpoint over TLS.
- [x] The value is floored at 0 and falls back to 3600 if `exp` can't be read.

The cookie can then never outlive its token, and `SessionHours` is the only
setting.

### Plugin

- [x] `CloudFormationManager`: add `SessionHours` to `COGNITO_AUTH_PARAM_KEYS`
      and `buildCognitoAuthParameters`.
- [x] Persist `DeploymentConfig.sessionHours` and `CognitoAuthState.sessionHours`
      (`src/infrastructure/types.ts`, where both types live).
- [x] New `effectiveSessionHours(profile)`: the persisted
      `CognitoAuthState.sessionHours`, or **1** when it is absent. Absent means
      the pool was deployed before this setting, so its tokens last Cognito's
      default of 1 hour. Every caller that needs "the session length" uses it,
      including the restricted attachments' `max-age` (P2 §7).
- [x] **Deployment wizard**, Cognito step: a "Sign-in session length (hours)"
      field. It defaults to 12 for a new pool and to `effectiveSessionHours`
      when the wizard re-runs against a live pool.
- [x] **Settings → Infrastructure → Cognito gate**
      (`src/settings/profile/infrastructure.ts`): a "Sign-in session length"
      row with an hours field (1–24) showing `effectiveSessionHours`, and an
      **Apply** button. On a pool without a persisted value, the description
      reads: "This site uses 1-hour sessions, Cognito's default when it was
      deployed. Longer sessions mean fewer sign-ins and media that keeps
      playing, but a reader removed from a group keeps access for up to one
      session length."
- [x] New `updateCognitoSessionLength(profile, hours)`, which:
  - [x] runs `UpdateStack` on the pool stack in us-east-1 with the **current**
        `COGNITO_AUTH_TEMPLATE` (older pools lack the parameter, so
        `UsePreviousTemplate` won't do), with
        `buildCognitoAuthUpdateParameters({ SessionHours }, deployedKeys)`, so
        the never-stored Google client secret stays `UsePreviousValue`;
  - [x] polls to completion with the event log;
  - [x] saves `sessionHours`.
- [x] The Apply row is disabled, with a reason, on a legacy pool that still holds
      its inline edge function ("Run **Upgrade Cognito gate** first"), because
      the current template would remove that function without the upgrade's
      retain step. Settings can't see the deployed template, so the row uses
      "not on the current template yet" (`accessGroupsKey` absent), and
      `updateCognitoSessionLength` refuses when the deployed template still
      holds `AuthEdgeFn`, `AuthEdgeFnVersion` or `EdgeFnRole`.
- [x] The Apply row is disabled on imported stacks. (The whole Cognito gate
      section is hidden for them, and `updateCognitoSessionLength` refuses
      them.)
- [x] **No update ever relies on the template default.** Every pool-stack
      update that sends the current `COGNITO_AUTH_TEMPLATE` passes
      `SessionHours` **explicitly**: `upgradeCognitoGate` as
      `effectiveSessionHours(profile)`; the update path of
      `deployCognitoAuthStack` and `updateCognitoAuthStack` (wizard phase 2) as
      the wizard's value, which the wizard seeds with `effectiveSessionHours`
      for a live pool and 12 for a new one. (Phase 2 of a brand-new pool runs
      before `CognitoAuthState` is persisted, so `effectiveSessionHours` would
      return 1 there and undo the wizard's 12.) This matters for pools that
      predate the parameter: `buildCognitoAuthUpdateParameters` omits keys the
      live stack was never deployed with, so without an explicit value the
      template default of 12 would apply and silently lengthen an existing
      site's sessions. The helper is `currentTemplateUpdateParameters`
      (`src/infrastructure/cognitoParams.ts`).
- [x] After such an update succeeds on a pool without a persisted value, persist
      `sessionHours: 1`, so later updates take the usual path.
- [x] `updateCognitoCallbackUrl` keeps `UsePreviousTemplate`. It needs no
      change: a pool whose template lacks the parameter omits it, and one that
      has it keeps it with `UsePreviousValue`.
- [x] Only a **new** pool (`CreateStack`) takes the wizard's value, 12 by
      default.

### Effect and trade-offs

- New deployments get 12 hours. Existing sites stay at 1 hour until their
  author applies a longer length.
- It applies at each reader's next sign-in. Existing cookies keep their expiry.
- It covers the whole-site Cognito gate, access-group sign-in on public sites,
  and comment sign-in. They share one app client.
- Removing someone from a group, or from the site, takes effect within one
  session length (12 h by default on new sites) instead of about an hour. A
  copied cookie is also valid that long.
- From phase 2, restricted attachments are cached privately for one session
  length (P2 §7).

## 2. Excluded directories

### Why

Today's check (`Publisher.isFileExcluded`:
`filePath.startsWith(dir) || filePath.includes('/' + dir + '/')`) does raw
string matching. With the documented `private/` form, the second clause looks
for `/private//` and never matches. Without the slash, `private` also matches
`privateer/` and `private.md`. An entry with a trailing space matches nothing.
Attachments (phase 2) rely on this check, so the rules are redefined.

### Rules

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

### Matcher

- [x] New pure module `src/utils/excludedDirectories.ts`:
      `compileExcludePatterns(lines) → (path) => boolean`, implementing the
      rules above.
- [x] `Publisher.isFileExcluded` delegates to it, so every caller shares one
      implementation: `getAllPublishableNotes`, `getConnectedNotes`,
      `publishSingle`, `publishConnected`, the audit, the file-tree indicators,
      and (phase 2) attachments.
- [x] Settings help text (`src/settings/profile/content.ts`): "One folder per
      line, from the vault root. `private/` excludes only the top-level private
      folder. Use `*` for any folder name and `**/` for any depth, e.g.
      `**/private/` excludes every folder named private."

### One-time upgrade, per profile

Existing entries are kept as typed and take the new meaning. Entries without a
trailing slash used to match at any depth (`filePath.includes('/' + dir + '/')`)
and by prefix (`filePath.startsWith(dir)`), which the new rules read more
narrowly. Users are told to run **Publish all notes** right after turning
attachments on (P2 §2), which is exactly when a note the old rule excluded
would go live. So the upgrade keeps those folders excluded rather than only
warning.

On the first load after upgrading (`src/main.ts`):

- [x] **Step 1, add patterns.** For each profile, for every entry that, once
      trimmed, doesn't end in `/`, append the patterns that reproduce the old
      rule's folder matches: `**/<entry>/` (any depth) and `<entry>*/`
      (prefix), skipping any already in the list.
  - `<entry>` is first normalized as in rule 1 (a leading `/` or `./`
    dropped), so `/private` gains `**/private/`, not `**//private/`. An entry
    with a leading `/` matched nothing under the old rule, so its additions only
    ever exclude more.
  - This runs per entry, not per affected file, so a matching folder created
    later is still excluded.
  - `private` gains `**/private/` and `private*/`. `Projects/private` gains
    `**/Projects/private/` and `Projects/private*/`.
  - Entries ending in `/` meant the same thing under both rules and gain
    nothing, so the default `private/` is unchanged.
- [x] **Step 2, find files no pattern can keep.** Compare the old rule against
      the new list over every vault file, not only Markdown. What remains are
      files the old rule matched only by their own name (`private.md` at the
      root, from the entry `private`), which no folder pattern can express.
- [x] **Step 3, notice.** If step 1 added anything or step 2 found anything,
      show a persistent notice per profile: "Excluded directories now match
      from the vault root. In `<profile>`, added `**/private/` and `private*/`
      so the same folders stay excluded. Open settings". Files from step 2 are
      listed (up to five, then "and N more") with "No longer excluded. Move it
      into an excluded folder." The full file list goes to the console.
- [x] **Step 4, record.** Set `excludedDirsRulesVersion: 2` on the profile
      (`src/types.ts`), whether or not anything changed, so the upgrade runs
      once.
- [x] Profiles created after the upgrade start at version 2 and skip it.
- [x] Keep the old rule only inside the upgrade code, for step 2.

The added lines only ever exclude more. The upgrade doesn't edit or remove the
user's own entries, and it doesn't block publishing.

## 3. Raw-scrub fixes

These fix existing bugs in `scrubRawWikilinks`
(`src/utils/rewriteRawWikilinks.ts`). They apply to note targets as well as
file targets, whatever the Obscure attachment names setting. Notes the bugs
corrupted get a correct `raw`, and so a new hash, once. They republish in the
same first publish as the §4 change.

### Splice offsets

`scrubRawWikilinks` finds wikilinks in each text node's `value` and splices
the original string at `node.position.start.offset + match.index`. That works
only when `value` is a byte-for-byte copy of the source, and often it isn't.
Parsing removes characters on the way into `value`:

- a backslash escape: `\*` becomes `*`, and `\|` in a table cell becomes `|`;
- a character reference: `&amp;` becomes `&`, and `&#91;` becomes `[`;
- trailing spaces and tabs before a soft line break: `a \n` becomes `a\n`;
- the prefix of each continuation line: `> ` in a blockquote, the indent of a
  list item's continuation line, the leading spaces of a paragraph's
  continuation line.

Each removed character shifts every later splice in that node. With Obscure
wikilinks on, today's publish corrupts `raw`, and with it the note hash, the
content index and the chat corpus (confirmed against the current code):

```
written                  published today
a \* [[Note]] b          a \*[[UID|Note]]] b
x &amp; [[Note]] y       x &a[[UID|Note]]te]] y
a⎵                       a⎵[[UID|Note]]] b
[[Note]] b
> a                      > a
> [[Note]] b             [[UID|Note]]]] b
- a                      - a
  [[Note]] b             [[UID|Note]]]] b
```

(`⎵` marks a trailing space.)

Separately, the `raw.includes('[[')` fast path skips `\[\[Note]]` and
`&#91;&#91;Note]]`, which the renderer still turns into note links, so their
paths stay in `raw`.

- [x] Matching stays on `node.value`, so the scrubber and the renderer, which
      also reads `value`, see the same wikilinks.
- [x] Each match's start and end are mapped from positions in `value` to source
      offsets, using micromark's events for the node:
  - `data` chunks map one to one;
  - a `characterEscape` maps one value character to its two source characters;
  - a `characterReference` maps its decoded characters to the whole reference;
  - a `lineEnding` maps the `\n`;
  - line prefixes (`linePrefix`, `blockQuotePrefix`, a list item's continuation
    indent) and trailing whitespace before a soft line break (`lineSuffix`)
    have no value characters and are never part of a match.

  A match that starts or ends inside an escape or a reference covers all of
  it. A text node whose tokens don't rebuild its `value` exactly is left
  unchanged rather than spliced at a guessed offset.
- [x] Only the target path is spliced. A wikilink's `#heading` and alias stay
      exactly as written in the source, escapes included, and a note link
      without an alias gains `|` plus the path's source text.
- [x] One helper owns the micromark parse and serves both these offsets and the
      Markdown destination offsets in §4.
- [x] `micromark` and `micromark-extension-gfm` become direct dependencies in
      `package.json` (today they are only transitive), pinned to the major
      versions `remark-parse` 10 and `remark-gfm` 3 use (`micromark` 3,
      `micromark-extension-gfm` 2; installed today: 3.2.0 and 2.0.3), so the
      events line up with the mdast the scrubber walks.
- [x] The fast path returns early only when `raw` contains neither `[` nor `&`.

### Pipes in table cells

In a GFM table an unescaped `|` ends the cell, so Obsidian users write
`[[Note\|alias]]` and `![[pic.png\|300]]` there. Today's scrubber always writes
a bare `|`, so a scrubbed link splits its cell and the published table gains a
column:

```
written                        published today
| [[Note]] | x |               | [[UID|Note]] | x |
| [[Note\|alias]] | x |        | [[UID|alias]]] | x |
```

(The second row is also hit by the offset bug.)

- [x] When a rewritten link's text node has a `tableCell` ancestor
      (`visitParents`), the `|` the replacement puts before a display text,
      alias or size alias is written `\|`. This applies to note and file
      targets alike. Because the alias is kept from the source, where a cell
      already needs `\|`, the only separator the scrubber writes is the one
      it adds before a note link's display text.
- [x] Outside tables the separator stays a bare `|`.

Markdown links and images need nothing: only their destination is replaced, so
alt and link text stay byte for byte as written.

```
written (in a table cell)      published raw (both settings on)
| [[Note]] | x |               | [[UID\|Note]] | x |
| [[Note\|alias]] | x |        | [[UID\|alias]] | x |
| ![[pic.png\|300]] | x |      | ![[null.png\|300]] | x |
| ![alt\|300](pic.png) | x |   | ![alt\|300](null.png) | x |
```

(From phase 2, a published file shows `<sha256>.<ext>` where this shows
`null.<ext>`.) The raw table in §4 shows `|` for these separators. Inside a
table cell each is `\|`.

## 4. Obscure attachment names

**Obscure attachment names** does for file links what **Obscure wikilinks**
does for note links: it replaces the link target in the published `raw` with an
opaque ID. It applies to every link that resolves to a non-Markdown vault file,
**whatever the attachment mode**, and is independent of `obscureRawWikilinks`.

It closes a leak that exists today: with Obscure wikilinks on, a wikilink to a
vault file becomes `[[null|Media/song.mp3]]`, because the scrubber falls back to
the path as display text, so the folder path is already published.

### Setting

- [x] New profile field beside `obscureRawWikilinks` (`src/types.ts`):

  ```ts
  obscureRawAttachments?: boolean; // absent ≡ true
  ```

  It is a top-level profile field rather than part of `AttachmentSettings`
  (P2 §2), because it applies whatever the attachment mode, including `off`,
  and on Local profiles too.
- [x] Filled in as `true` on load when missing (`src/main.ts`, beside the
      existing `obscureRawWikilinks` default), and `true` in new-profile
      defaults.
- [x] **UI:** a toggle directly below **Obscure wikilinks in published Markdown**
      in the content settings (`src/settings/profile/content.ts`): "Obscure
      attachment names in published Markdown. Replace links to images, audio
      and other files in the published raw Markdown with the file's content
      hash (e.g. `![[Media/song.mp3]]` → `![[3fa9….mp3]]`), so folder paths stay
      private. As with note titles, the rendered note still shows a file's name
      unless the link has an alias. Rendered HTML and search are unaffected."

The setting matches **Obscure wikilinks** in scope: it hides where a file lives
in the vault, not what it is called. Readers see the file name wherever the
author didn't write an alias, and from phase 2 a published file's name is also
part of its key and URL (P2 §7).

### Targets

The new target is:

- `<sha256>.<ext>` when the file is in the note's attachment list (P2 §3), so
  it is published. `<sha256>` is the file's full hash, matching the `key` in the
  note JSON's `attachments` (P2 §5), so a raw consumer can map it to the file.
- `null.<ext>` when it isn't: excluded, over the size cap, not on the
  allow-list, only linked (never embedded) in `embeds` mode, the mode `off`, or
  a Local profile. A plain link to a file the note also embeds gets
  `<sha256>.<ext>`, matching the working link the renderer gives it. This
  mirrors the `null` used for unpublishable note links, but keeps the extension
  so the link still reads as media.
- For a file without an extension, `<sha256>` or `null`.

**In phase 1 nothing publishes as an attachment, so every file target is
`null.<ext>` (or `null`) and no hashing is needed.** The interface below already
carries a hash so phase 2 only has to supply it.

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

(`3fa9…` stands for the full 64-character hash. In phase 1 every row shows
`null` in place of the hash.)

- **Aliases, alt text and link text are kept**, as wikilink aliases are. Unlike
  note links, an attachment link with no alias **never falls back to its path**
  as display text, because that would bring the file name back.
- **Known limitation:** text the author wrote is kept as written, even when it
  repeats the file name (`[song.mp3](Media/song.mp3)` → `[song.mp3](3fa9….mp3)`).
  This matches how a wikilink alias that repeats a note's title is kept.
- The fragment (`#page=3`) and the embed `!` are kept.
- Inside a table cell, every `|` the scrubber writes is `\|` (§3).

### Scrubber changes

- [x] The callback becomes
      `resolveTarget(path) => { kind: 'note', uid: string | null } | { kind: 'file', sha256: string | null, ext: string } | null`.
      `null` means unresolved: leave the link as today.
- [x] The scrubber takes `{ notes: boolean, attachments: boolean }` from the two
      settings. Note targets behave exactly as today when `notes` is on and are
      left alone when it's off. File targets are rewritten when `attachments`
      is on and left as written when it's off.
- [x] `NoteManager.rewriteRawWikilinks` resolves a non-Markdown `TFile` to
      `{ kind: 'file', sha256: null, ext }` in phase 1. Phase 2 passes the hash
      for files in the note's attachment list. A wikilink whose target is
      missing resolves to `{ kind: 'note', uid: null }`, so it keeps today's
      `[[null|…]]` form; a Markdown link only acts on `file` results.
- [x] **Markdown links.** The same pass visits `image` and `link` nodes whose
      `url` is relative: no scheme (`/^[a-z][a-z0-9+.-]*:/i`), not starting with
      `#`, `/` or `//`. The URL is percent-decoded before lookup. A URL that
      resolves to a non-Markdown vault file has its destination replaced by the
      new target.
  - [x] A `<…>` destination drops its brackets, since the target has no
        spaces.
  - [x] The destination is spliced by source offset. mdast positions cover the
        whole `![alt](dest "title")`, not the destination alone, so the
        destination's offsets come from micromark's `resourceDestination`
        tokens (or an equivalent parse of the node's source slice that handles
        `<…>`, titles, escapes and nested brackets), never from searching the
        slice for the URL text. They come from the same micromark parse as the
        wikilink offsets (§3).
- [x] Reference definitions (`[ref]: path`) and raw HTML are not rewritten. They
      aren't in Obsidian's metadata cache and stay as written, folder path
      included (P2 §4, "Known limitations").
- [x] Unresolved targets and external URLs are left as today.
- [x] `queueNote` (`src/utils/notes.ts`) runs the scrub when **either** setting
      is on (today: `obscureRawWikilinks` only).
- [x] **Content-index and chat-corpus rebuild.** `rebuildContentIndex` in
      `src/main.ts` (beside its "Mirror the scrub applied in queueNote"
      comment) runs the same scrub outside a publish. Move the scrub into one
      helper that both call sites use, so the index can't drift from the
      published `raw`. In phase 2 the helper also collects the note's
      attachment list (P2 §3). The helper is
      `NoteManager.rewriteRawWikilinks(raw, file, profile)`, which reads both
      settings.

With the setting on, neither the folder path nor the file name of a wikilink or
inline Markdown link target appears in `raw`, or in anything built from it (the
content index, the chat corpus). Raw HTML and reference definitions are the
exception and keep their paths. The HTML keeps the file name and, in phase 1,
the folder path too (see the top of this page). With the setting off,
attachment links in `raw` stay exactly as written, including the folder path,
as note links do with **Obscure wikilinks** off.

Notes with attachment links get new hashes once, and republish, on the first
publish after upgrading. Toggling the setting does the same. That is accepted:
what they publish changes.

## 5. Tests

### `test-excluded-directories.ts` (new)

For `src/utils/excludedDirectories.ts`, with a `package.json` script:

- [x] `private/`, `private` and `/private` all exclude `private/a.mp3` and
      `private/x/a.md`, but not `Projects/private/a.mp3`, `privateer/a.mp3` or
      `private.md`.
- [x] `Projects/private/` excludes `Projects/private/a.mp3` only.
- [x] `**/private/` excludes `private/…`, `a/private/…` and `a/b/private/…`, but
      not `a/privateer/…`.
- [x] `*-private/`, `Projects/*/drafts/` and `Archive/**/raw/` (zero and several
      middle folders), and `a**b` treated as `*`.
- [x] Trimming (`private/ `, ` private/`), empty lines, `./private/`.
- [x] Case-insensitivity (`Private/` excludes `private/a.md`).
- [x] Literal `?`, `[`, `{` in folder names.
- [x] Patterns never match file names (`**/*.wav` doesn't exclude `a/b.wav`).
- [x] The upgrade: the entry `private` gains `**/private/` and `private*/`, so
      `Projects/private/…` and `privateer/…` stay excluded, as does a matching
      folder created after the upgrade.
- [x] The upgrade: `Projects/private` gains `**/Projects/private/` and
      `Projects/private*/`. `/private` gains `**/private/`. `private/` gains
      nothing.
- [x] The upgrade: patterns already in the list aren't added twice.
- [x] The upgrade: only root `private.md` is reported as no longer excluded.
- [x] The upgrade: a second run (version 2) changes nothing.

### `test-obscure-wikilinks.ts` (extended)

- [x] Every row of the §4 raw table, with `null` targets.
- [x] File-target wikilinks with alias, size alias, fragment and embed `!`.
- [x] Files without an extension become `null`.
- [x] No path fallback when there is no alias. Today's leak is closed:
      `[[Media/song.mp3]]` no longer becomes `[[null|Media/song.mp3]]`.
- [x] Markdown images and links in percent-encoded and `<…>` forms, with and
      without a title.
- [x] The two switches independently: notes only, attachments only, both,
      neither.
- [x] Unresolved targets unchanged. External URLs unchanged. Reference
      definitions and raw HTML unchanged.
- [x] **Splice offsets**, note and file targets: an escape before a link
      (`a \* [[Note]] b`), an entity before a link (`x &amp; [[Note]] y`), `\|`
      in a table cell, a trailing space and a trailing tab before a soft line
      break (`a \n[[Note]] b`), blockquote and list-item continuation lines, an
      indented paragraph continuation line, two links with an escape between
      them, a link whose brackets are escaped or written as references
      (`\[\[Note]]`, `&#91;&#91;Note]]`), and Markdown destinations after each
      of these.
- [x] For every offset case, the output differs from the input only inside the
      rewritten links: parsed again, its text outside the links is unchanged.
- [x] **Pipes in table cells**, note and file targets: `[[Note]]`,
      `[[Note\|alias]]`, `[[Note#Heading\|alias]]`, `![[pic.png\|300]]` and
      `![alt\|300](pic.png)` in a cell each come out with `\|`, and the parsed
      table keeps the same number of columns and the same cell boundaries.
- [x] The same links outside a table keep a bare `|`.

### `test-auth-callback.ts` (new)

- [x] `Max-Age` from `exp`.
- [x] The floor at 0 for an expired token.
- [x] The fallback to 3600 when `exp` is missing or unreadable.

### `test-session-hours.ts` (new)

- [x] `effectiveSessionHours` returns the persisted value, and 1 when none is
      persisted.
- [x] The update parameters for `upgradeCognitoGate`, `deployCognitoAuthStack`
      (update path) and `updateCognitoAuthStack` include `SessionHours`
      explicitly: `1` for a pool deployed without the parameter and without a
      persisted value, otherwise the persisted value. Never `UsePreviousValue`
      on a pool that lacks the key, and never omitted.
- [x] `updateCognitoCallbackUrl` omits `SessionHours` for a pool that lacks it
      and uses `UsePreviousValue` for one that has it.
- [x] A new pool's create parameters use the wizard's value, 12 by default.

### End-to-end (sandbox `random` only)

The two checks that need no AWS run in the local Obsidian harness:
`npm run test:excluded-directories-e2e` and `npm run test:obscure-wikilinks-e2e`.

- [ ] On a pool deployed before this change, run **Upgrade Cognito gate**
      without touching the session length. After signing in, the `cpn_id`
      cookie's `Max-Age` is about 3600 and the token's `exp` is about 1 h out,
      and the profile now records `sessionHours: 1`.
- [ ] Apply a session length of 12 h. After signing in, the `cpn_id` cookie's
      `Max-Age` is about 43200 and the token's `exp` is about 12 h out. A
      pre-upgrade pool's Google sign-in still works after Apply.
- [ ] A new deployment with the wizard's defaults gets 12-hour sessions.
- [x] With `**/private/` excluded, a note in `Projects/private/` doesn't
      publish, and one in `Projects/public/` does.
- [x] With Obscure attachment names on, a note embedding `Media/song.mp3`
      publishes `raw` with `![[null.mp3]]`. With it off, the link appears as
      written.
- [ ] A note with `a \* [[Note]] b` and a table row `| [[Note\|alias]] | x |`
      publishes a `raw` that renders the same table and text as the source.

## 6. Docs

- [x] `docs/auth-and-access.md`: "Membership changes apply at a reader's next
      sign-in…" updated for the setting: 12 hours on new sites, 1 hour on sites
      deployed earlier until the author changes it, and the access trade-off.
- [x] `docs/infrastructure-deployment.md`: the session length field in the
      wizard and the Apply row.
- [x] `docs/settings.md`: the excluded-directory matching rules with examples,
      the upgrade and its notice, and Obscure attachment names.
- [x] `docs/publishing-model.md`: Obscure attachment names in the raw-Markdown
      section. Note that rendered HTML still shows folder paths for vault-file
      links until attachment publishing ships.
- [ ] Release notes (draft below, for the `release` skill): the one-time hash change for notes with attachment links
      or corrupted `raw`, the excluded-directories upgrade, and the session
      length setting ("Existing sites keep 1-hour sign-in sessions. To lengthen
      them, use Settings → Infrastructure → Cognito gate → Sign-in session
      length").

Release-note draft:

> - **Obscure attachment names** (new, on by default): links to images, audio,
>   PDFs and other vault files in the published raw Markdown no longer show
>   their folder path (`![[Media/song.mp3]]` → `![[null.mp3]]`). Notes with such
>   links get a new content hash once and republish on the next publish.
> - **Raw Markdown fixes:** with Obscure wikilinks on, links after an escape,
>   an entity, trailing spaces, or on a blockquote or list continuation line
>   could corrupt the published raw Markdown, and links in table cells split
>   the cell. Affected notes get a new hash once and republish.
> - **Excluded directories** now match folders from the vault root, with `*`
>   and `**/` patterns (`**/private/` excludes every folder named private). On
>   first load, entries without a trailing `/` gain patterns that keep the same
>   folders excluded, and a notice lists what was added and any root files that
>   are no longer excluded.
> - **Sign-in session length:** new sites default to 12-hour sign-in sessions.
>   Existing sites keep 1-hour sign-in sessions. To lengthen them, use
>   Settings → Infrastructure → Cognito gate → Sign-in session length.

## Done when

- [ ] Every box in §1–§6 is ticked.
- [x] `npm run build` and all unit tests pass.
- [ ] The end-to-end checks in §5 pass on the sandbox site.
