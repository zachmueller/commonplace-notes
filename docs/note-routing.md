# Note routing

Routing turns a raw note into a filed one in a single command: it can move the
note, seed frontmatter, opt it into publish contexts, run a Templater template,
or run your own code — in whatever order you choose. You pick a **routing
option** from a list; each option runs an ordered pipeline of **actions**.

Like [parser stages](parser-extensions.md), every action and option is a Markdown
file in your vault, so you can override a built-in or add your own by authoring a
note — no plugin rebuild required.

## Running it

Two commands drive routing (both act on the active note):

- **Route new note** — for a freshly-created note. Runs in **create** mode.
- **Route existing note** — to re-file an already-filed note. Runs in **update**
  mode, which skips steps that only make sense once (see
  [capability flags](#capability-flags)).

Each opens a suggester of your routing options. Pick one and its steps run in
order. If the option allows it, you're first prompted to (re)name the note.

## The two file types

Routing files live under `<cpnDir>/routes/` (the CPN directory defaults to `cpn`):

- **Actions** — `<cpnDir>/routes/actions/` — reusable building blocks (move a
  note, set frontmatter, run a template…). One action, one job.
- **Options** — `<cpnDir>/routes/options/` — the choices shown in the suggester.
  An option composes an ordered list of **steps**, each referencing an action.

CPN ships built-in **actions** that work out of the box (they run from memory even
with no files in your vault). It ships **no built-in options** — you author your
own from these actions (see [Authoring an option](#authoring-an-option)), so you're
never locked into a particular vault layout. Materialize any built-in action to
edit — see [Overriding a built-in](#overriding-a-built-in).

## Built-in actions

| Name | Kind | What it does |
|------|------|--------------|
| `move` | `move` | Moves the note into a directory (backlinks update). Destination via `params.dir`. |
| `set-publish-contexts` | `publish-contexts` | Adds publish contexts (unioned with any existing). Contexts via `params.contexts`. |
| `insert-template` | `insert-template` | Runs a [Templater](https://github.com/SilentVoid13/Templater) template against the note. See [below](#running-a-template-insert-template). |
| `ensure-uid` | `ensure-uid` | Assigns the note a stable CPN UID (`cpn-uid`) if it lacks one. See [below](#assigning-a-uid-ensure-uid). |

### Action kinds

Every action has a `cpn-routing-action-kind`. The six kinds:

- **`move`** — relocate the note (link-preserving rename).
- **`set-frontmatter`** — merge a fixed frontmatter mapping (values may use the
  `$now` / `$ctime` sentinels).
- **`publish-contexts`** — add publish contexts (array-unioned, so it's safe to
  re-run).
- **`insert-template`** — run a Templater template. See
  [Running a template](#running-a-template-insert-template).
- **`ensure-uid`** — assign a stable CPN UID (`cpn-uid`) if the note lacks one.
  See [Assigning a UID](#assigning-a-uid-ensure-uid).
- **`code`** — run an embedded TypeScript/JavaScript body with a `libs` toolkit
  in scope (the escape hatch for anything the declarative kinds don't cover).

## Options

CPN ships **no built-in options** — the choices shown in the suggester are the ones
you author, so routing matches your own vault layout rather than someone else's. A
routing option is just a Markdown file composing the built-in actions above; see
[Authoring an option](#authoring-an-option) for the full syntax. A minimal example:

```yaml
---
cpn-type: routing-option
cpn-routing-option-name: "Publish"
cpn-routing-steps:
  - "[[move]] dir: /"
  - "[[ensure-uid]]"
  - "[[set-publish-contexts]] contexts: public"
---
```

## Authoring an action

An action is a Markdown file in `<cpnDir>/routes/actions/`. Its frontmatter
declares the kind and any kind-specific config:

```yaml
---
cpn-type: routing-action        # required — marks this note as a routing action
cpn-routing-action-name: my-action      # required — unique key; matches a built-in to override it
cpn-routing-action-kind: move           # required — move | set-frontmatter | publish-contexts | insert-template | code
cpn-description: "..."          # optional — shown in settings + the suggester
cpn-routing-new-note-only: false        # optional — skip in update mode (default false)
cpn-routing-idempotent: true            # optional — if false, skip in update mode (default true)
# --- kind-specific ---
cpn-routing-target-dir: "log"           # move
cpn-publish-contexts: [public]  # publish-contexts
cpn-routing-template: "[[My Template]]" # insert-template
cpn-routing-frontmatter:                # set-frontmatter
  status: draft
---
```

A `code` action additionally has a single ```` ```ts ```` fence whose body runs
as an async function with `(libs, context, app, utils)` in scope (same contract
as [parser stages](parser-extensions.md#authoring-a-stage) — no `import`s).

### Capability flags

Two flags control what runs when you **re-route** an existing note
(**update** mode):

- **`cpn-routing-new-note-only`** (default `false`) — when `true`, the action runs only
  in create mode. Use it for anything that seeds one-time content (e.g.
  `insert-template`).
- **`cpn-routing-idempotent`** (default `true`) — when `false`, the action is skipped in
  update mode because re-running it would clobber (it's not safe to repeat).

## Authoring an option

An option is a Markdown file in `<cpnDir>/routes/options/`. Its `cpn-routing-steps` list
is the ordered pipeline:

```yaml
---
cpn-type: routing-option        # required
cpn-routing-option-name: "My Option"    # required — shown in the suggester
cpn-description: "..."          # optional
cpn-routing-on-error: abort             # optional — abort | continue (default abort)
cpn-routing-title-prompt: only-if-Untitled  # optional — always | only-if-Untitled | off
cpn-routing-steps:                      # required — the ordered pipeline
  - "[[ensure-uid]]"                                   # no params
  - "[[move]] dir: data"                               # one param
  - "[[set-publish-contexts]] contexts: public, local"  # a list param
---
```

Every step is a single **string** — a leading `[[action-name]]` wikilink,
optionally followed by `key: value` params. That keeps `cpn-routing-steps` a plain
list of text, so you can add, edit, and reorder steps in Obsidian's Properties
editor. The param grammar:

- **No params** — just the wikilink: `"[[ensure-uid]]"`.
- **Params** follow the wikilink as `key: value` pairs, separated by `;`:
  `"[[move]] dir: data"` or `"[[insert-template]] template: [[My Template]]; foo: bar"`.
  Params override the action's own declarative frontmatter for this step (e.g. a
  `dir` param overrides `cpn-routing-target-dir`).
- **List values** — a value containing a comma becomes a list:
  `"[[set-publish-contexts]] contexts: public, local"`.

A couple of limits: a value can't itself contain `;` (the param separator) and a
value with a `,` always becomes a list. If you need a per-step `set-frontmatter`
override (a nested mapping), author a `set-frontmatter` **action file** with a
`cpn-routing-frontmatter` block and reference it instead — the string syntax can't
express a nested object.

**Ordering matters** — steps run top to bottom. **`cpn-routing-on-error`** decides what
happens when a step fails: `abort` stops the option (default); `continue` logs
the error and runs the rest. **`cpn-routing-title-prompt`** overrides the global
[Title prompt](settings.md) default for this option.

## Running a template (`insert-template`)

The `insert-template` action runs one of your existing
[Templater](https://github.com/SilentVoid13/Templater) templates against the
routed note: it merges the template's frontmatter and appends its rendered body.
Point `cpn-routing-template` at a template file (a path or a `[[wikilink]]`); an option
can also override it per step with `params.template`.

```yaml
---
cpn-type: routing-action
cpn-routing-action-name: insert-meeting-template
cpn-routing-action-kind: insert-template
cpn-routing-template: "[[meeting-note-template]]"
cpn-routing-new-note-only: true
---
```

**Placement decides behavior** — there's no separate "mode":

- **Redirect** — make `insert-template` the option's **only** step. The template
  owns everything (naming, frontmatter, folder, body) because nothing else runs.
  This is how you hand a whole note type to a template you already have:

  ```yaml
  ---
  cpn-type: routing-option
  cpn-routing-option-name: "Meeting"
  cpn-routing-title-prompt: off
  cpn-routing-steps:
    - "[[insert-meeting-template]]"
  ---
  ```

- **Append** — place `insert-template` **after** other steps. It renders onto
  whatever they produced. List several `insert-template` steps if you like; they
  run in order.

  ```yaml
  cpn-routing-steps:
    - "[[move]] dir: data"
    - "[[set-publish-contexts]] contexts: public"
    - "[[insert-data-template]]"
  ```

Things to know:

- **Requires Templater.** If the Templater plugin isn't installed/enabled, the
  step is **skipped with a Notice** — it does not abort the option.
- **Template parse errors don't abort.** If the template itself fails to parse,
  Templater shows its own error Notice and leaves the note unchanged. Because
  Templater handles that internally, it does **not** trip `cpn-routing-on-error`. (A
  *missing* template file is different — that aborts under `cpn-routing-on-error: abort`.)
- **Frontmatter merge.** List-valued keys (like `cpn-publish-contexts`) are
  unioned and de-duped, so values set by earlier steps survive. Scalar keys the
  template also sets are overwritten by the template — order the step accordingly.
- **Titles.** If the template renames the note itself, pair the option with
  `cpn-routing-title-prompt: off` so CPN's title prompt doesn't fight it.
- **Update mode.** Defaults to `cpn-routing-new-note-only: true`, so re-routing an
  existing note skips it (no duplicate body). Set `cpn-routing-new-note-only: false` to
  also run on update.

## Assigning a UID (`ensure-uid`)

The `ensure-uid` action gives the routed note a **`cpn-uid`** — the stable
Crockford-Base32 identifier that backs its published URL. Add it as a step to
mint the id as part of routing, rather than waiting for the id to be created
lazily at publish time:

```yaml
cpn-routing-steps:
  - "[[move]] dir: /"
  - "[[ensure-uid]]"
  - "[[set-publish-contexts]] contexts: public"
```

Things to know:

- **Never overwrites.** If the note already has a `cpn-uid`, it's left untouched
  (the id must stay stable). So re-routing an existing note is a no-op when one is
  already present.
- **Unconditional.** The id is minted whenever the step runs, regardless of
  publish contexts. Place `ensure-uid` **before** `set-publish-contexts` if you
  want the id to exist by the time the note is opted into publishing.
- **Written immediately.** The id is flushed to frontmatter right away (not queued),
  so it's durably on disk before any later step runs.
- **Length.** The id uses the vault's configured UID length (see
  [Settings](settings.md)). Zero-config otherwise — no kind-specific frontmatter or
  step params.

From a `code` action you can do the same thing via the toolkit:
`const uid = await libs.ensureUid(context.file);` (returns the existing id if
present, else mints, writes, and returns a new one).

## Overriding a built-in action

Give your action the **same name** (`cpn-routing-action-name`) as a built-in and
your file wins. Delete the file (or use **Reset** in settings) to restore the
built-in — the built-in always runs as an in-memory fallback when no vault file
overrides it.

Materialize a built-in action to edit it via the per-item **Open** button in
**Settings → Note routing**, or the **Export all routing actions & options to
vault** command (writes every built-in action to `<cpnDir>/routes/`).

## Troubleshooting

If an action or option doesn't load, or the settings tab reports routing errors,
see [Troubleshooting → Note routing](troubleshooting.md#note-routing).
