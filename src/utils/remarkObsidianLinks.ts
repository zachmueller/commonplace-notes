import { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import { Link, Text, Parent, HTML, Paragraph } from 'mdast';
import { TFile } from 'obsidian';
import { slug as githubSlug } from 'github-slugger';
import { FrontmatterManager } from '../utils/frontmatter';
import { formatNoteUrl, UrlScheme } from '../utils/urlScheme';
import { parseWikilinkInner, ParsedWikilink } from './wikilinkParse';

export interface ResolvedNoteInfo {
	uid: string;
	title: string;
	published: boolean;
}

export interface ObsidianLinksOptions {
	frontmatterManager: FrontmatterManager;
	resolveInternalLinks: (notePath: string) => Promise<ResolvedNoteInfo | null>;
	urlScheme: UrlScheme;
	/**
	 * Render `![[Note]]` embeds as transclusion placeholders that the published
	 * SPA fills with the target's latest content (default true). When false,
	 * embeds render as ordinary links.
	 */
	transclusions?: boolean;
}

/** Size-style embed aliases (`![[pic.png|300]]`, `|300x200`) aren't display text. */
const SIZE_ALIAS_RE = /^\d+(x\d+)?$/;

interface NodeData {
	hName?: string;
	hProperties?: Record<string, unknown>;
}

/**
 * Transclusion placeholder. Not a standard mdast type: remark-rehype's unknown-
 * node handler turns it into `data.hName` (span inline, div in a group) and
 * keeps its children (the fallback link).
 */
interface TransclusionNode {
	type: 'cpnTransclusion';
	data: NodeData;
	children: Link[];
}

type ReplacementNode = Text | Link | HTML | TransclusionNode | Paragraph;

interface WikilinkMatch {
	parsed: ParsedWikilink;
	resolved: ResolvedNoteInfo | null;
	/** `![[…]]`: start includes the `!`. */
	isEmbed: boolean;
	start: number;
	end: number;
}

/**
 * Section anchor carried on a link as `data-heading`: the github-slugger slug
 * of a heading, or `^id` for a block reference (matched by the SPA against
 * `data-block-id`, see remarkBlockIds).
 */
function anchorFor({ heading, blockId }: ParsedWikilink): string | null {
	if (blockId) return '^' + blockId;
	// NOTE: we slugify the raw wikilink heading text. This matches
	// rehype-slug's id for plain/emphasis headings; it can diverge for headings
	// containing inline links/entities, which degrades gracefully (the SPA
	// simply doesn't scroll).
	if (heading) return githubSlug(heading);
	return null;
}

function displayTextFor({ parsed, isEmbed }: WikilinkMatch): string {
	const { notePath, heading, alias, blockId } = parsed;
	const usableAlias = isEmbed && SIZE_ALIAS_RE.test(alias) ? '' : alias;
	// A block id (`^abc`) is not readable text; prefer the note name.
	return usableAlias || (blockId ? '' : heading) || notePath || heading;
}

/** Link to a published note, carrying the section anchor as `data-heading`. */
function noteLink(uid: string, text: string, parsed: ParsedWikilink, urlScheme: UrlScheme): Link {
	// The heading (if any) is not encoded in the router-consumed href; it rides
	// on the link as a data-heading attribute that the published SPA reads to
	// scroll to and highlight the target section.
	const link: Link = {
		type: 'link',
		url: formatNoteUrl('u', uid, urlScheme),
		children: [{ type: 'text', value: text }]
	};
	const anchor = anchorFor(parsed);
	if (anchor) link.data = { hProperties: { 'data-heading': anchor } };
	return link;
}

/**
 * Attributes of a transclusion placeholder. The SPA resolves `data-uid` to the
 * target's LATEST revision at view time, so the parent never stores (or hashes)
 * any of the target's content.
 */
function transclusionProps(resolved: ResolvedNoteInfo, parsed: ParsedWikilink): Record<string, string> {
	const props: Record<string, string> = { 'data-uid': resolved.uid, 'data-title': resolved.title };
	if (parsed.blockId) props['data-block'] = parsed.blockId;
	else if (parsed.heading) props['data-heading'] = githubSlug(parsed.heading);
	return props;
}

function unpublishedSpan(text: string): HTML {
	return { type: 'html', value: `<span class="unpublished-link">${text}</span>` };
}

/** True when this match should become a transclusion placeholder. */
function isTransclusion(m: WikilinkMatch, enabled: boolean, inHeading: boolean): boolean {
	return enabled && m.isEmbed && !inHeading && !!m.parsed.notePath && !!m.resolved?.published;
}

const remarkObsidianLinks: Plugin<[ObsidianLinksOptions]> = (options) => {
	const transclusionsEnabled = options.transclusions !== false;

	return async (tree) => {
		const promises: Promise<void>[] = [];
		const replacements: Array<{
			index: number;
			parent: Parent;
			nodes: ReplacementNode[];
		}> = [];
		// Whole-paragraph embeds retag the paragraph itself (p → div placeholder).
		const paragraphMutations: Array<{
			paragraph: Paragraph;
			className: string;
			props: Record<string, string>;
			children: ReplacementNode[];
		}> = [];

		// Embeds inside headings stay plain links (a heading can't hold a block).
		const headingTexts = new Set<Text>();
		visit(tree, 'heading', (heading) => {
			visit(heading, 'text', (t: Text) => {
				headingTexts.add(t);
			});
		});

		visit(tree, 'text', (node: Text, index, parent: Parent | null) => {
			if (!parent) return;

			const regexMatches = Array.from(node.value.matchAll(/\[\[(.*?)\]\]/g));
			if (regexMatches.length === 0) return;

			promises.push((async () => {
				const matches: WikilinkMatch[] = [];
				for (const match of regexMatches) {
					const [fullMatch, linkText] = match;
					// Shared with the published-raw scrubber (rewriteRawWikilinks) so
					// the two interpret `[[path#heading|alias]]` identically and never
					// drift. Splits on the first '|' and first '#'.
					const parsed = parseWikilinkInner(linkText);
					const isEmbed = match.index! > 0 && node.value[match.index! - 1] === '!';
					// Same-note heading links (e.g. [[#Heading]]) have no note path to
					// resolve against; they are handled as a clickable same-note anchor
					// below rather than resolved here.
					const resolved = parsed.notePath ? await options.resolveInternalLinks(parsed.notePath) : null;
					matches.push({
						parsed,
						resolved,
						isEmbed,
						start: match.index! - (isEmbed ? 1 : 0),
						end: match.index! + fullMatch.length
					});
				}

				const inHeading = headingTexts.has(node);

				// Block mode: a paragraph holding nothing but embeds (whitespace
				// aside) becomes a block placeholder (or a group of them).
				if (parent.type === 'paragraph' && parent.children.length === 1 && matches.every((m) => m.isEmbed)) {
					let rest = '';
					let last = 0;
					for (const m of matches) {
						rest += node.value.slice(last, m.start);
						last = m.end;
					}
					rest += node.value.slice(last);
					const live = matches.filter((m) => isTransclusion(m, transclusionsEnabled, inHeading));
					if (rest.trim() === '' && live.length > 0) {
						const paragraph = parent as Paragraph;
						if (matches.length === 1) {
							const m = matches[0];
							paragraphMutations.push({
								paragraph,
								className: 'cpn-transclusion',
								props: transclusionProps(m.resolved!, m.parsed),
								children: [noteLink(m.resolved!.uid, displayTextFor(m), m.parsed, options.urlScheme)]
							});
						} else {
							paragraphMutations.push({
								paragraph,
								className: 'cpn-transclusion-group',
								props: {},
								children: matches.map((m): ReplacementNode =>
									isTransclusion(m, transclusionsEnabled, inHeading)
										? {
											type: 'cpnTransclusion',
											data: {
												hName: 'div',
												hProperties: { className: ['cpn-transclusion'], ...transclusionProps(m.resolved!, m.parsed) }
											},
											children: [noteLink(m.resolved!.uid, displayTextFor(m), m.parsed, options.urlScheme)]
										}
										: { type: 'paragraph', children: [unpublishedSpan(displayTextFor(m))] }
								)
							});
						}
						return;
					}
				}

				const children: ReplacementNode[] = [];
				let lastIndex = 0;

				for (const m of matches) {
					// Add preceding text
					if (m.start > lastIndex) {
						children.push({ type: 'text', value: node.value.slice(lastIndex, m.start) });
					}

					const { parsed, resolved } = m;
					const displayText = displayTextFor(m);

					if (isTransclusion(m, transclusionsEnabled, inHeading)) {
						// Inline embed (mid-paragraph, table cell, list text, …): a span
						// placeholder, since a div inside a <p> breaks HTML parsing. The SPA
						// unwraps single-paragraph content inline when hydrating.
						children.push({
							type: 'cpnTransclusion',
							data: {
								hName: 'span',
								hProperties: { className: ['cpn-transclusion'], ...transclusionProps(resolved!, parsed) }
							},
							children: [noteLink(resolved!.uid, displayText, parsed, options.urlScheme)]
						});
					} else if (resolved && resolved.published) {
						// For resolved and published notes (and embeds rendered as links).
						children.push(noteLink(resolved.uid, displayText, parsed, options.urlScheme));
					} else if (!parsed.notePath && parsed.heading) {
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
									'data-heading': anchorFor(parsed),
									'data-same-note': 'true'
								}
							}
						});
					} else {
						// For resolved-but-unpublished and unresolved links (and embeds,
						// including attachments like ![[pic.png]])
						children.push(unpublishedSpan(displayText));
					}

					lastIndex = m.end;
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
				parent.children.splice(index, 1, ...(nodes as Parent['children']));
			});

		// Whole-paragraph embeds never also have a splice (block mode returns
		// before queuing one), so these can apply independently. Merge into the
		// existing hProperties so line-numbers / block-id attributes survive.
		for (const { paragraph, className, props, children } of paragraphMutations) {
			const data = (paragraph.data || (paragraph.data = {})) as NodeData;
			data.hName = 'div';
			data.hProperties = data.hProperties || {};
			const classes: unknown[] = Array.isArray(data.hProperties.className) ? data.hProperties.className : [];
			data.hProperties.className = [...classes, className];
			Object.assign(data.hProperties, props);
			paragraph.children = children as Paragraph['children'];
		}
	};
};

export default remarkObsidianLinks;
