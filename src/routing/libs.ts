/**
 * The `libs` toolkit injected into routing `code` actions (and used by the
 * built-in declarative executors). Assembled once per routing run so a `file`
 * or Templater availability change is picked up on the next invocation.
 *
 * Mirrors the parser subsystem's `buildParserLibs`, but the contents are
 * routing-specific: date helpers reproducing the Templater `created-at`
 * semantics, a merge-frontmatter wrapper, a backlink-preserving move, a
 * cold-cache frontmatter reader, and Templater's `tp` if installed.
 */

import { moment, parseYaml, type TFile } from 'obsidian';
import CommonplaceNotesPlugin from '../main';
import { extractFrontmatter } from '../utils/vaultScan';
import type { RoutingLibs } from './types';

const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD HH:mm';

/** Look up Templater's plugin API (`tp`) if the plugin is installed and enabled. */
function resolveTemplater(plugin: CommonplaceNotesPlugin): unknown {
	// Obsidian's plugin registry is untyped; guard defensively.
	const plugins = (plugin.app as unknown as { plugins?: { plugins?: Record<string, any> } }).plugins;
	return plugins?.plugins?.['templater-obsidian']?.templater ?? undefined;
}

/** Build the routing toolkit for a single run. */
export function buildRoutingLibs(plugin: CommonplaceNotesPlugin): RoutingLibs {
	const { app } = plugin;

	return {
		now(format = DEFAULT_DATE_FORMAT): string {
			return moment().format(format);
		},

		ctimeOf(file: TFile, format = DEFAULT_DATE_FORMAT): string {
			return moment(file.stat.ctime).format(format);
		},

		async mergeFrontmatter(file: TFile, updates: Record<string, unknown>): Promise<void> {
			await plugin.frontmatterManager.mergeFrontmatter(file, updates);
		},

		async renameFile(file: TFile, newPath: string): Promise<void> {
			await app.fileManager.renameFile(file, newPath);
		},

		async readFrontmatter(file: TFile): Promise<Record<string, unknown> | null> {
			const cached = app.metadataCache.getFileCache(file)?.frontmatter as
				| Record<string, unknown>
				| undefined;
			if (cached) return cached;
			try {
				const content = await app.vault.read(file);
				return extractFrontmatter(content, parseYaml);
			} catch {
				return null;
			}
		},

		tp: resolveTemplater(plugin),
	};
}
