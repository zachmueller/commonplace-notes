# Commonplace Notes

Commonplace Notes (CPN) is an Obsidian plugin that publishes a curated subset of
your vault as a fast, **stacked-panes** static site — the kind where clicking a
link opens the target note in a new column beside the current one, so a reader
can follow a train of thought without losing their place. Sites are self-hosted
on AWS (S3 + CloudFront), notes are **private by default** (nothing publishes
until you opt a note in), each note gets a stable per-note UID that drives its
URL, and the Markdown→HTML pipeline is fully user-extensible. CPN is desktop-only.

<!-- SCREENSHOT: a published stacked-panes site -->

## Status

Beta (`0.2.0`, requires Obsidian `1.0.0`+). Installed and updated via
[BRAT](https://github.com/TfTHacker/obsidian42-brat). See
[Getting started](docs/getting-started.md) for the full install + first-publish
walkthrough.

## Quick start

The 60-second path (assumes the plugin is installed and enabled):

1. Open **Settings → Commonplace Notes** and confirm the default profile.
2. Deploy AWS infrastructure with the **Deploy publishing infrastructure**
   command (or point the profile at an existing bucket). See
   [Infrastructure deployment](docs/infrastructure-deployment.md).
3. Open a note and run **Toggle publishing context: <profile>** to opt it in
   (this adds the profile to `cpn-publish-contexts`; a `cpn-uid` is generated
   automatically).
4. Run **Publish current note**.
5. Run **Copy link to current note URL** and open it in a browser.

New here? [Getting started](docs/getting-started.md) walks through all of this in
detail.

## Documentation

- [Getting started](docs/getting-started.md) — install (BRAT + source) and your first publish
- [Concepts](docs/concepts.md) — glossary of the core ideas
- [Commands](docs/commands.md) — every command in the palette
- [Settings](docs/settings.md) — every setting, with defaults
- [Publishing model](docs/publishing-model.md) — contexts, profiles, UIDs, URLs, invalidation
- [Infrastructure deployment](docs/infrastructure-deployment.md) — provision AWS from inside Obsidian
- [Authentication & access](docs/auth-and-access.md) — read-gating, sign-in, and commenting
- [Site asset customizations](docs/site-asset-customizations.md) — inject per-profile snippets
- [Parser extensions](docs/parser-extensions.md) — extend the Markdown→HTML pipeline
- [Troubleshooting](docs/troubleshooting.md)

## Key concepts at a glance

- **Publishing profile** — a named publish target (bucket, base URL, infra, look
  & feel). Multiple profiles let one vault feed multiple sites.
- **Publish context** — a profile ID listed in a note's `cpn-publish-contexts`;
  it's how a note opts in to a site.
- **UID** — a stable per-note identifier (`cpn-uid`) that drives the site URL,
  generated the first time a note gains a publish context.
- **Stacked URLs** — links that open several notes side by side in one view.

Full definitions in the [concept glossary](docs/concepts.md).

## Building from source

Contributors (end users should use BRAT):

```sh
nvm use          # Node 24 (see .nvmrc)
npm install
npm run build    # tsc typecheck + esbuild production bundle → main.js
npm run dev      # esbuild watch mode
```

The build emits `main.js`; the plugin ships `main.js`, `manifest.json`, and
`styles.css`. Note the npm package name is `commonplace-notes-publisher`, but the
Obsidian plugin ID (in `manifest.json`, and used at
`app.plugins.plugins['commonplace-notes']`) is `commonplace-notes`.

## Contributing & license

Contributions are welcome — open an issue or PR at
[zachmueller/commonplace-notes](https://github.com/zachmueller/commonplace-notes).

Licensed under the [MIT License](LICENSE).
