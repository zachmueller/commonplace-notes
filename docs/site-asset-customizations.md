# Site asset customizations (per-profile snippet injection)

Customize a published site's static assets (`index.html`, `styles.css`) **per
profile**, without forking the plugin, by authoring snippet **notes** in your
vault. Each note's snippet is injected at a named slot in the built-in template
when you push site assets.

This is the "add-on" route: you inject small snippets (analytics tags, custom
`<head>` metadata, extra CSS, a client-side redirect shim, footer HTML) into the
maintained built-in asset — you do **not** replace the whole file, so you stay
on the plugin's evolving runtime contract. Full-file overrides are not supported
today.

## Where snippet notes live

```
{cpnDir}/profiles/{profileId}/assets/*.md
```

`{cpnDir}` is the **CPN directory** setting (Settings → Markdown parser → *CPN
directory*, default `cpn`) — the same user-visible root the parser stages use.
`{profileId}` is the publishing profile's id. Create the folder if it doesn't
exist; any `.md` note in it with `cpn-type: asset` is picked up. Notes without
that frontmatter (or in other folders) are ignored.

> The `assets/` directory is **not** the hidden `.obsidian/plugins/...` profile
> dir — it's under your normal, editable vault so you author these notes in the
> Obsidian editor like any other note.

## Note format

Frontmatter declares the target slot; a single fenced code block holds the
snippet body (injected **verbatim**):

```markdown
---
cpn-type: asset
cpn-slot: head-extra
---

​```html
<script>/* your snippet */</script>
​```
```

- `cpn-type: asset` — required discriminator.
- `cpn-slot` — required; one of the slots below. The **target asset is derived
  from the slot**, so there is no `cpn-asset` field.
- The snippet is the first ```` ```html ````, ```` ```css ````, or ```` ```js ````
  fenced block. The fence language is just an editor hint — it is not validated
  against the slot (e.g. a `head-extra` slot commonly holds an inline
  `<script>` authored in an ```` ```html ```` fence).

## Slots

| `cpn-slot`          | Injected into | Where                                              |
| ------------------- | ------------- | -------------------------------------------------- |
| `head-extra`        | `index.html`  | end of `<head>` — **runs before `app.js` (pre-boot)** |
| `body-end-scripts`  | `index.html`  | end of `<body>`, after `app.js` (post-boot; analytics) |
| `header-extra-html` | `index.html`  | inside the `<header>` bar                          |
| `footer-html`       | `index.html`  | after the notes panels                             |
| `extra-css`         | `styles.css`  | appended to the end of the stylesheet              |

Multiple notes targeting the **same slot** are concatenated in
**filename-ascending** order.

## Applying changes: "Push site assets" (important)

Snippet edits take effect **only** when you run **Settings → (profile) → Push
site assets**. That re-renders all static assets from your current snippet notes
and issues a CloudFront invalidation.

A **normal publish does not pick up snippet edits** — it only refreshes
`config.json` and note content. After editing a snippet note, always run *Push
site assets*.

Malformed notes (bad `cpn-type`/`cpn-slot`, missing fence) are skipped with a
warning notice + console detail; the rest still publish.

## Example: legacy-URL redirect shim

Re-route an old URL scheme to the current `#/u{uid}` fragment scheme before the
router boots. Author `{cpnDir}/profiles/{id}/assets/legacy-redirect.md`:

```markdown
---
cpn-type: asset
cpn-slot: head-extra
---

​```html
<script>
(function () {
  var oldToNew = { "legacy-slug-a": "ab12cd" /* old slug -> new uid */ };
  var m = location.pathname.match(/^\/notes\/([^\/]+)/); // old scheme
  if (m && oldToNew[m[1]]) location.replace("#/u" + oldToNew[m[1]]);
})();
</script>
​```
```

Because `head-extra` renders in `<head>`, this runs before `app.js` reads the
hash. For a large mapping, ship the map as a separate asset note/file and
`fetch()` it in the shim.

> If your old URLs were **path-based** (`/notes/foo`) rather than hash-based, the
> hosting layer must serve `index.html` for unknown paths for the shim to run at
> all (an SPA-style 404 → `index.html` fallback). That is a CloudFront config
> concern, separate from this feature.

## Notes / trust boundary

- Snippets are injected **raw** — no escaping or sanitization. You are the
  trusted author of your own site; injecting `<script>`, CSS, and third-party
  tags is the point. Don't paste snippets you don't understand.
- `config.json` is **not** a snippet target (raw text would break its JSON).
  Structured site settings (title, header links, panel width, theme, fonts) stay
  in the profile's *Site customization* settings.
- Vendored libraries (`flexsearch.min.js`, `vendor.js`) are not customizable.
