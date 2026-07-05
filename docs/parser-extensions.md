# Parser extensions

> **Advanced.** Most users never need this. Commonplace Notes ships a complete
> Markdown→HTML pipeline out of the box; this guide is for customizing it.

CPN turns each note's Markdown into HTML by running it through an ordered list of
**parser stages**. Every stage — including the eight built-ins — is defined as a
Markdown file, so you can override a built-in or add your own by authoring a note
in your vault. No plugin rebuild required.

## How the pipeline works

Stages run in ascending `order`. The pipeline has two halves:

- **remark stages** operate on the **MDAST** (Markdown syntax tree).
- **rehype stages** operate on the **HAST** (HTML syntax tree).

The `remark-rehype` stage (order 50) is the boundary that converts MDAST → HAST.
Keep remark stages below order 50 and rehype stages above it.

The default order reproduces CPN's built-in pipeline exactly:

```
010 remark-parse → 020 remark-gfm → 030 line-numbers →
040 remark-obsidian-links → 045 remark-callouts → 050 remark-rehype →
055 rehype-slug → 060 rehype-stringify
```

## The built-in stages

There are **eight** built-in stages:

| Order | Name | Tree | What it does |
|-------|------|------|--------------|
| 10 | `remark-parse` | remark | Parses Markdown into an MDAST syntax tree (installs the parser). |
| 20 | `remark-gfm` | remark | GitHub Flavored Markdown: tables, strikethrough, task lists, autolinks. |
| 30 | `line-numbers` | remark | Tags each node with `class="line"` and `data-line=<source line>`. |
| 40 | `remark-obsidian-links` | remark | Resolves `[[wikilinks]]` to published-note URLs (or unpublished spans). |
| 45 | `remark-callouts` | remark | Renders Obsidian `[!type]` callout blockquotes as styled callout boxes. |
| 50 | `remark-rehype` | rehype | Converts the MDAST (Markdown) tree into a HAST (HTML) tree. |
| 55 | `rehype-slug` | rehype | Assigns GitHub-style slug `id`s to every heading. |
| 60 | `rehype-stringify` | rehype | Serializes the HAST (HTML) tree to the final HTML string. |

A few couplings to respect if you override these:

- **Slug parity.** `remark-obsidian-links` (40) emits heading slugs as
  `data-heading`, and `rehype-slug` (55) assigns matching heading `id`s — both use
  `github-slugger`. That's how section links from wikilinks scroll to the right
  heading. If you replace either, keep both producing `github-slugger`-compatible
  slugs.
- **Callout CSS.** `remark-callouts` emits `data-callout-type` values that must
  match the published site's `[data-callout-type="…"]` CSS. Keep the type list in
  sync if you customize it.
- **`remark-parse` is the frontend.** It must stay order 10 / stage `remark`;
  overriding it replaces the *entire* Markdown parser.

## Authoring a stage

A stage is a Markdown file in `<cpnDir>/parsers/` (the CPN directory defaults to
`cpn`). It has two parts: frontmatter that declares the stage, and a single code
fence that produces a [unified](https://unifiedjs.com/) plugin.

**Frontmatter contract:**

```yaml
---
cpn-type: parser              # required — marks this note as a parser stage
cpn-parser-name: my-stage     # required — unique key; matches a built-in name to override it
cpn-parser-stage: remark      # required — "remark" or "rehype"
cpn-parser-order: 35          # required — number; lower runs first
cpn-description: "..."        # optional — shown in settings
---
```

**Code-fence contract:**

- One fenced code block (```` ```ts ```` or ```` ```js ````).
- The body runs as an **async function** with these arguments in scope:
  `(libs, context, app, utils)`.
- It must **`return`** a unified plugin, or a `[plugin, options]` tuple.
- **No `import` statements.** Vault Markdown never passes through the bundler, so
  there's no module resolver — everything you need comes from `libs` (below) or
  the runtime `context`. An `import` is a compile error.

**Runtime arguments:**

- `libs` — the bundled toolkit (below).
- `context` — per-note runtime info: `file`, `profileId`, `frontmatterManager`,
  `resolveInternalLinks(notePath)`, and `urlScheme`.
- `app` — the Obsidian `App`.
- `utils` — `{ logger, slug }` (a scoped logger and a `github-slugger` function).

## The `libs` toolkit

The single approved channel for building blocks (since you can't `import`):

- **unified core:** `unified`
- **tree traversal / text:** `visit`, `visitParents`, `is`, `mdastToString`,
  `hastToString`, `githubSlugger`
- **canonical pipeline stages** (so overrides can delegate to the originals):
  `remarkParse`, `remarkGfm`, `remarkRehype`, `rehypeSlug`, `rehypeStringify`
- **CPN-internal factories:** `remarkObsidianLinks`, `remarkLineNumbers`,
  `remarkCallouts`
- **optional plugins (eager):** `rehypeRaw`, `rehypeAutolinkHeadings`, `remarkMath`
- **heavy math renderers (lazy thunks — `await` them):** `rehypeKatex()`,
  `rehypeMathjax()`
- **helper:** `defineTransform(fn)` — wraps a raw `(tree, file) => void`
  transformer into a unified plugin.

## Overriding a built-in

Give your stage the **same `cpn-parser-name`** as a built-in and your file wins.
Delete the file (or use **Reset** in settings) to restore the built-in default —
the built-in always runs as an in-memory fallback when no vault file overrides it.

Materialize a built-in to edit it via the per-stage **Open** button in
**Settings → Markdown parser → Built-in stages**, or the **Export all parser
stage definitions to vault** command. Changes apply on the **next publish**.

## Worked example

A custom remark stage that upper-cases all heading text. Save it as
`<cpnDir>/parsers/uppercase-headings.md`:

````markdown
---
cpn-type: parser
cpn-parser-name: uppercase-headings
cpn-parser-stage: remark
cpn-parser-order: 35
cpn-description: "Upper-case all heading text."
---

Runs on the Markdown tree (order 35, after wikilinks/callouts resolve, before
the MDAST→HAST conversion at 50).

```ts
// In scope: libs, context, app, utils — NO imports.
return libs.defineTransform((tree) => {
  libs.visit(tree, 'heading', (node) => {
    libs.visit(node, 'text', (textNode) => {
      textNode.value = textNode.value.toUpperCase();
    });
  });
});
```
````

Run any publish command to apply it.

**Disabling a built-in** is just as easy — override it with a no-op plugin. To
turn off GitHub Flavored Markdown, create a stage named `remark-gfm` whose body is:

```ts
// In scope: libs, context, app, utils — NO imports.
return function () {};
```

## Troubleshooting

If a stage doesn't take effect, or the settings tab reports parser errors, see
[Troubleshooting → Parser stages](troubleshooting.md#parser-stages).
