/**
 * remark-attachments (attachment spec P2 §4): renders links to non-Markdown
 * vault files.
 *
 * Runs before remark-obsidian-links, so attachment references never reach
 * it. Handles:
 *
 * - wikilinks in text nodes (`[[…]]`, `![[…]]`), parsed with the shared
 *   parseWikilinkInner; the rest of the text node (note wikilinks included)
 *   stays for remark-obsidian-links;
 * - Markdown `image` and `link` nodes whose URL is relative (no scheme, not
 *   `#`, `/` or `//`), percent-decoded before lookup.
 *
 * `resolveAttachment` decides: `null` leaves the link alone (a note, an
 * unresolved link, an external URL); `published: false` renders an
 * unpublished span; `published: true` renders the attachment. The renderer is
 * an allow-list: only files in the note's attachment list are published.
 *
 * Every output is an mdast node with `data.hName`/`data.hProperties`, never a
 * raw `html` string, so hast escapes every attribute and text child. The HTML
 * never holds an attachment URL (`src`/`href`): a note with several access
 * groups is published byte for byte into each group's area, so the site fills
 * in the area it loaded the note from (`data-cpn-attachment="<sha256>/<name>"`,
 * plus `data-cpn-fragment` for a `#page=N`-style fragment).
 */

import type { Plugin } from 'unified';
import type { Image, Link, Parent, PhrasingContent, Root, Text } from 'mdast';
import type { Node } from 'unist';
import { visitParents } from 'unist-util-visit-parents';
import { toString as mdastToString } from 'mdast-util-to-string';
import { parseWikilinkInner } from './wikilinkParse';
import type { AttachmentKind, AttachmentRender } from './attachments';

export interface RemarkAttachmentsOptions {
	/** See ParserContext.resolveAttachment. Absent: the stage does nothing. */
	resolveAttachment?: (linkpath: string) => AttachmentRender | null;
}

/** Size-style aliases (`|300`, `|300x200`) aren't display text. */
const SIZE_ALIAS_RE = /^(\d+)(?:x(\d+))?$/;

interface NodeData {
	hName: string;
	hProperties: Record<string, unknown>;
}

/** Unknown to mdast; remark-rehype turns it into `data.hName` with `data.hProperties`. */
interface AttachmentNode {
	type: 'cpnAttachment';
	data: NodeData;
	children: PhrasingContent[];
}

/** An `<span class="unpublished-link">` with escaped text. Shared with remark-obsidian-links. */
export interface UnpublishedNode {
	type: 'cpnUnpublished';
	data: NodeData;
	children: Text[];
}

export function unpublishedNode(text: string): UnpublishedNode {
	return {
		type: 'cpnUnpublished',
		data: { hName: 'span', hProperties: { className: ['unpublished-link'] } },
		children: [{ type: 'text', value: text }],
	};
}

interface Size {
	width?: number;
	height?: number;
}

/** Split a trailing size alias off: `alt|300x200` → { text: 'alt', width, height }. */
export function splitSizeAlias(alias: string): { text: string; size: Size } {
	const whole = SIZE_ALIAS_RE.exec(alias);
	if (whole) return { text: '', size: sizeOf(whole) };
	const pipe = alias.lastIndexOf('|');
	if (pipe !== -1) {
		const m = SIZE_ALIAS_RE.exec(alias.slice(pipe + 1));
		if (m) return { text: alias.slice(0, pipe), size: sizeOf(m) };
	}
	return { text: alias, size: {} };
}

function sizeOf(m: RegExpExecArray): Size {
	const size: Size = { width: Number(m[1]) };
	if (m[2]) size.height = Number(m[2]);
	return size;
}

function sizeProps(size: Size): Record<string, number> {
	const out: Record<string, number> = {};
	if (size.width) out.width = size.width;
	if (size.height) out.height = size.height;
	return out;
}

