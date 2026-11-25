# Commonplace Notes

Commonplace Notes (CPN) is an Obsidian plugin that publishes a curated subset of
your vault as a fast, **stacked-panes** static site — the kind where clicking a
link opens the target note in a new column beside the current one, so a reader
can follow a train of thought without losing their place. Sites are self-hosted
on AWS (S3 + CloudFront), notes are **private by default** (nothing publishes
until you opt a note in), each note gets a stable per-note UID that drives its
URL, and the Markdown→HTML pipeline is fully user-extensible. CPN is desktop-only.

<!-- SCREENSHOT: a published stacked-panes site -->

## Install

CPN is available in Obsidian's community plugin directory:
[Commonplace Notes](https://community.obsidian.md/plugins/commonplace-notes).

1. In Obsidian, open **Settings → Community plugins** and turn off Restricted
   mode if it's on.
2. Choose **Browse**, search for **Commonplace Notes**, and select **Install**.
3. Select **Enable**.

Updates arrive through Obsidian's normal community plugin updates.

**Requirements:** desktop Obsidian `1.8.7` or newer, and an AWS account with
credentials configured locally for the default (AWS) publish target. See
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

## Disclosures

- **Account required.** Publishing to the web needs your own AWS account. CPN
  has no hosted service of its own; your site and everything it serves live in
  your AWS account.
- **Paid services.** The AWS resources CPN deploys (S3, CloudFront, and
  optional extras such as sign-in, comments, and Lambda@Edge functions) are
  billed to your AWS account at AWS's rates. A small personal site typically
  costs little, but CPN doesn't control or cap these costs.
- **Network use.** CPN calls AWS APIs with your credentials to deploy
  infrastructure and upload published notes. The comments panel reads comment
  threads from your own site. The experimental **Local** publish mechanism
  downloads a default HTML template from this GitHub repository the first time it runs.
  CPN collects no telemetry or analytics.
- **Files outside your vault.** CPN reads your local AWS configuration
  (`~/.aws/config`, `~/.aws/credentials`, SSO cache) to find credentials.
- **Shell commands.** If you configure a custom credential refresh command, or
  use AWS SSO sign-in, CPN runs that command (or the `aws` CLI) on your
  machine.
- **Vault-wide file listing.** CPN lists the files in your vault to find the
  notes a publishing profile should include, resolve note UIDs and links, apply
  excluded-directory rules, and find attachments that are no longer referenced.
  Only notes you publish leave your machine.
- **Clipboard.** Copy buttons (published-note URLs, DNS records, sign-in
  settings) write to your clipboard. CPN never reads from it.

## Documentation

- [Getting started](docs/getting-started.md) — install and your first publish
- [Concepts](docs/concepts.md) — glossary of the core ideas
- [Commands](docs/commands.md) — every command in the palette
- [Settings](docs/settings.md) — every setting, with defaults
- [Publishing model](docs/publishing-model.md) — contexts, profiles, UIDs, URLs, invalidation
- [Infrastructure deployment](docs/infrastructure-deployment.md) — provision AWS from inside Obsidian
- [Authentication & access](docs/auth-and-access.md) — read-gating, sign-in, and commenting
- [Site asset customizations](docs/site-asset-customizations.md) — inject per-profile snippets
- [Note routing](docs/note-routing.md) — file a note in one command (move, frontmatter, publish contexts, templates)
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

For contributors (end users should install from the community plugin
directory):

```sh
nvm use          # Node 26 (see .nvmrc)
npm install
npm run build    # tsc typecheck + esbuild production bundle → main.js
npm run dev      # esbuild watch mode
```

The build emits `main.js`; the plugin ships `main.js`, `manifest.json`, and
`styles.css`. Note the npm package name is `commonplace-notes-publisher`, but the
Obsidian plugin ID (in `manifest.json`, and used at
`app.plugins.plugins['commonplace-notes']`) is `commonplace-notes`.

### Releases

Pushing a version tag runs `.github/workflows/release.yml`, which builds the
plugin and creates a **draft** GitHub release containing `main.js`,
`manifest.json`, and `styles.css`. Obsidian only picks up **published**
releases, so each draft must be published in the GitHub UI before the update
reaches users. The tag must exactly match `manifest.json`'s `version`.

## Contributing & license

Contributions are welcome — open an issue or PR at
[zachmueller/commonplace-notes](https://github.com/zachmueller/commonplace-notes).

If CPN is useful to you, you can
[buy me a coffee](https://buymeacoffee.com/zachmueller).

Licensed under the [MIT License](LICENSE).
