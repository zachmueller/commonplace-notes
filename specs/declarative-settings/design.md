# Spec: Declarative settings (`getSettingDefinitions()`)

Rebuild the plugin's settings tab on Obsidian's declarative settings API, so every
CPN setting shows up in Obsidian's settings search, and retire the deprecated
APIs the tab depends on. Raises `minAppVersion` to **1.13.1**.

**Checkboxes.** Tick a box when the change has merged with its tests. A phase is
done when all of its boxes are ticked.

## Problem

The 0.8.0 community-plugin review reported (Warning):

> This PluginSettingTab does not implement getSettingDefinitions(); its settings
> will not appear in Obsidian's settings search for users on 1.13.0 or later.

`CommonplaceNotesSettingTab` (`src/settings/index.ts`) renders everything
imperatively in `display()`, and `display()` is `@deprecated` since 1.13.0. On
1.13+, searching Obsidian's settings for "S3 bucket", "Cognito" or "Base URL"
finds nothing from CPN.

The same scan (with current `obsidian` typings) also reports six deprecated
`ButtonComponent.setWarning()` calls. The replacement, `setDestructive()`, is
`@since 1.13.0`, above today's `minAppVersion` of 1.8.7, so it couldn't be
adopted until the version floor moved.

## Goal

1. Every setting CPN shows today is reachable from Obsidian's settings search,
   with its name, description and a few aliases.
2. No change to what's stored. `data.json` keeps its current shape. No migration
   apart from dropping two UI-only fields (§5).
3. Zero `obsidianmd/settings-tab/prefer-setting-definitions` and
   `@typescript-eslint/no-deprecated` findings in `npm run lint`.
4. The tab keeps every capability it has now: per-profile settings, AWS-only
   sections, the deploy/destroy flows with live event logs, theme color
   overrides, named styles, access groups, and parser/routing extension
   listings.

## Non-goals

- Redesigning the deployment wizard, DNS assistant, import, password-gate or
  auth-Lambda modals. They open from settings rows exactly as now.
- Changing any setting's default or meaning.
- Supporting Obsidian < 1.13.1. Users on older versions stay on the last
  release whose `versions.json` entry allows them (0.8.x).

## Decisions

### 1. `minAppVersion` → 1.13.1

1.13.0 adds `getSettingDefinitions()`, `setDestructive()` and
`ConfirmationModal`. 1.13.1 adds the pieces this design leans on for profiles:
`SettingDefinitionPage.displayValue` / `status` (show a profile's mechanism or
domain, and flag a profile that needs attention, without opening it), and group
`search` (filter long lists). Taking 1.13.1 instead of 1.13.0 costs nothing
extra, because both are past the point where every user of the declarative
API lands anyway.

Update `manifest.json`, add the `versions.json` row in the release that ships
this, and change the "1.8.7" references in `README.md`,
`docs/getting-started.md` and `docs/publishing-model.md`.

### 2. No `display()` fallback

Because 1.13.1 is the floor, the tab implements only `getSettingDefinitions()`.
`display()` is never called once that returns a non-empty array, so keeping it
would be dead code.

### 3. Control keys are paths; storage stays `plugin.settings`

Declarative `control` rows bind to a `key`. `PluginSettingTab`'s default
`getControlValue` / `setControlValue` read and write `this.plugin.settings[key]`
(flat). CPN's settings are nested, and per-profile, so the tab overrides both
with a path resolver:

| Key form | Resolves to |
|---|---|
| `general.<field>` | `settings.<field>` (e.g. `general.urlStackWindowSeconds`) |
| `profile.<ref>.<path>` | the profile object with that **session ref** (not index, not `id`), then `<path>` (e.g. `profile.r3.awsSettings.bucketName`) |

