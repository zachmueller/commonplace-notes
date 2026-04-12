# Write E2E Test Script

Write a new end-to-end test script for the Commonplace Notes Obsidian plugin. E2E tests launch the real Obsidian app, connect via Playwright + CDP, and exercise plugin behavior in the actual runtime environment.

**ARGUMENTS:** A description of what the test should validate — e.g. feature name, scenario list, or behavior to verify.

---

## Architecture Overview

All e2e test scripts live in `e2e/scripts/` and follow a standardized pattern built on three shared modules:

| Module | Purpose |
|--------|---------|
| `e2e/lib/test-harness.ts` | `runTest(config, testFn)` — orchestrates the full lifecycle: build, vault reset, Obsidian launch, CDP connect, page discovery, log collection, teardown, results summary |
| `e2e/lib/test-helpers.ts` | Shared constants, page finders, element helpers, plugin access helpers, vault utilities |
| `e2e/lib/log-collector.ts` | `LogCollector` — captures `[CPN]`-prefixed log entries from console via CDP. Exposes `getStructuredLogs()`, `getLogsByLevel()`, `getLogsBySource()` |

**You MUST use these modules.** Never duplicate boilerplate that they already provide.

---

## Step 1: Read the shared modules

Before writing any code, read these files to understand the available APIs:

```
e2e/lib/test-harness.ts
e2e/lib/test-helpers.ts
e2e/lib/log-collector.ts
```

Key exports from `test-helpers.ts`:
- **Constants:** `PROJECT_ROOT`, `VAULT_PATH`, `RESULTS_DIR`, `LOGS_DIR`, `CDP_PORT`, `PLUGIN_ID`, `E2E_DIR`
- **Page finders:** `findVaultPage(browser, timeout?)` — finds the Obsidian page with `.workspace`
- **Element helpers:** `waitForSelector(page, selector, timeoutMs?)`
- **Plugin helpers:** `getPluginInstance(page)` — returns true if plugin is loaded; `getPluginSettings(page)` — returns settings object
- **Command helpers:** `executeCommand(page, commandName)` — opens command palette and runs a command
- **Vault helpers:** `createTestNote(vaultPath, name, content)`, `removeTestNote(vaultPath, name)`

Key exports from `test-harness.ts`:
- **`runTest(config, testFn)`** — the only entry point; handles everything from build to teardown
- **`TestContext`** — passed to your test function, provides: `page`, `browser`, `obsidian`, `collector`, `results`, `vaultPath`, `screenshotsDir`, `pass()`, `fail()`, `screenshot()`
- **`TestConfig`** — `{ name, skipBuild?, setupVault?, cleanupFiles?, vaultResetOptions?, cdpPort?, launchTimeout? }`

---

## Step 2: Understand the required structure

Every test script MUST follow this structure:

```ts
#!/usr/bin/env npx tsx
/**
 * [Test Name] E2E Test
 *
 * [Brief description of what is validated]
 *
 * Scenarios:
 *   1. [First test scenario]
 *   2. [Second test scenario]
 *   ...
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { /* helpers as needed */ } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants (test-specific only)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Local helpers (test-specific only — NOT duplicates of shared helpers)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testScenarioOne(ctx: TestContext): Promise<void> {
    console.log("\nTest 1: [Description]");
    const { page } = ctx;
    // ... test logic ...
    // Use ctx.pass() / ctx.fail() for assertions — NEVER soft-pass expected functionality
}

// ... more test functions ...

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
    const { page } = ctx;
    await page.waitForTimeout(5_000); // Wait for plugin init
    await testScenarioOne(ctx);
    // ...
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

runTest({ name: "my-test-name" }, tests);
```

---

## Step 3: Write the test script

Follow these rules strictly:

