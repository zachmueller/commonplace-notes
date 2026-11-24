# Getting started

This guide takes you from zero to a published note: install the plugin, set up a
publish target, opt a note in, and publish it.

## Requirements

- **Desktop Obsidian** (`1.8.7` or newer). Commonplace Notes is desktop-only — it
  uses Node/AWS SDK APIs that aren't available on mobile.
- **An AWS account** for the default (AWS) publish mechanism, plus an AWS
  credentials profile configured locally (`~/.aws/credentials`, `~/.aws/config`,
  or SSO). The plugin can provision all the infrastructure for you — see
  [Infrastructure deployment](infrastructure-deployment.md). AWS bills the
  resources it creates to your account.
- **Node 26** only if you build from source (contributors).

## Install from community plugins

CPN is listed in Obsidian's community plugin directory:
[Commonplace Notes](https://community.obsidian.md/plugins/commonplace-notes).

1. In Obsidian, open **Settings → Community plugins** and turn off Restricted
   mode if it's on.
2. Choose **Browse**, search for **Commonplace Notes**, and select **Install**.
3. Select **Enable**.

Obsidian checks for and installs updates like any other community plugin
(**Settings → Community plugins → Check for updates**).

<!-- SCREENSHOT: Commonplace Notes in the community plugin browser -->

## Install from source (contributors)

```sh
git clone https://github.com/zachmueller/commonplace-notes
cd commonplace-notes
nvm use          # Node 26 (see .nvmrc)
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