- Profiles are addressed by a **session ref**: a `RefRegistry` (WeakMap
  object → ref) hands each profile object a ref that lasts for the settings
  session. Not by index, because indexes shift when a profile is deleted; and
  not by `profile.id`, because Profile ID is itself an editable text control
  that writes on every keystroke (P0), so the first keystroke would orphan the
  key for the second. The same registry gives access-group and named-style
  objects refs for their sub-pages; renames re-key the record but keep the
  object, so refs survive.
- Path segments are escaped (`%` → `%25`, `.` → `%2E`) since style names and
  ids may contain dots; numeric segments index arrays (header links).
- New module `src/settings/keys.ts`: `parseKey`, `buildKey`, `getAtPath`,
  `setAtPath`, `RefRegistry`. Obsidian-free, so it gets a tsx unit test.
- `text`/`textarea` controls write per keystroke (P0), so `setControlValue`
  updates memory immediately and debounces `plugin.saveSettings()`, flushing
  in `hide()` and on unload.
- `setControlValue` writes, runs the key's **on-set hook** if one is
  registered, then calls `plugin.saveSettings()`. Hooks hold today's
  side effects that aren't plain assignment:
  - `awsSettings.s3Prefix`: append a trailing `/`.
  - `name`: needs `update()` so the profile list and page title follow.
  - `publishMechanism`, `awsSettings.credentialMode` and other toggles that
    change which rows exist: `refreshDomState()` when only `visible` predicates
    change, `update()` when the set of definitions changes.
  - Excluded directories: re-run the existing normalization.
- `validate` is used only to reject input (e.g. non-numeric MB, invalid group
  names), never to transform it.

### 4. Navigation: pages replace the tab bar, the dropdown and `<details>`

| Today | Declarative |
|---|---|
| Custom tab bar (General / Markdown parser / Note routing / Publishing profiles) | General settings as top-level groups; the other three as `type: 'page'` entries |
| "Active profile" dropdown + "Add profile" button | A `type: 'list'` "Publishing profiles" whose items are one `page` per profile; `addItem` creates a profile; `displayValue` shows the mechanism or site domain; `status: 'warning'` when the profile has no deployed infrastructure or a misconfigured context |
| Collapsible `<details>` subsections (`createSection`) | Groups on the profile page. Rarely used or heavy sections become sub-pages: Danger Zone, Deploy hooks, Access groups, Named styles, Theme color overrides |
| AWS-only sections spawned by `renderDestinationSection` | Groups with `visible: () => profile.publishMechanism === 'AWS'` |