### DO:
- **Import from shared modules** — `runTest`, `TestContext`, and any helpers you need
- **Use `ctx.pass()` / `ctx.fail()`** for every assertion — include a descriptive name and detail string
- **Use `ctx.screenshot(name)`** at key verification points — include the screenshot path in pass/fail calls
- **Use `ctx.collector`** to inspect structured logs — call `collector.getStructuredLogs()`, `collector.getLogsByLevel("error")`, or `collector.getLogsBySource("plugin")`
- **Use `page.evaluate()`** to interact with plugin internals — access via `(window as any).app?.plugins?.plugins?.["commonplace-notes"]`
- **Use `TestConfig.setupVault`** callback for creating test fixture files before Obsidian launches
- **Use `TestConfig.cleanupFiles`** array for vault-relative paths to delete during teardown
- **Fail hard on expected functionality** — if a feature should work, use `ctx.fail()` when it doesn't, not `ctx.pass()` with a "skipped" message
- **Use separate `async function testXxx(ctx)` functions** for each logical test scenario
- **Use `createTestNote()`** from test-helpers to set up fixture notes in `setupVault` callbacks

### DO NOT:
- **Never duplicate shared boilerplate** — no inline path constants, result tracking, screenshot helpers, pass/fail functions, findVaultPage, build/launch/connect/teardown, or results printing
- **Never use `ctx.pass()` for expected-but-missing elements** — this creates tests that can never fail. Use `ctx.fail()` when something expected is absent
- **Never hard-code paths** like `/Volumes/...` — use the constants from test-helpers (`VAULT_PATH`, `PROJECT_ROOT`, etc.)
- **Never import directly from `playwright-core`** for types that `TestContext` already provides — the harness manages browser lifecycle

### Plugin internal access patterns:
```ts
// Get the plugin instance
const plugin = (window as any).app?.plugins?.plugins?.["commonplace-notes"];

// Access settings
plugin.settings                    // CommonplaceNotesSettings
plugin.settings.publishingProfiles // Array of publishing profiles
plugin.settings.debugMode          // boolean
plugin.settings.uidLength          // number
plugin.settings.urlScheme          // 'current' | 'original'

// Access managers
plugin.profileManager              // ProfileManager
plugin.indicatorManager            // IndicatorManager
plugin.noteManager                 // NoteManager
plugin.frontmatterManager          // FrontmatterManager
plugin.contentIndexManager         // ContentIndexManager
plugin.mappingManager              // MappingManager
plugin.publisher                   // Publisher
plugin.templateManager             // TemplateManager
plugin.awsCliManager               // AwsCliManager

// Access Obsidian APIs
(window as any).app.vault          // Vault instance
(window as any).app.workspace      // Workspace instance
(window as any).app.metadataCache  // MetadataCache instance
```

### Logger levels captured by the log collector:
The plugin uses `Logger` from `src/utils/logging.ts` with these prefixes:
- `[CPN Debug] ...` → level: `"debug"` (requires `debugMode: true` in settings)
- `[CPN] ...` → level: `"info"`
- `[CPN Warning] ...` → level: `"warn"`
- `[CPN Error] ...` → level: `"error"`

All are captured with `source: "plugin"`. Console errors/warnings from other sources are captured with `source: "console"`.

---

## Step 4: Run and verify

After writing the script, run it:

```bash
npx tsx e2e/scripts/{script-name}.ts
```

Review the output:
- All tests should show `PASS` or meaningful `FAIL` (no silent skips)
- Results JSON is written to `e2e/results/{test-name}-results.json`
- Screenshots are in `e2e/results/screenshots/{test-name}/`

If tests fail, diagnose using:
- The console output and error messages
- Screenshots at the failure point
- `e2e/results/logs/latest-summary.json` for structured plugin logs
- The plugin source under `src/` to verify the actual API surface

---

## Step 5: Review for common mistakes

Before considering the script complete, verify:

1. **No soft-pass on expected functionality** — every `ctx.pass("...skipped...")` or `ctx.pass("...not found...")` for a feature that should exist is a bug in the test
2. **Timing is correct** — wait for plugin initialization (`page.waitForTimeout(5_000)`) before interacting with plugin elements
3. **Log access uses collector** — `ctx.collector.getStructuredLogs()`, not window properties
4. **No boilerplate duplication** — diff against the shared modules to confirm nothing is reinvented
5. **Cleanup is handled** — any test-generated files are listed in `TestConfig.cleanupFiles` or removed in the vault reset
