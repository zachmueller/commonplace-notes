import { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import { Link, Text, Parent } from 'mdast';
import { TFile } from 'obsidian';
import { FrontmatterManager } from '../utils/frontmatter';

export interface ResolvedNoteInfo {
	uid: string;
	title: string;
	displayText?: string;
}

export interface ObsidianLinksOptions {
	frontmatterManager: FrontmatterManager;
	resolveInternalLinks: (linkText: string) => Promise<ResolvedNoteInfo | null>;
}

const remarkObsidianLinks: Plugin<[ObsidianLinksOptions]> = (options) => {
	return async (tree) => {
		const promises: Promise<void>[] = [];
		const replacements: Array<{
			index: number;
			parent: Parent;
			nodes: (Text | Link)[];
		}> = [];

		visit(tree, 'text', (node: Text, index, parent: Parent | null) => {
			if (!parent) return;

			const matches = Array.from(node.value.matchAll(/\[\[(.*?)\]\]/g));
			if (matches.length === 0) return;

			promises.push((async () => {
				const children: (Text | Link)[] = [];
				let lastIndex = 0;

				for (const match of matches) {
					// Add preceding text
					if (match.index! > lastIndex) {
						children.push({ type: 'text', value: node.value.slice(lastIndex, match.index) });
					}

					const [fullMatch, linkText] = match;
					const resolved = await options.resolveInternalLinks(linkText);

					if (resolved) {
						children.push({
							type: 'link',
							url: `#u=${encodeURIComponent(resolved.uid)}`,
							children: [{ type: 'text', value: resolved.displayText || resolved.title }]
						});
					} else {
						children.push({ type: 'text', value: fullMatch });
					}

					lastIndex = match.index! + fullMatch.length;
				}

				// Add remaining text
				if (lastIndex < node.value.length) {
					children.push({ type: 'text', value: node.value.slice(lastIndex) });
				}

				replacements.push({ index: index!, parent, nodes: children });
			})());
		});

		await Promise.all(promises);
		replacements.forEach(({ index, parent, nodes }) => {
			parent.children.splice(index, 1, ...nodes);
		});
	};
};

export default remarkObsidianLinks;