# Troubleshooting

Symptom → cause → fix, grouped by area. For AWS infrastructure issues
(credentials, certificates, stack rollbacks), see the deployment doc's
[Troubleshooting section](infrastructure-deployment.md#troubleshooting).

## Publishing

- **"No publishing contexts defined for this note."** The note hasn't been opted
  into any profile. Run **Toggle publishing context: <profile>** (or add the
  profile's ID to `cpn-publish-contexts`). See the
  [publishing model](publishing-model.md#publish-contexts).
- **Notice about `cpn-publish-contexts` as text instead of a list.** The field
  was written as a plain string, not a YAML list. CPN keeps it working but won't
  rewrite it for you — open the developer console and run:
  ```js
  app.plugins.plugins['commonplace-notes'].fixPublishContextsFormat();
  ```
- **"No baseUrl defined for profile."** Copying a link needs the profile's **Base
  URL**. Set it under Destination, or **Sync settings from stack** after deploying
  infrastructure.
- **"Did not find UID for note."** A `cpn-uid` is generated only once a note has a
  publish context — opt the note in first, then retry.
- **Published content looks stale.** CloudFront cached the old version. Check the
  profile's [CloudFront invalidation scheme](publishing-model.md#publish-mechanism-and-cache-invalidation):
  if it's `manual`, or narrower than the publish command you ran, no invalidation
  fired. Re-publish with a broad enough command or invalidate manually.

## URLs and stacking

- **Stacked-URL commands do nothing / say they need the "Current" scheme.**
  Stacking only works under the `current` URL scheme. If you overrode `urlScheme`
  to `original` in `data.json`, switch it back.
- **"Copy link to current note URL" didn't append the note to a stack.** The
  URL-stack window expired between copies (default 10s — raise **URL stack window
  (seconds)** in General), or the note isn't in the same publish context as the
  stack, or it has no UID.

## Parser stages

- **My override / new stage didn't apply.** Stages are loaded per publish — run
  any publish command after editing. Confirm the file is in `<cpnDir>/parsers/`
  and has `cpn-type: parser`.
- **The settings tab shows "Parser extension errors."** One or more stages failed
  to load on the last publish. Open the developer console for the details. Common
  causes below.
- **A stage fails to compile.** Most often an `import` statement (not allowed —
  use the `libs` toolkit instead), or a TypeScript feature the stripper doesn't
  support (`enum`/`namespace`). See
  [Parser extensions → Authoring a stage](parser-extensions.md#authoring-a-stage).
- **"stage must return a unified plugin or [plugin, options]."** The code fence
  must `return` a plugin (or a `[plugin, options]` tuple). A stage that returns
  nothing or a plain value fails.
- **A built-in override broke rendering.** Delete your override file (or click
  **Reset** in settings) to restore the built-in, then re-publish.

## Authentication, access, and comments

Brief pointers — full detail in [Authentication & access](auth-and-access.md#troubleshooting-auth):

- **Google sign-in fails** — the authorized JavaScript origin / redirect URI in
  Google must exactly match what CPN shows under Authentication & Delivery.
- **Comments don't appear** — commenting requires Cognito comment identity, and
  the widget only renders after **Publish all notes** on a published note page.
- **Leftover stacks after destroy** — Lambda@Edge replicas take time to clear; use
  **Force-clean leftover infrastructure** in the Danger Zone.

For AWS credential errors, certificate validation, and stack rollbacks, see
[Infrastructure deployment → Troubleshooting](infrastructure-deployment.md#troubleshooting).

## Settings & config

- **A deprecated "AWS CLI Path" field is showing.** It's no longer used (the
  plugin uses the AWS SDK directly). You can clear it.
- **General debugging.** Turn on **Debug mode** in General for verbose logging to
  the developer console.
