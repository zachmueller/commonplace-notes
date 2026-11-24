/**
 * Maps positions in mdast node values back to offsets in the Markdown source.
 *
 * An mdast `text` node's `value` is not a byte-for-byte copy of its source
 * slice. Parsing drops backslash escapes (`\*` → `*`), decodes character
 * references (`&amp;` → `&`), and leaves out continuation-line prefixes
 * (`> `, list indents) and trailing whitespace before a soft line break. So
 * `node.position.start.offset + indexInValue` lands in the wrong place as soon
 * as any of those appear before the index.
 *
 * This module runs micromark (the tokenizer under remark-parse) over the same
 * source with the same GFM extension and keeps the tokens that put characters
 * into a text value:
 *
 * - `data`: one value character per source character;
 * - `characterEscape`: one value character for its two source characters;
 * - `characterReference`: its decoded characters for the whole reference;
 * - `lineEnding`: the line break, one to one.
 *
 * Everything else (line prefixes, `lineSuffix`, markers) contributes no value
 * characters, so it can never sit inside a mapped range.
 *
 * It also exposes the source span of a link or image destination, which mdast
 * positions don't give (they cover the whole `![alt](dest "title")`).
 *
 * Pure: no Obsidian imports, so it can be unit-tested with tsx.
 *
 * The micromark major must match the one `remark-parse` uses (micromark 3 for
 * remark-parse 10), so the tokens line up with the mdast being walked.
 */

import { parse } from 'micromark/lib/parse.js';
import { preprocess } from 'micromark/lib/preprocess.js';
import { postprocess } from 'micromark/lib/postprocess.js';
import { gfm } from 'micromark-extension-gfm';
import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import { decodeNumericCharacterReference } from 'micromark-util-decode-numeric-character-reference';

/** The parts of a micromark token this module reads. */
interface MmToken {
	type: string;
	start: { offset: number };
	end: { offset: number };
}
type MmEvent = ['enter' | 'exit', MmToken, unknown];

/** A run of value characters and the source it came from. */
interface Segment {
	/** Source offsets of the token. */
	srcStart: number;
	srcEnd: number;
	/** The characters this token puts into the value. */
	text: string;
	/** True when each value character maps to one source character (`data`, `lineEnding`). */
	oneToOne: boolean;
}

/** Value-to-source mapping for one text node. */
export interface TextNodeMap {
	/** Source offset where value character `i` starts. */
	startOf(i: number): number;
	/** Source offset where value character `i` ends (exclusive). */
	endOf(i: number): number;
}

/** Source span of a link or image destination. */
export interface DestinationSpan {
	start: number;
	end: number;
	/** True for the `<…>` form; the span includes the brackets. */
	literal: boolean;
}

export interface MarkdownSourceMap {
	/**
	 * Mapping for the text node covering `[start, end)` in the source whose
	 * value is `value`, or `null` when the tokens don't rebuild exactly that
	 * value. Callers then leave the node alone rather than risk a wrong splice.
	 */
	mapTextNode(start: number, end: number, value: string): TextNodeMap | null;
	/**
	 * Destination span of the link or image node covering `[nodeStart,
	 * nodeEnd)`, or `null` when it has no inline destination (reference-style
	 * links, autolinks, empty `()`).
	 */
	destinationOf(nodeStart: number, nodeEnd: number): DestinationSpan | null;
}

function decodeReference(valueType: string, value: string): string {
	if (valueType === 'characterReferenceMarkerNumeric') return decodeNumericCharacterReference(value, 10);
	if (valueType === 'characterReferenceMarkerHexadecimal') return decodeNumericCharacterReference(value, 16);
	const decoded = decodeNamedCharacterReference(value);
	return decoded === false ? '' : decoded;
}

