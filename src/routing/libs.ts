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
import { generateUID } from '../utils/uid';
import { RK } from './frontmatterKeys';
import type { RoutingLibs } from './types';

const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD HH:mm';

/**
 * Minimal shape of Templater's core API (the object at
 * `app.plugins.plugins['templater-obsidian'].templater`). Templater ships no
 * type declarations, so we hand-type only the one method we call.
 */
interface TemplaterApi {
	write_template_to_file(templateFile: TFile, targetFile: TFile): Promise<void>;
}

/** Look up Templater's plugin API (`tp`) if the plugin is installed and enabled. */
function resolveTemplater(plugin: CommonplaceNotesPlugin): unknown {
	// Obsidian's plugin registry is untyped; guard defensively.
	const plugins = (plugin.app as unknown as {
		plugins?: { plugins?: Record<string, { templater?: unknown }> };
	}).plugins;
	return plugins?.plugins?.['templater-obsidian']?.templater ?? undefined;
}

/** Build the routing toolkit for a single run. */
export function buildRoutingLibs(plugin: CommonplaceNotesPlugin): RoutingLibs {
	const { app } = plugin;
	const tp = resolveTemplater(plugin);

	/**
	 * Read a file's frontmatter, preferring the metadata cache but falling back to
	 * a manual YAML parse for cold-cache (freshly-created) files. Shared by the
	 * `readFrontmatter` toolkit method and `ensureUid`.
	 */
	async function readFrontmatterInternal(file: TFile): Promise<Record<string, unknown> | null> {
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
	}

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
			return readFrontmatterInternal(file);
		},

		async ensureUid(file: TFile): Promise<string> {
			// Never clobber an existing (published-URL-backing) id — return it as-is.
			const fm = await readFrontmatterInternal(file);
			const existing = fm?.[RK.UID];
			if (typeof existing === 'string' && existing.trim() !== '') return existing;

			// Mint + write immediately via mergeFrontmatter (bypasses the batch
			// queue), so the id is durably on disk before any later routing step.
			const uid = generateUID(plugin.settings.uidLength ?? 8);
			await plugin.frontmatterManager.mergeFrontmatter(file, { [RK.UID]: uid });
			return uid;
		},

		async runTemplaterTemplate(templateFile: TFile, targetFile: TFile): Promise<boolean> {
			const templater = tp as TemplaterApi | undefined;
			if (!templater || typeof templater.write_template_to_file !== 'function') {
				return false; // Templater absent/incompatible — caller emits the skip Notice.
			}
			// Resolves even when the template fails to parse (Templater swallows that
			// error and shows its own Notice), so `true` means "ran", not "succeeded".
			await templater.write_template_to_file(templateFile, targetFile);
			return true;
		},

		tp,
	};
}
