# Getting started

This guide takes you from zero to a published note: install the plugin, set up a
publish target, opt a note in, and publish it.

## Requirements

- **Desktop Obsidian** (`1.0.0` or newer). Commonplace Notes is desktop-only — it
  uses Node/AWS SDK APIs that aren't available on mobile.
- **An AWS account** for the default (AWS) publish mechanism, plus an AWS
  credentials profile configured locally (`~/.aws/credentials`, `~/.aws/config`,
  or SSO). The plugin can provision all the infrastructure for you — see
  [Infrastructure deployment](infrastructure-deployment.md).
- **Node ≥24** only if you build from source (contributors).

## Install with BRAT (recommended)

CPN is distributed as a beta plugin through
[BRAT](https://github.com/TfTHacker/obsidian42-brat) (Beta Reviewer's
Auto-update Tool), which installs it from GitHub and keeps it up to date.

1. In Obsidian, open **Settings → Community plugins**, browse for **BRAT**,
   install it, and enable it.
2. Open BRAT's settings and choose **Add beta plugin**.
3. Paste the CPN repository URL: `https://github.com/zachmueller/commonplace-notes`
4. BRAT downloads the latest release and installs the plugin. Enable
   **Commonplace Notes** under **Settings → Community plugins**.

BRAT auto-updates the plugin when new releases are published. Releases are built
by the repo's `.github/workflows/release.yml` (on each version tag) and contain
`main.js`, `manifest.json`, and `styles.css` — exactly what BRAT consumes.

> **Maintainer note:** the release workflow creates a **draft** GitHub release.
> BRAT can only fetch **published** releases, so the maintainer must publish each
> draft before BRAT will pick it up.

<!-- SCREENSHOT: BRAT "Add beta plugin" dialog -->

## Install from source (contributors)

```sh
git clone https://github.com/zachmueller/commonplace-notes
cd commonplace-notes
nvm use          # Node 24 (see .nvmrc)
npm install
npm run build    # typecheck + esbuild production bundle
```

Then copy `main.js`, `manifest.json`, and `styles.css` into
`<your-vault>/.obsidian/plugins/commonplace-notes/` and reload Obsidian (or
enable the plugin if it's the first time). Use `npm run dev` for an esbuild watch
build while developing.

## Your first publish

Commonplace Notes ships with one **publishing profile** (ID `default`), and notes
are **private by default** — nothing publishes until you opt it in.

1. **Set up a publish target.** Open **Settings → Commonplace Notes → Publishing
   profiles**. Either run the **Deploy publishing infrastructure** command to
   provision an S3 bucket + CloudFront distribution (walkthrough:
   [Infrastructure deployment](infrastructure-deployment.md)), or fill the
   profile's **S3 bucket**, **region**, and **Base URL** in by hand if you
   already have a bucket.

2. **Opt a note in.** Open a note and run the command **Toggle publishing
   context: Default AWS Profile** (each profile gets its own toggle command).
   This adds the profile's ID to the note's `cpn-publish-contexts` frontmatter.

3. **Note the auto-generated UID.** The first time a note gains a publish
   context, CPN generates a stable `cpn-uid` for it (this drives the note's URL).
   Don't edit it by hand. See [Concepts](concepts.md) and the
   [publishing model](publishing-model.md).

4. **Publish.** Run **Publish current note**.

5. **Get the link.** Run **Copy link to current note URL** and open the copied URL
   in a browser. (Run it again on other open notes within a few seconds to build
   a [stacked URL](publishing-model.md#url-scheme-and-stacked-urls).)

<!-- SCREENSHOT: command palette showing the publish commands -->

## Next steps

- [Settings reference](settings.md) — tune UID length, excluded directories,
  search, site look & feel.
- [Publishing model](publishing-model.md) — profiles vs. contexts, incremental
  publishing, and how URLs work.
- [Authentication & access](auth-and-access.md) — gate reads behind a password
  or sign-in, and enable commenting.
- [Parser extensions](parser-extensions.md) — customize the Markdown→HTML
  pipeline.