/** Index of the first segment whose srcStart is >= offset (binary search). */
function lowerBound(segments: Segment[], offset: number): number {
	let lo = 0;
	let hi = segments.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (segments[mid].srcStart < offset) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Tokenize `source` once and build the lookups. */
export function buildSourceMap(source: string): MarkdownSourceMap {
	const events = postprocess(
		parse({ extensions: [gfm()] }).document().write(preprocess()(source, undefined, true))
	) as unknown as MmEvent[];

	const segments: Segment[] = [];
	const resources: MmToken[] = [];
	const destinations: { token: MmToken; literal: boolean }[] = [];

	// Inside a characterEscape/characterReference, its children (markers,
	// value) are handled by the parent, so skip them.
	let insideEscapeOrRef = 0;
	let refMarkerType = '';
	let refStart = 0;
	let destStart: MmToken | null = null;

	for (const [kind, token] of events) {
		const t = token.type;
		if (kind === 'enter') {
			if (t === 'characterEscape' || t === 'characterReference') {
				insideEscapeOrRef++;
				refMarkerType = '';
				refStart = token.start.offset;
				continue;
			}
			if (insideEscapeOrRef > 0) {
				if (t === 'characterReferenceMarkerNumeric' || t === 'characterReferenceMarkerHexadecimal') {
					refMarkerType = t;
				}
				continue;
			}
			if (t === 'data' || t === 'lineEnding') {
				segments.push({
					srcStart: token.start.offset,
					srcEnd: token.end.offset,
					text: source.slice(token.start.offset, token.end.offset),
					oneToOne: true
				});
			} else if (t === 'resource') {
				resources.push(token);
			} else if (t === 'resourceDestination') {
				destStart = token;
			} else if (t === 'resourceDestinationLiteral' && destStart) {
				destinations.push({ token: destStart, literal: true });
				destStart = null;
			} else if (t === 'resourceDestinationRaw' && destStart) {
				destinations.push({ token: destStart, literal: false });
				destStart = null;
			}
		} else {
			if (t === 'characterEscape') {
				insideEscapeOrRef--;
				segments.push({
					srcStart: token.start.offset,
					srcEnd: token.end.offset,
					text: source.slice(token.start.offset + 1, token.end.offset),
					oneToOne: false
				});
			} else if (t === 'characterReference') {
				insideEscapeOrRef--;
				const whole = source.slice(refStart, token.end.offset);
				// `&name;`, `&#123;`, `&#x1F;` → strip the markers to get the value.
				const inner = whole.slice(
					refMarkerType === 'characterReferenceMarkerHexadecimal' ? 3
						: refMarkerType === 'characterReferenceMarkerNumeric' ? 2 : 1,
					-1
				);
				segments.push({
					srcStart: token.start.offset,
					srcEnd: token.end.offset,
					text: decodeReference(refMarkerType, inner),
					oneToOne: false
				});
			}
		}
	}

	// Events come out in document order for leaf tokens, but sort defensively
	// so the binary search below holds.
	segments.sort((a, b) => a.srcStart - b.srcStart);

	return {
		mapTextNode(start: number, end: number, value: string): TextNodeMap | null {
			const first = lowerBound(segments, start);
			// Per value character: which segment, and its index within that segment.
			const segOf: number[] = [];
			const idxIn: number[] = [];
			let rebuilt = '';
			for (let s = first; s < segments.length && segments[s].srcEnd <= end; s++) {
				const seg = segments[s];
				for (let k = 0; k < seg.text.length; k++) {
					segOf.push(s);
					idxIn.push(k);
				}
				rebuilt += seg.text;
			}
			if (rebuilt !== value) return null;

			return {
				startOf(i: number): number {
					const seg = segments[segOf[i]];
					return seg.oneToOne ? seg.srcStart + idxIn[i] : seg.srcStart;
				},
				endOf(i: number): number {
					const seg = segments[segOf[i]];
					return seg.oneToOne ? seg.srcStart + idxIn[i] + 1 : seg.srcEnd;
				}
			};
		},

		destinationOf(nodeStart: number, nodeEnd: number): DestinationSpan | null {
			// A node's own resource ends exactly where the node ends; a nested
			// image in a link label has a resource that ends earlier.
			const resource = resources.find(r => r.end.offset === nodeEnd && r.start.offset >= nodeStart);
			if (!resource) return null;
			const dest = destinations.find(d =>
				d.token.start.offset >= resource.start.offset && d.token.end.offset <= resource.end.offset);
			if (!dest) return null;
			return { start: dest.token.start.offset, end: dest.token.end.offset, literal: dest.literal };
		}
	};
}
