# Concepts

A glossary of the core ideas in Commonplace Notes. Each entry links to the doc
that covers it in depth.

### Publishing profile

A named publish target — its own S3 bucket, base URL, infrastructure, and site
look & feel. One vault can define several profiles to feed several independent
sites. The bundled profile has the ID `default`. See the
[publishing model](publishing-model.md) and [settings](settings.md).

### Publish context

A profile ID listed in a note's `cpn-publish-contexts` frontmatter (an **array**
of IDs). It's how a note opts in to a site: a note publishes to a profile only if
that profile's ID appears in its contexts. Toggle it with the per-profile
**Toggle publishing context** command. See the
[publishing model](publishing-model.md#publish-contexts).

### UID (`cpn-uid`)

A stable per-note identifier, drawn from the
[Crockford Base32](https://www.crockford.com/base32.html) alphabet (digits and
uppercase letters excluding I, L, O, U). Default length is 8 characters. CPN
generates it **automatically** the first time a note gains a publish context, and
it drives the note's site URL — so don't edit it by hand. See the
[publishing model](publishing-model.md#note-identity).

### Display title (`cpn-title`)

An optional frontmatter field that overrides the filename as the note's display
title on the published site. Absent it, the filename is used.

### Publish mechanism

How a profile publishes: **AWS** (the primary, fully-supported path — S3 +
CloudFront) or **Local** (minimal/experimental). Set per profile in
[settings](settings.md).

### Indicator

A small per-profile badge (a color block or an emoji) shown on a note's title and
its tab when the note publishes to that profile, with a "Published to: <profile>"
tooltip. Configured per profile under Profile Identity in [settings](settings.md).

### Read gate

How read access to a published site is controlled: `none` (fully public),
`cognito` (whole-site sign-in), `password` (shared password), or `byo`
(bring-your-own viewer-request Lambda@Edge). Set in the deployment wizard. See
[authentication & access](auth-and-access.md#read-gating-modes).

### Cognito and Google sign-in

An optional AWS Cognito user pool (with Google as the identity provider) that CPN
can deploy to gate reads and/or to identify commenters. See
[authentication & access](auth-and-access.md#cognito-and-google-sign-in).

### Commenting

An optional self-hosted comment backend (S3 + API Gateway + DynamoDB) that adds a
comment box to published note pages. Requires Cognito comment identity. See
[authentication & access](auth-and-access.md#commenting).

### Parser stage

One step in the Markdown→HTML pipeline (e.g. parse Markdown, resolve wikilinks,
serialize HTML). CPN ships eight **built-in** stages, and you can **override** a
built-in — or add your own — by authoring a stage as a Markdown file in your
vault. See [parser extensions](parser-extensions.md).

### Routing action & option

The two building blocks of [note routing](note-routing.md). An **action** is a
reusable step (move the note, set frontmatter, add publish contexts, run a
template, or run code); an **option** is a named choice in the routing suggester
that composes an ordered list of steps referencing actions. Both are authored as
Markdown files under `<cpnDir>/routes/` — override a built-in or add your own. See
[note routing](note-routing.md).

### Insert-template action

A [routing action](note-routing.md#running-a-template-insert-template) of kind
`insert-template` that runs one of your [Templater](https://github.com/SilentVoid13/Templater)
templates against the note (merges its frontmatter, appends its body). As an
option's only step it "redirects" (the template owns the whole note); after other
steps it "appends." See [note routing](note-routing.md#running-a-template-insert-template).

### CPN directory

The vault folder (default `cpn`) that holds CPN's user-editable extension files.
Parser stages live in `<cpnDir>/parsers/`; routing actions and options live in
`<cpnDir>/routes/actions/` and `<cpnDir>/routes/options/`; per-profile site-asset
snippets live in `<cpnDir>/profiles/<profileId>/assets/`. Set under Markdown
parser in [settings](settings.md).

### URL scheme & stacked URLs

The site reads notes from the URL hash fragment. The default `current` scheme
uses slash-delimited fragments like `#/uABC123`, and stacks several notes into one
link as `#/uA/uB` (opening them side by side). The legacy `original` scheme uses
`#u=ABC123` and cannot stack. See the
[publishing model](publishing-model.md#url-scheme-and-stacked-urls).

### Site customization vs. site-asset snippets

Two ways to change how a site looks. **Site customization** is structured
per-profile settings (title, header links, panel width, fonts, theme colors) —
see [settings](settings.md). **Site-asset snippets** inject raw HTML/CSS/JS at
named slots for anything the structured settings don't cover — see
[site asset customizations](site-asset-customizations.md).

### Content index (search)

A per-profile `contentIndex.json` (plaintext of each published note) that powers
site-wide search. Gated by the profile's **Include site-wide content search**
toggle. See [settings](settings.md) and the
[publishing model](publishing-model.md#what-gets-published).

### CloudFront invalidation scheme

Controls when a publish triggers a CloudFront cache invalidation:
`individual`, `connected`, `sinceLast`, `all`, or `manual`. Set per profile under
Authentication & Delivery. See the
[publishing model](publishing-model.md#publish-mechanism-and-cache-invalidation).
