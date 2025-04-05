import { TFile } from 'obsidian';
import path from 'path';
import CommonplaceNotesPlugin from '../main';
import { Logger } from './logging';

export class PathUtils {
	static sluggify(s: string): string {
		return s
			.split("/")
			.map((segment) =>
				segment
					.replace(/\s/g, "-")
					.replace(/&/g, "-and-")
					.replace(/%/g, "-percent")
					.replace(/\?/g, "")
					.replace(/#/g, "")
			)
			.join("/") // always use / as sep
			.replace(/\/$/, "")
	}

	static slugifyFilePath(fp: string, excludeExt?: boolean): string {
		// Remove leading/trailing slashes
		fp = fp.replace(/^\/+|\/+$/g, "")

		// Get file extension
		let ext = fp.match(/\.[A-Za-z0-9]+$/)?.[0] ?? ""
		const withoutFileExt = fp.replace(new RegExp(ext + "$"), "")

		if (excludeExt || [".md", ".html", undefined].includes(ext)) {
			ext = ""
		}

		let slug = PathUtils.sluggify(withoutFileExt)

		return slug + ext
	}

	static stripSlashes(s: string, onlyStripPrefix?: boolean): string {
		if (s.startsWith("/")) {
			s = s.substring(1)
		}

		if (!onlyStripPrefix && s.endsWith("/")) {
			s = s.slice(0, -1)
		}

		return s
	}

	static simplifySlug(fp: string): string {
		const trimSuffix = (s: string, suffix: string): string => {
			const endsWith = s === suffix || s.endsWith("/" + suffix);
			return endsWith ? s.slice(0, -suffix.length) : s;
		}

		let slug = PathUtils.stripSlashes(trimSuffix(fp, "index"), true)
		return slug.length === 0 ? "/" : slug
	}

	// Helper function to create relative paths
	static createRelativePath(fromSlug: string, toSlug: string): string {
		// Convert slugs to directory-like paths
		const fromParts = fromSlug.split('/');
		const toParts = toSlug.split('/');

		// Remove the filename part from fromParts
		fromParts.pop();

		// Calculate the relative path
		const relativePath = path.relative(
			fromParts.join('/'),
			toParts.join('/')
		);

		// Ensure the path starts with ./ or ../
		return relativePath.startsWith('.')
			? relativePath + '.html'
			: './' + relativePath + '.html';
	}

	static async ensureDirectory(plugin: CommonplaceNotesPlugin, targetPath: string): Promise<void> {
		try {
			// Normalize the path to handle different path separators
			const normalizedPath = targetPath.replace(/\\/g, '/');

			// Split the path into parts
			const parts = normalizedPath.split('/');
			let currentPath = '';

			// Recursively create each directory in the path
			for (const part of parts) {
				if (part) {  // Skip empty parts
					currentPath += (currentPath ? '/' : '') + part;
					try {
						if (!(await plugin.app.vault.adapter.exists(currentPath))) {
							await plugin.app.vault.adapter.mkdir(currentPath);
							Logger.debug(`Created directory: ${currentPath}`);
						}
					} catch (error) {
						// Only ignore errors if directory already exists
						if (error.code !== 'EEXIST') {
							throw error;
						}
					}
				}
			}
		} catch (error) {
			Logger.error(`Failed to create directory ${targetPath}:`, error);
			throw error;
		}
	}

	async deleteFilesInDirectory(plugin: CommonplaceNotesPlugin, directory: string) {
		try {
			const adapter = plugin.app.vault.adapter;
			const files = await adapter.list(directory);

			for (const file of files.files) {
				await adapter.remove(file);
				Logger.debug(`Deleted: ${file}`);
			}
		} catch (error) {
			Logger.error(`Error deleting files in ${directory}:`, error);
			throw error;
		}
	}
}