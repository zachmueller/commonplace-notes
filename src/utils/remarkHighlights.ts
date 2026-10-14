import { Plugin } from 'unified';
import { visit, SKIP } from 'unist-util-visit';
import { Node, Parent } from 'unist';
import { Text } from 'mdast';

/**
 * Render Obsidian highlights as <mark>. A leading color emoji (Obsidian 1.14's
 * colored highlights) is stripped and recorded as `data-highlight`:
 *
 *   ==plain==            →  <mark>plain</mark>
 *   ==🔴 urgent==         →  <mark data-highlight="red">urgent</mark>
 *   ==see **this** [[a]]==  →  <mark>see <strong>this</strong> <a …>a</a></mark>
 *
 * A highlight can wrap other inline nodes, so the opening and closing `==` often
 * sit in different sibling text nodes (remark-obsidian-links has already split
 * text around wikilinks by the time this runs). Delimiters are therefore matched
 * across a parent's children, never across a parent boundary. Only `text` nodes
 * are scanned, so inline code and code blocks are left alone.
 *
 * Like Obsidian, an opening `==` must be followed by a non-space and a closing
 * `==` preceded by one, so prose like `a == b` stays literal. Runs of three or
 * more `=` are literal. Highlights don't nest. Unmatched `==` stays literal.
 *
 * Limitation: `\==` can't be told apart from `==` here (remark has already
 * removed the backslash), so an escaped delimiter still highlights. Wrap such
 * text in inline code instead.
 *
 * The output is a custom `highlight` MDAST node with `data.hName: 'mark'`;
 * remark-rehype's unknown-node handler turns it into the element. Built fresh,
 * so it carries no line-numbers attributes.
 *
 * 🔗 Coupling: the emitted `data-highlight` values MUST match the
 * `mark[data-highlight="…"]` CSS in the published site (the source of truth is
 * `infrastructure/assets/index/index.html`, regenerated into
 * `src/publish/siteAssets.ts` via `npm run synth:site`). Keep PALETTE in sync
 * with that CSS.
 */

/** Obsidian's highlight colors, keyed by the emoji that selects them. Any other
 *  leading emoji is ordinary text in a default-colored highlight. */
const PALETTE: Array<[string, string]> = [
	['🔴', 'red'],
	['🟠', 'orange'],
	['🟡', 'yellow'],
	['🟢', 'green'],
	['🔵', 'blue'],
	['🟣', 'purple'],
];

/** Emoji presentation selector some keyboards append after the emoji. */
const VARIATION_SELECTOR = '\uFE0F';

const DELIMITER_RUN_RE = /=+/g;
const WHITESPACE_RE = /\s/;

interface MdastData {
	hName?: string;
	hProperties?: Record<string, unknown>;
}

interface HighlightNode extends Parent {
	type: 'highlight';
	data: MdastData;
}

/** A `==` candidate: which child it's in, and where in that text node. */
interface Delimiter {
	child: number;
	offset: number;
	canOpen: boolean;
	canClose: boolean;
}

/** The character a neighboring sibling presents at the delimiter's side, or
 *  null at the parent's edge. Non-text inline nodes (links, emphasis, inline
 *  code, …) count as non-whitespace; a hard break counts as whitespace. */
function edgeChar(node: Node | undefined, side: 'first' | 'last'): string | null {
	if (!node) return null;
	if (node.type === 'text') {
		const value = (node as Text).value;
		return (side === 'first' ? value.charAt(0) : value.charAt(value.length - 1)) || null;
	}
	return node.type === 'break' ? '\n' : 'x';
}

function isNonSpace(ch: string | null): boolean {
	return ch !== null && !WHITESPACE_RE.test(ch);
}

function findDelimiters(children: Node[]): Delimiter[] {
	const delimiters: Delimiter[] = [];
	children.forEach((child, i) => {
		if (child.type !== 'text') return;
		const value = (child as Text).value;
		DELIMITER_RUN_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = DELIMITER_RUN_RE.exec(value))) {
			if (match[0].length !== 2) continue;
			const offset = match.index;
			const before = offset > 0 ? value.charAt(offset - 1) : edgeChar(children[i - 1], 'last');
			const after =
				offset + 2 < value.length ? value.charAt(offset + 2) : edgeChar(children[i + 1], 'first');
			delimiters.push({ child: i, offset, canOpen: isNonSpace(after), canClose: isNonSpace(before) });
		}
	});
	return delimiters;
}

/** Strip a leading palette emoji (plus an optional variation selector and one
 *  space) and record its color. An emoji-only highlight (`==🔴==`) keeps the
 *  emoji, since stripping it would leave nothing to show. */
function applyColor(node: HighlightNode): void {
	const first = node.children[0];
	if (!first || first.type !== 'text') return;
	const text = first as Text;
	for (const [emoji, color] of PALETTE) {
		if (!text.value.startsWith(emoji)) continue;
		let rest = text.value.slice(emoji.length);
		if (rest.startsWith(VARIATION_SELECTOR)) rest = rest.slice(VARIATION_SELECTOR.length);
		if (rest.startsWith(' ')) rest = rest.slice(1);
		if (rest === '' && node.children.length === 1) return;
		if (rest === '') node.children.shift();
		else text.value = rest;
		node.data.hProperties = { 'data-highlight': color };
		return;
	}
}

/** Wrap every matched `==…==` span among `parent`'s children in a highlight. */
function wrapHighlights(parent: Parent): void {
	// Pair left to right: the first opener, then the next closer after it.
	const pairs: Array<[Delimiter, Delimiter]> = [];
	let open: Delimiter | null = null;
	for (const d of findDelimiters(parent.children)) {
		if (!open) {
			if (d.canOpen) open = d;
		} else if (d.canClose) {
			pairs.push([open, d]);
			open = null;
		}
	}
	if (pairs.length === 0) return;

	// Delimiter positions per child, ascending (pairs are ordered and disjoint).
	const cuts = new Map<number, Array<{ offset: number; kind: 'open' | 'close' }>>();
	const addCut = (d: Delimiter, kind: 'open' | 'close') => {
		const list = cuts.get(d.child) || [];
		list.push({ offset: d.offset, kind });
		cuts.set(d.child, list);
	};
	for (const [o, c] of pairs) {
		addCut(o, 'open');
		addCut(c, 'close');
	}

	// Rebuild the children: split cut text nodes into fresh pieces (dropping the
	// delimiters), and gather everything between an open and its close.
	const children: Node[] = [];
	let current: HighlightNode | null = null;
	const emit = (node: Node) => (current ? current.children : children).push(node);
	const emitText = (value: string) => {
		if (value) emit({ type: 'text', value } as Text);
	};

	parent.children.forEach((child, i) => {
		const childCuts = cuts.get(i);
		if (!childCuts) {
			emit(child);
			return;
		}
		const value = (child as Text).value;
		let pos = 0;
		for (const { offset, kind } of childCuts) {
			emitText(value.slice(pos, offset));
			if (kind === 'open') {
				current = { type: 'highlight', children: [], data: { hName: 'mark' } };
			} else if (current) {
				applyColor(current);
				children.push(current);
				current = null;
			}
			pos = offset + 2;
		}
		emitText(value.slice(pos));
	});

	parent.children = children;
}

const remarkHighlights: Plugin = () => {
	return (tree) => {
		visit(tree, (node: Node) => {
			if (node.type === 'highlight') return SKIP;
			if ('children' in node) wrapHighlights(node as Parent);
		});
	};
};

export default remarkHighlights;
