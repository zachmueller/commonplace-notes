import { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import { Link, Text, Parent, HTML } from 'mdast';
import { TFile } from 'obsidian';
import { FrontmatterManager } from '../utils/frontmatter';
import { formatNoteUrl, UrlScheme } from '../utils/urlScheme';

export interface ResolvedNoteInfo {
	uid: string;
	title: string;
	published: boolean;
}

export interface ObsidianLinksOptions {
	frontmatterManager: FrontmatterManager;
	resolveInternalLinks: (notePath: string) => Promise<ResolvedNoteInfo | null>;
	urlScheme: UrlScheme;
}

const remarkObsidianLinks: Plugin<[ObsidianLinksOptions]> = (options) => {
	return async (tree) => {
		const promises: Promise<void>[] = [];
		const replacements: Array<{
			index: number;
			parent: Parent;
			nodes: (Text | Link | HTML)[];
		}> = [];

		visit(tree, 'text', (node: Text, index, parent: Parent | null) => {
			if (!parent) return;

			const matches = Array.from(node.value.matchAll(/\[\[(.*?)\]\]/g));
			if (matches.length === 0) return;

			promises.push((async () => {
				const children: (Text | Link | HTML)[] = [];
				let lastIndex = 0;

				for (const match of matches) {
					// Add preceding text
					if (match.index! > lastIndex) {
						children.push({ type: 'text', value: node.value.slice(lastIndex, match.index) });
					}

					const [fullMatch, linkText] = match;
					const [link, alias] = linkText.split('|');

					// Parse out heading if it exists
					const [notePath, heading] = link.split('#');

					const displayText = alias || heading || notePath;

					// Same-note heading links (e.g. [[#Heading]]) have no note path to
					// resolve against; render them as a non-clickable span until
					// section-anchor navigation lands.
					const resolved = notePath ? await options.resolveInternalLinks(notePath) : null;

					if (resolved && resolved.published) {
						// For resolved and published notes. The heading (if any) is
						// dropped from navigation for now but stashed on the link as a
						// data-heading attribute so future scroll/highlight behavior can
						// build on it without re-parsing.
						const linkNode: Link = {
							type: 'link',
							url: formatNoteUrl('u', resolved.uid, options.urlScheme),
							children: [{ type: 'text', value: displayText }]
						};
						if (heading) {
							linkNode.data = { hProperties: { 'data-heading': heading } };
						}
						children.push(linkNode);
					} else {
						// For resolved-but-unpublished, unresolved, and same-note links
						children.push({
							type: 'html',
							value: `<span class="unpublished-link">${displayText}</span>`
						});
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