/** A Markdown link/image URL that may point into the vault: no scheme, not `#`, `/` or `//`. */
function isVaultRelativeUrl(url: string): boolean {
	if (url === '' || /^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
	return !url.startsWith('#') && !url.startsWith('/');
}

function safeDecodeUri(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

interface Reference {
	render: AttachmentRender;
	isEmbed: boolean;
	inHeading: boolean;
	/** Alias / alt text / link text, size suffix removed ('' when none). */
	text: string;
	/** Link children to keep (Markdown links), else null. */
	children: PhrasingContent[] | null;
	size: Size;
	fragment: string;
}

function attachmentElement(ref: Reference): AttachmentNode | UnpublishedNode {
	const { render } = ref;
	if (!render.published) return unpublishedNode(ref.text || render.fileName);
	const base = { 'data-cpn-attachment': render.key };
	const kind: AttachmentKind = render.kind;
	if (ref.isEmbed && !ref.inHeading && kind === 'image') {
		return element('img', {
			className: ['cpn-attachment', 'cpn-attachment-image'],
			...base,
			alt: ref.text || render.fileName,
			loading: 'lazy',
			...sizeProps(ref.size),
		}, []);
	}
	if (ref.isEmbed && !ref.inHeading && kind === 'audio') {
		return element('audio', {
			className: ['cpn-attachment', 'cpn-attachment-audio'],
			controls: true,
			preload: 'metadata',
			...base,
		}, []);
	}
	if (ref.isEmbed && !ref.inHeading && kind === 'video') {
		return element('video', {
			className: ['cpn-attachment', 'cpn-attachment-video'],
			controls: true,
			preload: 'metadata',
			...base,
			...sizeProps(ref.size),
		}, []);
	}
	const props: Record<string, unknown> = {
		className: ['cpn-attachment', 'cpn-attachment-file'],
		...base,
		target: '_blank',
		rel: ['noopener'],
	};
	if (ref.fragment) props['data-cpn-fragment'] = ref.fragment;
	const children = ref.children && ref.children.length > 0
		? ref.children
		: [{ type: 'text', value: ref.text || render.fileName } as Text];
	return element('a', props, children);
}

function element(hName: string, hProperties: Record<string, unknown>, children: PhrasingContent[]): AttachmentNode {
	return { type: 'cpnAttachment', data: { hName, hProperties }, children };
}

interface Replacement {
	parent: Parent;
	index: number;
	nodes: Node[];
}

const remarkAttachments: Plugin<[RemarkAttachmentsOptions?], Root> = (options) => {
	const resolve = options?.resolveAttachment;
	return (tree: Root) => {
		if (!resolve) return;
		const replacements: Replacement[] = [];

		visitParents(tree, (node: Node, ancestors: Node[]) => {
			const parent = ancestors[ancestors.length - 1] as Parent | undefined;
			if (!parent) return;
			const inHeading = ancestors.some(a => a.type === 'heading');
			const index = parent.children.indexOf(node as Parent['children'][number]);
			if (node.type === 'text') {
				const nodes = splitTextNode(node as Text, inHeading, resolve);
				if (nodes) replacements.push({ parent, index, nodes });
			} else if (node.type === 'image' || node.type === 'link') {
				const out = markdownReference(node as Image | Link, inHeading, resolve);
				if (out) {
					replacements.push({ parent, index, nodes: [out] });
					return 'skip';
				}
			}
			return undefined;
		});

		// Highest index first per parent, so earlier indices stay valid.
		replacements
			.sort((a, b) => b.index - a.index)
			.forEach(({ parent, index, nodes }) => {
				parent.children.splice(index, 1, ...(nodes as Parent['children']));
			});
	};
};

/** Split attachment wikilinks out of a text node; null when it holds none. */
function splitTextNode(
	node: Text,
	inHeading: boolean,
	resolve: (linkpath: string) => AttachmentRender | null,
): Node[] | null {
	const value = node.value;
	if (!value.includes('[[')) return null;
	const out: Node[] = [];
	let last = 0;
	let found = false;
	for (const match of value.matchAll(/\[\[(.*?)\]\]/g)) {
		const parsed = parseWikilinkInner(match[1]);
		if (parsed.isSameNote || parsed.notePath === '') continue;
		const render = resolve(parsed.notePath);
		if (!render) continue;
		const at = match.index ?? 0;
		const isEmbed = at > 0 && value[at - 1] === '!';
		const start = at - (isEmbed ? 1 : 0);
		const { text, size } = splitSizeAlias(parsed.alias);
		const kind = render.published ? render.kind : 'file';
		if (start > last) out.push({ type: 'text', value: value.slice(last, start) } as Text);
		out.push(attachmentElement({
			render,
			isEmbed,
			inHeading,
			// A size alias is only a size on an embed; on a plain link it's text.
			text: isEmbed ? text : parsed.alias,
			children: null,
			size: isEmbed ? size : {},
			fragment: kind === 'file' ? parsed.heading : '',
		}));
		last = at + match[0].length;
		found = true;
	}
	if (!found) return null;
	if (last < value.length) out.push({ type: 'text', value: value.slice(last) } as Text);
	return out;
}

function markdownReference(
	node: Image | Link,
	inHeading: boolean,
	resolve: (linkpath: string) => AttachmentRender | null,
): Node | null {
	const url = node.url;
	if (!isVaultRelativeUrl(url)) return null;
	const hashIdx = url.indexOf('#');
	const path = safeDecodeUri(hashIdx === -1 ? url : url.slice(0, hashIdx));
	if (path === '') return null;
	const render = resolve(path);
	if (!render) return null;
	const fragment = hashIdx === -1 ? '' : safeDecodeUri(url.slice(hashIdx + 1));
	const kind = render.published ? render.kind : 'file';
	if (node.type === 'image') {
		const { text, size } = splitSizeAlias(node.alt ?? '');
		return attachmentElement({ render, isEmbed: true, inHeading, text, children: null, size, fragment: kind === 'file' ? fragment : '' });
	}
	const text = mdastToString(node);
	return attachmentElement({
		render,
		isEmbed: false,
		inHeading,
		text,
		children: render.published && node.children.length > 0 ? node.children : null,
		size: {},
		fragment: kind === 'file' ? fragment : '',
	});
}

export default remarkAttachments;
