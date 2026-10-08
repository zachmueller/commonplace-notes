import { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import { Node, Parent } from 'unist';
import { Paragraph, Text } from 'mdast';

/**
 * Turn Obsidian block-id markers (`^id`) into `data-block-id` attributes so
 * block references (`[[Note#^id]]`) and block embeds (`![[Note#^id]]`) have a
 * target in the published HTML. The marker itself is stripped from the output
 * (it stays in the published `raw`, so the diff viewer still shows it).
 *
 * Two marker forms, matching Obsidian:
 *
 *   Some paragraph. ^intro        → <p data-block-id="intro">Some paragraph.</p>
 *   - List item ^li1              → <li data-block-id="li1">List item</li>
 *
 *   | a | b |                     → <table data-block-id="tbl">…</table>
 *   ^tbl                            (standalone marker after a block applies to
 *                                    that block; the marker paragraph is removed)
 *
 * A list item takes the id itself (not its first paragraph): tight lists drop
 * the inner <p> when rendered, and embedding the item should bring its nested
 * children along. Headings are never given block ids.
 *
 * Only `data-block-id` is emitted — never an `id` — so block ids can't collide
 * with the heading ids rehype-slug assigns. The first block to claim an id
 * wins; later duplicates are stripped but not tagged.
 *
 * 🔗 Coupling: the published SPA resolves `data-heading="^id"` (links, see
 * remarkObsidianLinks) and `data-block="id"` (embeds) against these attributes.
 */

/** Trailing ` ^id` at the end of a paragraph's last text node.
 *  Groups: 1=leading boundary, 2=id. */
const TRAILING_MARKER_RE = /(^|[ \t\n])\^([A-Za-z0-9-]+)[ \t]*$/;

/** A paragraph that is nothing but a marker. Group 1=id. */
const STANDALONE_MARKER_RE = /^\^([A-Za-z0-9-]+)[ \t]*$/;

/** Blocks a standalone marker can attach to (the preceding sibling). */
const STANDALONE_TARGETS = new Set(['paragraph', 'table', 'blockquote', 'list', 'code', 'math']);

interface NodeData {
	hName?: string;
	hProperties?: Record<string, unknown>;
}

function tag(node: Node, id: string, seen: Set<string>): void {
	if (seen.has(id)) return;
	seen.add(id);
	const data = (node.data || (node.data = {})) as NodeData;
	data.hProperties = data.hProperties || {};
	data.hProperties['data-block-id'] = id;
}

const remarkBlockIds: Plugin = () => {
	return (tree) => {
		const seen = new Set<string>();
		const removals: Array<{ parent: Parent; index: number }> = [];

		visit(tree, 'paragraph', (node: Paragraph, index, parent: Parent | null) => {
			if (!parent || index === undefined || index === null) return;
			const last = node.children[node.children.length - 1];
			if (!last || last.type !== 'text') return;
			const text = last as Text;

			// Standalone marker: tag the preceding block and drop this paragraph.
			if (node.children.length === 1) {
				const standalone = STANDALONE_MARKER_RE.exec(text.value);
				if (standalone) {
					const prev = index > 0 ? parent.children[index - 1] : null;
					if (prev && STANDALONE_TARGETS.has(prev.type)) {
						tag(prev, standalone[1], seen);
						removals.push({ parent, index });
					}
					// No eligible block before it: leave the marker as literal text.
					return;
				}
			}

			const match = TRAILING_MARKER_RE.exec(text.value);
			if (!match) return;

			text.value = text.value.slice(0, match.index).replace(/[ \t]+$/, '');
			if (text.value === '') node.children.pop();

			// First paragraph of a list item → the item carries the id.
			const target = parent.type === 'listItem' && index === 0 ? parent : node;
			tag(target, match[2], seen);
		});

		// Descending index order keeps the remaining indices valid.
		removals
			.sort((a, b) => b.index - a.index)
			.forEach(({ parent, index }) => parent.children.splice(index, 1));
	};
};

export default remarkBlockIds;
