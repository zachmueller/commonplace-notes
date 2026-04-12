# Debug Plugin in Obsidian

This workflow builds the Commonplace Notes plugin, launches it inside the real Obsidian app, captures structured logs via Playwright + CDP, and iteratively fixes any errors found.

## Step 1: Build and capture logs

Run the E2E debug runner with the Bash tool. This will:
- Build the plugin (`npm run build`)
- Launch Obsidian with Chrome DevTools Protocol enabled
- Connect Playwright via CDP and capture console logs for 15 seconds
- Write a structured summary and shut down Obsidian

```bash
npm run e2e:run
```

If you only need a quick smoke test (10 seconds), use:
```bash
npm run e2e:run:quick
```

If the build itself fails, stop here and fix the TypeScript/build errors before re-running.

## Step 2: Read the log summary

Read the structured summary that the runner produced:

```
e2e/results/logs/latest-summary.json
```

This JSON file contains:
- **`stats`**: total log entries, error count, warning count, list of unique source components
- **`recentErrors`**: last 20 error-level entries with full data/stack traces
- **`recentWarnings`**: last 10 warning-level entries
- **`lastEntries`**: last 30 log entries of any level (shows plugin behavior timeline)

## Step 3: Analyze the results

Evaluate the summary:

1. **If `stats.errors` is 0 and the plugin loaded successfully** (look for debug-level entries showing directory creation, profile command registration, and "Layout ready, initializing indicators"): The plugin is working. Report success and stop.

2. **If there are errors**: Examine each entry in `recentErrors`. Each error entry has:
   - `source`: `"plugin"` for [CPN]-prefixed messages, `"console"` for general errors, `"page-error"` for uncaught exceptions
   - `message`: human-readable description
   - `data`: may contain `stack` traces or other context

   Use the source and stack trace to locate the relevant source files under `src/`.

3. **If there are warnings but no errors**: Review `recentWarnings` to decide if they need fixing.

4. **If `stats.totalEntries` is 0**: The plugin may not have loaded at all. Check:
   - Was the build successful? (re-run `npm run build`)
   - Is the test vault set up? (re-run `npm run e2e:setup-vault`)
   - Read `e2e/results/logs/console-all-*.jsonl` for raw Obsidian console output that may reveal loading issues

## Step 4: Fix the source code

Based on the errors identified in Step 3, edit the relevant files under `src/`. Common fixes include:

- **Runtime errors**: Fix the code at the file/line indicated by the stack trace
- **Missing imports or APIs**: Check the Obsidian API types
- **Plugin lifecycle issues**: Review `src/main.ts` onload/onunload methods
- **Settings issues**: Review `src/settings.ts` and `src/types.ts`
- **Publishing issues**: Review `src/publish/publisher.ts` and related files

When adding diagnostic logging to investigate unclear issues, use the existing Logger:

```ts
import { Logger } from './utils/logging';
Logger.debug("Descriptive message", relevantData);
Logger.info("Important event", relevantData);
Logger.error("Error description", error);
```

The log collector captures all `[CPN]`, `[CPN Debug]`, `[CPN Warning]`, and `[CPN Error]` prefixed messages. Debug-level messages require `debugMode: true` in plugin settings (the test vault enables this by default).

## Step 5: Re-run and verify

Go back to **Step 1** and run `npm run e2e:run` again. Repeat the cycle until:
- `stats.errors` is `0`
- The plugin loads and initializes without issues
- Any specific functionality you were debugging works correctly

To skip the rebuild (e.g., if you just want to re-capture without code changes):
```bash
npm run e2e:run -- --skip-build
```

## Step 6: Optionally run the full test suite

Once the plugin loads cleanly, run the Playwright test suite for more thorough validation:

```bash
npm run e2e
```

This executes the tests in `e2e/tests/` (e.g., `plugin-loads.spec.ts`) which perform assertions beyond just log capture.

## Additional debugging tips

- **Screenshots** are saved at `e2e/results/screenshots/obsidian-startup.png` and `e2e/results/screenshots/obsidian-after-capture.png`. These can help identify visual issues (note: screenshots may fail on some Obsidian/Electron versions with a `__name is not defined` error — this is an Obsidian-internal issue, not a test infrastructure problem).
- **Raw console logs** (including non-plugin output) are in `e2e/results/logs/console-all-*.jsonl` — useful when the plugin fails to load entirely.
- **Longer capture window**: Use `npm run e2e:run -- --duration 30` if the plugin needs more time to initialize or if you're debugging async behavior.
- **Custom vault**: Use `npm run e2e:run -- --vault /path/to/vault` to test against a specific vault instead of the ephemeral test vault.
- **Plugin access in console**: The plugin instance is accessible at `app.plugins.plugins['commonplace-notes']` inside Obsidian's developer console and via `page.evaluate()` in tests.
