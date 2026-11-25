# Address Obsidian Plugin Review Feedback

Work through the findings from Obsidian's automated community-plugin review
(the scan shown on the plugin's page in the community directory) for Commonplace
Notes: reproduce them locally, fix what's worth fixing, and verify nothing
regressed.

**ARGUMENTS:** where the review results are: a note path, or pasted text. The
results are grouped as Releases / Behavior / Source code / Dependencies, each
item marked Error, Warning or Recommendation.

---

## How the scanner works

These facts come from the "Community plugin scanner configuration" section of
the `eslint-plugin-obsidianmd` docs
(`https://github.com/obsidianmd/eslint-plugin`, `docs/configuration.md`). The
docs aren't shipped in the npm package. Re-check them when the plugin version
changes.

- **It's ESLint with `obsidianmd.configs.recommended`.** `npm run lint`
  (`eslint.config.mjs`) spreads the same config over `src/`, `e2e/` and
  `infrastructure/`, so its output is the worklist. Keep
  `eslint-plugin-obsidianmd` in `package.json` on the version the scanner
  uses.
- **What it reads.** It skips `**/e2e/**`, `**/scripts/**`, `**/tests/**`,
  `*.test.*` / `*.spec.*`, `test-vault`, docs and tool configs (`eslint.config.*`,
  `esbuild.config.mjs`, `version-bump.mjs`). **`infrastructure/` is scanned.**
  Older scans also read `e2e/lib/`; the 0.8.0 review still did.
- **Its install.** It installs only the root `package.json`. `aws-cdk-lib` lives
  in `infrastructure/node_modules`, so in the scanner every CDK import is an
  error type. That produces hundreds of `no-unsafe-*` findings in
  `infrastructure/` that don't reproduce locally. They were accepted, not fixed;
  adding CDK to the root install wasn't worth it.
- **Disable comments.** It honors `eslint-disable` comments and doesn't report
  unused ones. But the recommended config forbids disabling
  `@typescript-eslint/no-explicit-any` (`eslint-comments/no-restricted-disable`),
  and every directive needs a `-- reason` (`eslint-comments/require-description`).
- **Unreported rules.** It reported no `no-base-to-string` /
  `restrict-template-expressions` findings, so those are off locally. src/
  deliberately uses `String(frontmatterValue)`.
- **Errors vs the rest.** Errors block approval; Warnings and Recommendations
  don't, but they show on the plugin page.

## Process

1. **Reproduce.** `npm install`, then `npm run lint`. Compare against the review:
   a finding in the review but not locally usually means a version mismatch
   (bump `eslint-plugin-obsidianmd`) or a scanner-only artifact (above).
2. **Triage.** Errors first, then `src/` Warnings (the shipped bundle), then
   infrastructure/, then the rest. Note which findings are false positives.
3. **Fix**, preferring a code change over a disable comment (patterns below).
4. **Verify** (below), then commit in atomic groups following
   `.claude/rules/git.md`: tooling, src/, dependencies, e2e/, infrastructure/,
   docs.

## Fix patterns that worked

| Finding | Fix |
|---|---|
| `no-unsanitized/method` "Unsafe call to …document().write" | False positive: the rule treats any `.write(x)` whose receiver text matches `/document/i` as `document.write`. Hold the receiver in a named local (`src/utils/markdownSourceMap.ts`). |
| `obsidianmd/no-global-this` on `globalThis.crypto` | Bare `crypto.subtle`. **Not** `window.crypto`: tsx suites (e.g. `test:lambda-zip`) run in Node, where `window` is undefined. `eslint --fix` suggests `window`, so check its output. |
| `only-throw-error` | `throw toError(err)` (`src/utils/logging.ts`). |
| `prefer-file-manager-trash-file` | `app.fileManager.trashFile(file)`. |
| `no-restricted-globals` `fetch` | `requestUrl({ url, throw: false })` + explicit status check. |
| `require()` import of `electron` | Avoid Electron: `window.open(url)` opens external URLs in the system browser. |
| no-console (`obsidianmd/rule-custom-message`) | Plugin code: `Logger.debug`/`info` already use `console.debug`. Node CLI scripts (`infrastructure/bin/*`): `process.stdout.write` / `process.stderr.write`. |
| `prefer-window-timers`, `.obsidian` configDir, no-console in `e2e/` | Node test code: the scanner no longer reads `e2e/`. Leave timers as Node globals; `window.*` would break. |
| `import/no-extraneous-dependencies` in `e2e/` | The nearest `package.json` is `e2e/package.json` (needed for `"type": "module"`); declare the import there as a devDependency. In `src/`, add the package to root `dependencies`. |
| `depend/ban-dependencies` | Replace (`builtin-modules` → `node:module`'s `builtinModules`) or drop if unused (`js-yaml`). |
| `no-unnecessary-type-assertion` | `eslint --fix`, then run `tsc`: the rule and `tsc` occasionally disagree (e.g. `querySelector` needs `querySelector<HTMLInputElement>`). |
| Unused `CfnCondition` / `CfnParameter` bindings in `infrastructure/` | Drop the `const x =` but keep the construct: it emits template content. |
| "Dependency has a potential vulnerability advisory" | `npm audit --omit=dev` is what matters. Align `@aws-sdk/*` on one version (`npm update` within ranges); this also shrank `main.js` 7.95 → 5.42 MB. Use `overrides` for a transitive fix a parent pins out of range (katex). |
| `no-deprecated` on an API whose replacement is newer than `minAppVersion` | Needs a `minAppVersion` bump first; `obsidianmd/no-unsupported-api` errors otherwise. Plan it (e.g. `specs/declarative-settings/`). |
| Behavior: fs / child_process / clipboard / vault enumeration | Not code fixes: keep the README **Disclosures** list accurate. |
| Releases: `main.js` > 5 MB | MathJax (`mathjax-full`, ~1.7 MB) is the largest remaining dependency; profile with an in-memory esbuild metafile build (`write: false`, `metafile: true`). |

## Verification

- `npm run lint`: 0 errors; only knowingly accepted warnings left.
- `npm run build`: tsc + esbuild. Note `main.js` size.
- tsx suites touching changed code. The broad set used for the 0.8.0 pass:
  `test:parser`, `test:lambda-zip`, `test:site-assets`, `test:attachments`,
  `test:attachment-upload`, `test:attachment-state`, `test:attachments-runtime`,
  `test:deploy-hooks`, `test:wikilinks`, `test:obscure-wikilinks`,
  `test:cert-match`, `test:domain-drift`, `test:site-config-matrix`,
  `test:access-client`, `test:publish-lock`, `test:bucket-lifecycle`,
  `test:auth-edge`, `test:password-edge`, `test:uid-resolver`,
  `test:excluded-directories`, `test:comment-sanitizer`.
- infrastructure/ changes: `npm run synth` and `npm run synth:site`, then confirm
  `src/infrastructure/templates.ts` and `src/publish/siteAssets.ts` are unchanged
  (`git status`) unless a template change was intended.
- e2e/ or runtime changes: `npm run e2e` and `npm run e2e:run:quick`. The first
  capture after a rebuild can report 0 log entries; rerun before investigating.
