import { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import { Link, Text, Parent, HTML } from 'mdast';
import { TFile } from 'obsidian';
import { slug as githubSlug } from 'github-slugger';
import { FrontmatterManager } from '../utils/frontmatter';
import { formatNoteUrl, UrlScheme } from '../utils/urlScheme';
import { parseWikilinkInner } from './wikilinkParse';

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
					// Shared with the published-raw scrubber (rewriteRawWikilinks) so
					// the two interpret `[[path#heading|alias]]` identically and never
					// drift. Splits on the first '|' and first '#'.
					const { notePath, heading, alias } = parseWikilinkInner(linkText);

					const displayText = alias || heading || notePath;

					// Same-note heading links (e.g. [[#Heading]]) have no note path to
					// resolve against; they are handled as a clickable same-note anchor
					// in the branch below rather than resolved here.
					const resolved = notePath ? await options.resolveInternalLinks(notePath) : null;

					if (resolved && resolved.published) {
						// For resolved and published notes. The heading (if any) is
						// not encoded in the router-consumed href; instead it rides on
						// the link as a data-heading attribute that the published SPA
						// reads to scroll to and highlight the target section. The slug
						// is generated with github-slugger to match the heading `id`s
						// that rehype-slug assigns at render time (see notes.ts).
						const linkNode: Link = {
							type: 'link',
							url: formatNoteUrl('u', resolved.uid, options.urlScheme),
							children: [{ type: 'text', value: displayText }]
						};
						if (heading) {
							// NOTE: we slugify the raw wikilink heading text. This matches
							// rehype-slug's id for plain/emphasis headings; it can diverge
							// for headings containing inline links/entities, which degrades
							// gracefully (the SPA simply doesn't scroll).
							linkNode.data = { hProperties: { 'data-heading': githubSlug(heading) } };
						}
						children.push(linkNode);
					} else if (!notePath && heading) {
						// Same-note section link (e.g. [[#Heading]]): no note to resolve,
						// but it should still be clickable and scroll within the current
						// panel. Emit a clickable anchor carrying the slugged heading and a
						// data-same-note marker; href="#" keeps it matched by both the CSS
						// `a[href^="#"]` rules and the SPA's link click-binding selector.
						children.push({
							type: 'link',
							url: '#',
							children: [{ type: 'text', value: displayText }],
							data: {
								hProperties: {
									'data-heading': githubSlug(heading),
									'data-same-note': 'true'
								}
							}
						});
					} else {
						// For resolved-but-unpublished and unresolved links
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
		// Apply splices in descending index order. Each splice expands one text
		// node into several, shifting the indices of later siblings; processing
		// highest-index-first keeps every remaining (lower) index valid. Splices
		// on different parents are independent, so a single global sort suffices.
		replacements
			.sort((a, b) => b.index - a.index)
			.forEach(({ index, parent, nodes }) => {
				parent.children.splice(index, 1, ...nodes);
			});
	};
};

export default remarkObsidianLinks;