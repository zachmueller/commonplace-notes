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
  generates it **automatically the first time a note gains a publish context** —
  so a note with no publish context has no UID. Don't edit it by hand; changing
  it changes the note's URL and breaks existing links. (Adjust the length for
  *new* UIDs via the UID length setting; existing notes are untouched.)
- **`cpn-title`** — optional; overrides the filename as the note's display title
  on the site.

## What gets published

For a given profile, CPN publishes every non-excluded Markdown note whose
`cpn-publish-contexts` includes that profile's ID. Three per-profile settings
shape the output:

- **Excluded directories** — folders skipped entirely (default `private/`).
- **Include site-wide content search** (`publishContentIndex`) — when on, CPN
  builds a per-profile `contentIndex.json` of each note's plaintext to power
  site-wide search.
- **Obscure wikilinks** (`obscureRawWikilinks`, default on) — rewrites note paths
  in wikilinks to UIDs in the *published raw Markdown* (e.g. `[[Note]]` →
  `[[UID|Note]]`) so note titles/paths aren't leaked in the raw source. Rendered
  HTML and search are unaffected. Turn it off if your own tooling consumes the
  raw Markdown and needs literal titles.

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
