import { Plugin } from 'unified';
import { visit } from 'unist-util-visit';
import { Blockquote, Paragraph, Text, Parent } from 'mdast';

/**
 * Transform Obsidian-style callout blockquotes into the markup the published
 * site CSS targets. A blockquote whose first line is `[!type] Title` becomes a
 * container carrying `data-callout-type="<canonical>"` with a leading
 * `data-callout-title` child:
 *
 *   > [!warning] Heads up
 *   > body
 *
 * →  <div data-callout-type="warning">
 *      <div data-callout-title>Heads up</div>
 *      <p>body</p>
 *    </div>
 *
 * Foldable callouts (`[!type]-` collapsed, `[!type]+` expanded) render as native
 * <details>/<summary> so folding needs zero JavaScript on the published site:
 *
 *   > [!note]- Click to expand
 *
 * →  <details data-callout-type="note">
 *      <summary data-callout-title>Click to expand</summary>
 *      ...
 *    </details>
 *
 * The transform runs on MDAST (before remark-rehype) and uses `hName`/
 * `hProperties` rather than raw HTML, so callout bodies still render through the
 * rest of the pipeline (links, emphasis, nested lists, etc.).
 *
 * 🔗 Coupling: the emitted `data-callout-type` values MUST match the
 * `[data-callout-type="…"]` CSS in the published site (the source of truth is
 * `infrastructure/assets/index/index.html`, regenerated into
 * `src/publish/siteAssets.ts` via `npm run synth:site`). Keep CANONICAL_TYPES
 * and ALIASES in sync with that CSS.
 */

/** First-line callout marker: `[!type]`, optional fold `+`/`-`, optional title.
 *  Groups: 1=type, 2=fold, 3=title. (Numbered, not named — the TS target
 *  predates ES2018 named capture groups.) */
const CALLOUT_RE = /^\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)/;

/** Canonical callout types that the published-site CSS styles directly. */
const CANONICAL_TYPES = new Set([
	'note',
	'abstract',
	'info',
	'todo',
	'tip',
	'success',
	'question',
	'warning',
	'failure',
	'danger',
	'bug',
	'example',
	'quote',
]);

/** Obsidian aliases collapsed onto a canonical type. */
const ALIASES: Record<string, string> = {
	summary: 'abstract',
	tldr: 'abstract',
	hint: 'tip',
	important: 'tip',
	check: 'success',
	done: 'success',
	help: 'question',
	faq: 'question',
	caution: 'warning',
	attention: 'warning',
	fail: 'failure',
	missing: 'failure',
	error: 'danger',
	cite: 'quote',
};

/** Map a raw (already-lowercased) callout type to its canonical form. Unknown
 *  types pass through unchanged and render with the base/default style. */
function canonicalType(raw: string): string {
	if (ALIASES[raw]) return ALIASES[raw];
	if (CANONICAL_TYPES.has(raw)) return raw;
	return raw;
}

/** Title-case a callout type for the default (author-omitted) title. */
function defaultTitle(type: string): string {
	return type.charAt(0).toUpperCase() + type.slice(1);
}

interface MdastData {
	hName?: string;
	hProperties?: Record<string, unknown>;
}

const remarkCallouts: Plugin = () => {
	return (tree) => {
		visit(tree, 'blockquote', (node: Blockquote) => {
			const firstChild = node.children[0];
			if (!firstChild || firstChild.type !== 'paragraph') return;

			const paragraph = firstChild as Paragraph;
			const firstInline = paragraph.children[0];
			if (!firstInline || firstInline.type !== 'text') return;

			const textNode = firstInline as Text;
			const match = CALLOUT_RE.exec(textNode.value);
			if (!match) return;

			const rawType = match[1].toLowerCase();
			const type = canonicalType(rawType);
			const fold = match[2]; // '' | '-' | '+'
			const foldable = fold === '-' || fold === '+';
			const title = match[3].trim() || defaultTitle(type);

			// Strip the marker line from the body. Drop a single leading newline so
			// the body text doesn't start with a blank line.
			textNode.value = textNode.value.slice(match[0].length).replace(/^\n/, '');

			// If the first paragraph is now empty (title-only callout, or the body
			// continued in a later block), remove it so no empty <p> is emitted.
			if (textNode.value === '') {
				paragraph.children.shift();
				if (paragraph.children.length === 0) {
					node.children.shift();
				}
			}

			// Title node — <summary> for foldable callouts, <div> otherwise. Built
			// fresh, so it carries only the callout-title marker (no line-numbers
			// data from earlier stages).
			const titleNode: Paragraph & { data: MdastData } = {
				type: 'paragraph',
				children: [{ type: 'text', value: title }],
				data: {
					hName: foldable ? 'summary' : 'div',
					hProperties: { 'data-callout-title': '' },
				},
			};
			(node.children as Parent['children']).unshift(titleNode);

			// Retag the blockquote as the callout container. Merge into any existing
			// data/hProperties (remark-line-numbers, order 030, runs before this and
			// has already populated them).
			const data = (node.data || (node.data = {})) as MdastData;
			data.hName = foldable ? 'details' : 'div';
			data.hProperties = data.hProperties || {};
			data.hProperties['data-callout-type'] = type;
			if (fold === '+') data.hProperties.open = true;
		});
	};
};

export default remarkCallouts;
