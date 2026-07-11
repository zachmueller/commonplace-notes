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

CPN ships built-in actions and options that work out of the box (they run from
memory even with no files in your vault). Materialize any of them to edit — see
[Overriding a built-in](#overriding-a-built-in).

## Built-in actions

| Name | Kind | What it does |
|------|------|--------------|
| `move` | `move` | Moves the note into a directory (backlinks update). Destination via `params.dir`. |
| `set-publish-contexts` | `publish-contexts` | Adds publish contexts (unioned with any existing). Contexts via `params.contexts`. |
| `default-frontmatter` | `code` | Seeds `created-at` (from the file's ctime) plus empty `tags`/`aliases`. New notes only. |
| `insert-template` | `insert-template` | Runs a [Templater](https://github.com/SilentVoid13/Templater) template against the note. See [below](#running-a-template-insert-template). |
| `code-example` | `code` | A starting point for your own `code` action — copy and edit. |

### Action kinds

Every action has a `cpn-action-kind`. The five kinds:

- **`move`** — relocate the note (link-preserving rename).
- **`set-frontmatter`** — merge a fixed frontmatter mapping (values may use the
  `$now` / `$ctime` sentinels).
- **`publish-contexts`** — add publish contexts (array-unioned, so it's safe to
  re-run).
- **`insert-template`** — run a Templater template. See
  [Running a template](#running-a-template-insert-template).
- **`code`** — run an embedded TypeScript/JavaScript body with a `libs` toolkit
  in scope (the escape hatch for anything the declarative kinds don't cover).

## Built-in options

- **Public (all)** — seed default frontmatter, keep at the vault root, publish to
  `public` + `amazon`.
- **Private** — seed default frontmatter, move to `private/`, no publish contexts.
- **Amazon-only** — seed default frontmatter, keep at the root, publish to
  `amazon` only.

## Authoring an action

An action is a Markdown file in `<cpnDir>/routes/actions/`. Its frontmatter
declares the kind and any kind-specific config:

```yaml
---
cpn-type: routing-action        # required — marks this note as a routing action
cpn-action-name: my-action      # required — unique key; matches a built-in to override it
cpn-action-kind: move           # required — move | set-frontmatter | publish-contexts | insert-template | code
cpn-description: "..."          # optional — shown in settings + the suggester
cpn-new-note-only: false        # optional — skip in update mode (default false)
cpn-idempotent: true            # optional — if false, skip in update mode (default true)
# --- kind-specific ---
cpn-target-dir: "log"           # move
cpn-publish-contexts: [public]  # publish-contexts
cpn-template: "[[My Template]]" # insert-template
cpn-frontmatter:                # set-frontmatter
  status: draft
---
```

A `code` action additionally has a single ```` ```ts ```` fence whose body runs
as an async function with `(libs, context, app, utils)` in scope (same contract
as [parser stages](parser-extensions.md#authoring-a-stage) — no `import`s).

### Capability flags

Two flags control what runs when you **re-route** an existing note
(**update** mode):

- **`cpn-new-note-only`** (default `false`) — when `true`, the action runs only
  in create mode. Use it for anything that seeds one-time content (e.g.
  `default-frontmatter`, `insert-template`).
- **`cpn-idempotent`** (default `true`) — when `false`, the action is skipped in
  update mode because re-running it would clobber (it's not safe to repeat).

## Authoring an option

An option is a Markdown file in `<cpnDir>/routes/options/`. Its `cpn-steps` list
is the ordered pipeline:

```yaml
---
cpn-type: routing-option        # required
cpn-option-name: "My Option"    # required — shown in the suggester
cpn-description: "..."          # optional
cpn-on-error: abort             # optional — abort | continue (default abort)
cpn-title-prompt: only-if-Untitled  # optional — always | only-if-Untitled | off
cpn-steps:                      # required — the ordered pipeline
  - "[[default-frontmatter]]"                                    # bare reference
  - { action: "[[move]]", params: { dir: "data" } }             # reference + params
  - { action: "[[set-publish-contexts]]", params: { contexts: ["amazon"] } }
---
```

Each step is one of:

- **a bare wikilink** — `"[[action-name]]"` — run the action as-is.
- **a reference with params** — `{ action: "[[action-name]]", params: { … } }` —
  run the action, overriding its declarative config for this step. Params win
  over the action's own frontmatter (e.g. `params.dir` overrides
  `cpn-target-dir`).
- **an inline action** — `{ inline: { kind: "…", … } }` — define a one-off action
  right in the option, without a separate file.

**Ordering matters** — steps run top to bottom. **`cpn-on-error`** decides what
happens when a step fails: `abort` stops the option (default); `continue` logs
the error and runs the rest. **`cpn-title-prompt`** overrides the global
[Title prompt](settings.md) default for this option.

## Running a template (`insert-template`)

The `insert-template` action runs one of your existing
[Templater](https://github.com/SilentVoid13/Templater) templates against the
routed note: it merges the template's frontmatter and appends its rendered body.
Point `cpn-template` at a template file (a path or a `[[wikilink]]`); an option
can also override it per step with `params.template`.

```yaml
---
cpn-type: routing-action
cpn-action-name: insert-meeting-template
cpn-action-kind: insert-template
cpn-template: "[[meeting-note-template]]"
cpn-new-note-only: true
---
```

**Placement decides behavior** — there's no separate "mode":

- **Redirect** — make `insert-template` the option's **only** step. The template
  owns everything (naming, frontmatter, folder, body) because nothing else runs.
  This is how you hand a whole note type to a template you already have:

  ```yaml
  ---
  cpn-type: routing-option
  cpn-option-name: "Meeting"
  cpn-title-prompt: off
  cpn-steps:
    - "[[insert-meeting-template]]"
  ---
  ```

- **Append** — place `insert-template` **after** other steps. It renders onto
  whatever they produced. List several `insert-template` steps if you like; they
  run in order.

  ```yaml
  cpn-steps:
    - "[[default-frontmatter]]"
    - { action: "[[move]]", params: { dir: "data" } }
    - { action: "[[set-publish-contexts]]", params: { contexts: ["amazon"] } }
    - "[[insert-data-template]]"
  ```

Things to know:

- **Requires Templater.** If the Templater plugin isn't installed/enabled, the
  step is **skipped with a Notice** — it does not abort the option.
- **Template parse errors don't abort.** If the template itself fails to parse,
  Templater shows its own error Notice and leaves the note unchanged. Because
  Templater handles that internally, it does **not** trip `cpn-on-error`. (A
  *missing* template file is different — that aborts under `cpn-on-error: abort`.)
- **Frontmatter merge.** List-valued keys (like `cpn-publish-contexts`) are
  unioned and de-duped, so values set by earlier steps survive. Scalar keys the
  template also sets are overwritten by the template — order the step accordingly.
- **Titles.** If the template renames the note itself, pair the option with
  `cpn-title-prompt: off` so CPN's title prompt doesn't fight it.
- **Update mode.** Defaults to `cpn-new-note-only: true`, so re-routing an
  existing note skips it (no duplicate body). Set `cpn-new-note-only: false` to
  also run on update.

## Overriding a built-in

Give your action or option the **same name** (`cpn-action-name` /
`cpn-option-name`) as a built-in and your file wins. Delete the file (or use
**Reset** in settings) to restore the built-in — the built-in always runs as an
in-memory fallback when no vault file overrides it.

Materialize a built-in to edit it via the per-item **Open** button in
**Settings → Note routing**, or the **Export all routing actions & options to
vault** command (writes everything to `<cpnDir>/routes/`).

## Troubleshooting

If an action or option doesn't load, or the settings tab reports routing errors,
see [Troubleshooting → Note routing](troubleshooting.md#note-routing).
