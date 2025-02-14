import path from 'path';

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
}