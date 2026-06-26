/**
 * Canonical built-in parser stages, as overridable scaffolds.
 *
 * Each entry's `scaffoldContent` is BOTH the file written to the vault when a
 * user materializes the stage AND the in-memory fallback parsed at load time
 * when no vault file exists — so the built-in pipeline runs identically whether
 * or not the user has materialized anything. A vault file whose
 * `cpn-parser-name` matches an entry here OVERRIDES it.
 *
 * The default ordering reproduces the pre-refactor hardcoded pipeline exactly:
 *   010 remark-parse → 020 remark-gfm → 030 line-numbers →
 *   040 remark-obsidian-links → 050 remark-rehype → 055 rehype-slug →
 *   060 rehype-stringify
 *
 * Analogue of Notor's `BUILTIN_TOOL_SCAFFOLDS`.
 */

import type { BuiltinParserScaffold } from '../types';
import { REMARK_PARSE } from './remark-parse';
import { REMARK_GFM } from './remark-gfm';
import { LINE_NUMBERS } from './line-numbers';
import { REMARK_OBSIDIAN_LINKS } from './remark-obsidian-links';
import { REMARK_REHYPE } from './remark-rehype';
import { REHYPE_SLUG } from './rehype-slug';
import { REHYPE_STRINGIFY } from './rehype-stringify';

const SCAFFOLDS: BuiltinParserScaffold[] = [
	REMARK_PARSE,
	REMARK_GFM,
	LINE_NUMBERS,
	REMARK_OBSIDIAN_LINKS,
	REMARK_REHYPE,
	REHYPE_SLUG,
	REHYPE_STRINGIFY,
];

export const BUILTIN_PARSER_SCAFFOLDS: ReadonlyMap<string, BuiltinParserScaffold> = new Map(
	SCAFFOLDS.map((s) => [s.name, s]),
);
