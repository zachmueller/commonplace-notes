# Commands

All Commonplace Notes commands live in Obsidian's command palette (`Ctrl/Cmd-P`).
Some are context-sensitive and only appear when a Markdown note is active.

## Core commands

| Command | What it does | Preconditions |
|---------|--------------|---------------|
| **Refresh credentials** | Refreshes AWS credentials for a chosen profile (runs the profile's custom refresh commands, if configured). | — |
| **Export all parser stage definitions to vault** | Materializes every built-in parser stage as an editable `.md` file under `<cpnDir>/parsers/`. | — |
| **Export all routing actions & options to vault** | Materializes every built-in routing action and option as an editable `.md` file under `<cpnDir>/routes/`. See [note routing](note-routing.md). | — |
| **Route new note** | Files the active note via a routing option you pick (move, seed frontmatter, publish contexts, run a template…). Runs in create mode. See [note routing](note-routing.md). | Active Markdown note. |
| **Route existing note** | Re-files an already-filed note via a routing option. Runs in update mode (skips new-note-only steps). | Active Markdown note. |
| **Publish current note** | Publishes just the active note. | Active Markdown note; note must be in a publish context. |
| **Publish active and connected notes** | Publishes the active note plus the notes it links to and that link to it. | Active Markdown note. |
| **Publish updates since last full publish** | Publishes notes modified since the profile's last full publish. | — (prompts for profile). |
| **Publish all notes** | Publishes every note in the chosen profile's publish context. | — (prompts for profile). |
| **Delete a published note** | Removes a published note from the site (choose it from a list). | AWS profile. |
| **Copy link to current note URL** | Copies the active note's site URL to the clipboard. Invoked repeatedly within the URL-stack window, it appends each note to a growing [stacked URL](publishing-model.md#url-scheme-and-stacked-urls). | Active note in a publish context; profile needs a Base URL. |
| **Copy open notes as stacked URL** | Builds one stacked URL from all notes open in the main editor area, in tab order. | Requires the `current` URL scheme; needs open notes with publish contexts. |
| **Deploy publishing infrastructure** | Opens the deployment wizard to provision AWS infra (S3 + CloudFront, optional domain/auth/comments). See [Infrastructure deployment](infrastructure-deployment.md). | — (prompts for profile). |
| **Destroy publishing infrastructure** | Tears down the CloudFormation stacks for a profile (the S3 bucket is retained). | Profile with a plugin-deployed stack. |

Commands marked "Active Markdown note" use Obsidian's `checkCallback`, so they
only appear enabled when a note is focused.

## Per-profile commands

Each publishing profile gets its own dynamically-registered command:

- **Name:** `Toggle publishing context: <profile name>`
- **What it does:** adds or removes that profile's ID from the active note's
  `cpn-publish-contexts` frontmatter (opting the note in or out of that site).

These are re-registered automatically whenever you add, rename, or change the ID
of a profile.

## Console helpers (not commands)

A few maintenance utilities are **not** in the palette — run them from the
Obsidian developer console (`Ctrl/Cmd-Shift-I`) via the plugin instance:

```js
const cpn = app.plugins.plugins['commonplace-notes'];

cpn.fixPublishContextsFormat();   // repair notes where cpn-publish-contexts is a string, not a list
cpn.rebuildContentIndex();        // rebuild the search content index for a profile
cpn.bulkUpdatePublishContexts();  // add/remove publish contexts across many notes by directory
```

`fixPublishContextsFormat()` is the fix CPN points you to when it detects a note
whose `cpn-publish-contexts` was written as plain text instead of a list — see
[Troubleshooting](troubleshooting.md#publishing).