Profile deletion stays in the Danger Zone with its confirmation. The list does
**not** set `onDelete`, because a one-key delete of a deployed profile is too
easy to hit by accident. (Page rows in a list get no X button, but a focused
row's Delete key still calls `onDelete`, per P0.)

**Stable page names (public API only).** Obsidian finds the open sub-page
again after `update()` by its path of page names (P0); a renamed page renders
empty, and two sibling pages with the same name both open the first. So page
names for profiles, access groups and named styles come from a per-session
**name snapshot** (`src/settings/pageNames.ts`), keyed by session ref:

- Sibling names are de-duplicated with a ` (2)` suffix.
- A rename updates the data immediately but the page title / list label only
  when the snapshot clears, in the tab's `hide()` (then `update()`).
- A removed profile, group or style leaves a **tombstone**: its page stays in
  the definitions with `visible: false` (still resolvable, P0) and one row
  saying it was removed, until `hide()`.

### 5. Retired UI state

`SettingsUiState.activeTab` and `collapsedSections` exist only to make the
custom tab bar and `<details>` survive full re-renders. Obsidian's page
navigation replaces both, so remove the fields from `src/types.ts`. On load,
delete them from `settings.settingsUiState`, and drop the object if it ends up
empty. Nothing outside `src/settings/index.ts` and the e2e scripts reads them.

One related refresh path changes too: `DeploymentWizardModal.refreshSettingsTab()`
re-renders the tab through Obsidian's internal `app.setting.activeTab.display()`.
A declarative tab doesn't redraw from `display()`, so this becomes
`plugin.settingTab.update()`.

### 6. What stays imperative

Some rows aren't a single control. They use `render: (setting, group) => …`,
which gets a real `Setting` row and may return a cleanup function, or a custom
`SettingPage` via `page: () => new XPage(...)`:

| Area | Approach |
|---|---|
| Infrastructure status block (stack/domain/origin/edge rows, deploy & update buttons, DNS assistant, import, unlink) | `render` rows; text fields that are plain values become `control` rows |
| Live event logs (Cognito gate, session length, bucket cleanup, destroy, force-clean) | `render` row that owns its log element and returns a cleanup |
| Theme color overrides (light/dark × field, each with reset) | `control: { type: 'color' }` per field; reset is an `extraButton` in a `render` row if `color` controls can't carry one |
| Header links, Access groups, Named styles | `type: 'list'` with `addItem` / `onDelete` (no destructive side effects there) and per-item pages where an item has several fields |
| Parser / routing extension listings and their error panels | `render` rows (they show discovered files, not settings) plus `action` rows for Reset / Export |

Every `render` or `action` row still sets `name`, `desc` and `aliases`, so it
is found by search even though its body is imperative.

### 7. `setWarning()` → `setDestructive()`

| Site | Button | Becomes |
|---|---|---|
| `src/main.ts` `confirmDestroyInfrastructure` | Destroy | `setDestructive().setCta()`: it's the modal's primary action |
| `src/settings/profile/dangerZone.ts` (force-clean confirm) | Force-clean | `setDestructive().setCta()` |
| `src/settings/profile/accessGroups.ts` (remove-group confirm) | Remove | `setDestructive().setCta()` |
| `src/settings/profile/accessGroups.ts` (group row) | Remove group | `setDestructive()` |
| `src/settings/profile/siteCustomization.ts` (named style) | Remove style | `setDestructive()` |
| `src/settings/modals/authLambdaModal.ts` | Detach anyway (gated notes become public) | `setDestructive()` |

The three confirmation dialogs are hand-built `Modal`s. Converting them to
`ConfirmationModal` (1.13.0) is optional (§P1.4); it fits them well and
removes about 15 lines each.

### 8. Search aliases

Give rows the terms people actually search: e.g. bucket name → `S3`; invalidation
→ `CloudFront`, `cache`; Cognito gate → `sign-in`, `login`, `Google`; password
gate → `password`; excluded directories → `ignore`, `folders`. Profile pages
get the profile name, so a search hit reads as "<profile> › Base URL".

## Phases

The phases rely on one property of the API: as soon as
`getSettingDefinitions()` returns a non-empty array, `display()` is no longer
called. So the change can't go file by file inside `display()`. Instead
**phase 1 ships the new shell with adapter pages** that run today's
imperative renderers unchanged, and later phases replace one adapter at a time
with declarative items. Each phase leaves the tab fully working.

### P0: Spike (no merge)

Run against Obsidian 1.13.1+ through the e2e harness (see the
`settingsPopoutWindow` note in `e2e/lib/test-helpers.ts`'s `ensureAppConfig`),
and record answers here before P1:

Answers (Obsidian 1.15.1, read from the bundle and confirmed with a scratch tab
in the harness, 2026-11-26):

- [x] Does `update()` keep the user on the current sub-page, or does it pop back
      to the root? **It stays.** `update()` re-displays the top page in place
      (scroll kept), re-finding it by its path of page `id ?? name`. A renamed
      page renders empty with its old title; a page with `visible: false` still
      resolves; duplicate sibling names resolve to the first. Hence session refs
      (§3) and stable page names (§4). Custom `page: () => SettingPage` pages are
      not refreshed by `update()` and are not search-indexed.
- [x] Is there a public or internal way to open the tab **on a given page**?
      Only internal (`app.setting.openPagePath(tabId, names[])`, untyped).
      Decision: public API only, so `openProfileSettings` uses the fallback
      (open the CPN tab and show a `Notice` naming the profile).
- [x] How do search results label rows that sit inside a per-profile page?
      Grouped under the innermost page name (`.setting-search-result-tab-label`)
      with the tab name as sublabel; two profiles' "Base URL" rows appear under
      their profile names. Clicking navigates into the page and flashes the row
      (`is-flashing`). Sub-pages (e.g. Danger Zone) are labeled by their own
      name only.
- [x] When does a `text` control call `setControlValue`: per keystroke or on
      commit? **Per keystroke** (also `textarea`); `number` on blur/Enter with
      `min`/`max` enforced; `color` on `change`. The framework calls
      `refreshDomState()` after every write. So `saveSettings` is debounced.
- [x] Can a `color` control carry an extra "reset" button, or does reset need a
      `render` row? **Built in:** `color` (and `slider`) controls get a "Restore
      default" button whenever `defaultValue` is set. No other per-control
      extra-button hook exists.

Harness selectors: settings search `input[type=search]` ("Search settings...");
results `.setting-search-result-group` / `-tab-label` / `.setting-search-result-item`;
page title `.setting-page-title`, back `.setting-page-back-button`; navigable
rows `.setting-item.mod-navigable`; group headings `.setting-item-heading`;
lists `.setting-group.mod-list`. `app.setting.openTabById(id)` resets to the
tab root.

### P1: Version floor, deprecations, shell

1. [x] `manifest.json` `minAppVersion` → `1.13.1`; update the three doc
       references (§1). (The `versions.json` row is added by `/release`.)
2. [x] Replace all six `setWarning()` calls per §7.
3. [x] `src/settings/keys.ts` (§3) + `e2e/scripts/test-settings-keys.ts`
       (parse, get, set, unknown profile id, nested create) +
       `npm run test:settings-keys`.
4. [x] *(Optional)* The three confirmation dialogs → `ConfirmationModal`.
5. [x] `getSettingDefinitions()` returns the §4 structure. Each page's body is
       a `LegacyPage extends SettingPage` whose `display()` calls the existing
       renderer (`renderGeneralTab`, `renderParserTab`, `renderRoutingTab`,
       `displayProfileSettings`) with a context whose `rerenderAll` /
       `rerenderProfile` re-run that page's `display()`. Delete the tab bar,
       profile dropdown and `display()`. *(General went straight to `control`
       rows, P2's first box; `rerenderAll` also rebuilds the definitions, and
       the tab's `refresh()` redraws the adapter on screen, since `update()`
       doesn't redraw custom pages.)*
6. [x] `getControlValue` / `setControlValue` overrides wired to `keys.ts`
       (unused until P2, but tested).
7. [x] `DeploymentWizardModal.refreshSettingsTab()` → `plugin.settingTab.refresh()`
       (`update()` plus a redraw of any adapter page on screen) (§5); today's
       internal `activeTab.display()` call no longer redraws.
8. [x] `npm run lint`: `prefer-setting-definitions` and `no-deprecated` are gone.

Shippable: search finds the top-level entries and profile pages, not yet the
rows inside adapter pages.

### P2: General, Markdown parser, Note routing

- [x] General tab rows (UID length, Debug mode, URL stack window) → `control`
      rows (`general.*` keys); `validate` for the numeric ranges. *(Done in P1.)*
- [x] Parser page: CPN directory → `control`; extension listing and errors →
      `render`; reset/export → `action`.
- [x] Routing page: same pattern. *(Per-file "overridden" state and load
      errors are read inside `render` / `visible`, which run on every page
      render; `getSettingDefinitions()` only runs on `update()`, so build-time
      values would go stale while Settings is closed.)*
- [x] Remove `renderGeneralTab` / `renderParserTab` / `renderRoutingTab`
      adapters.

### P3: Profile basics

- [x] Profile Identity, Content (incl. Attachments (Beta) and Excluded
      directories), Destination, Authentication & Delivery as groups of
      `control` rows with `profile.<ref>.*` keys and the §3 on-set hooks.
- [x] AWS-only `visible` predicates; credential-mode-dependent rows.
- [x] Home-note picker: `control: { type: 'file' }` if it filters to Markdown
      acceptably, otherwise keep `HomeNoteSuggestModal` behind an `action` row.
      *(`file` control: the sync filter offers Markdown files the profile
      doesn't exclude; an async `validate` rejects notes whose
      `cpn-publish-contexts` lack the profile, matching what Browse offered.)*
- [x] `displayValue` / `status` on profile pages (§4). *(`displayValue`: the
      base URL's host, else the mechanism. `status: 'warning'`: an AWS profile
      with no bucket or region yet, or whose last deploy failed. Misconfigured
      publish contexts are tracked vault-wide, not per profile, so they don't
      feed `status`.)* The not-yet-converted areas (Infrastructure, Site
      Customization, Deploy hooks, Access groups, Danger Zone) are `LegacyPage`
      sub-pages until P4.

### P4: Profile advanced

- [ ] Infrastructure group (§6) incl. Cognito/session-length/bucket-cleanup
      event-log rows.
- [ ] Site Customization: plain fields → `control`; Header links → `list`;
      Theme color overrides and Named styles → sub-pages (§6).
- [ ] Access groups → sub-page with a `list` of groups.
- [ ] Deploy hooks → sub-page.
- [ ] Danger Zone → sub-page; delete-profile, destroy and force-clean keep
      their confirmations.
- [ ] Remove the profile adapter and `displayProfileSettings`.

### P5: Cleanup

- [ ] Remove `SettingsContext.createSection`, `rerenderAll`, `rerenderProfile`,
      `updateProfileDropdownLabel` (replace remaining callers with
      `tab.update()` / `tab.refreshDomState()`), and `LegacyPage`.
- [ ] Drop `SettingsUiState.activeTab` / `collapsedSections` and strip them on
      load (§5).
- [ ] Delete the CSS for `.cpn-settings-tabs`, `.cpn-settings-tab*`,
      `.cpn-settings-section*`, `.cpn-active-profile-container`; keep any rules
      still used by `render` rows.
- [ ] `docs/settings.md` describes the new page/group layout, with setting
      names unchanged.

## Tests

- **Unit (tsx):** `test:settings-keys` (P1.3).
- **Playwright:** rewrite `e2e/tests/settings-tabs.spec.ts`. Today it asserts
  the tab bar, `details.cpn-settings-section` and Danger Zone starting
  collapsed. New assertions:
  1. Top-level pages exist.
  2. Opening a profile page shows its groups.
  3. Obsidian's settings search for "S3 bucket" returns the CPN row and opens
     it.
  4. Switching a profile to Local hides the AWS groups.
  5. Danger Zone is a sub-page, not an inline group.
- **Harness scripts:** update `e2e/scripts/test-settings-profile-sections.ts`,
  `test-excluded-directories-e2e.ts` and `deployment-variants-e2e.ts`, which
  query `.cpn-settings-section-summary` / `.cpn-profile-container` or read
  `settingsUiState`.
- **Regression:** the full tsx suite (see `/plugin-review` Verification) and a
  live sandbox deploy/destroy from the new Infrastructure and Danger Zone
  pages (`random` account only).

## Risks

- **`update()` resets navigation**: resolved in P0, it doesn't. It does
  re-find pages by name, which the stable-name snapshot (§4) handles.
- **Save churn.** `text` controls write per keystroke (P0); the debounce in
  `setControlValue` keeps `saveSettings` from running on every character.
- **Deep link loss**: confirmed (P0, public API only). The "configure
  profile" notice opens the CPN tab root and names the profile.
- **Harness drift.** Obsidian 1.13+ opens settings in a popout window by
  default; the e2e harness already forces `settingsPopoutWindow: false`
  (`ensureAppConfig`), and the new tests must keep relying on that.
