/**
 * Helper that emits a complete parser-stage `.md` file from metadata + code.
 *
 * Ported from `shared/notor/src/extensions/builtin-tool-scaffolds/_scaffold-helper.ts`.
 * The emitted content is BOTH (a) what gets written to the vault when a user
 * materializes a built-in, and (b) the in-memory fallback parsed at load time
 * when no vault file exists — so behavior is identical either way.
 */

import type { BuiltinParserScaffold, ParserStage } from '../types';

export interface ScaffoldOptions {
	name: string;
	stage: ParserStage;
	order: number;
	description: string;
	/** Prose shown above the code fence (docs + risk notes). No trailing newline needed. */
	doc: string;
	/** The code-fence body. Must `return` a unified plugin or `[plugin, options]`. */
	code: string;
}

/** Build a {@link BuiltinParserScaffold} with a fully-rendered `.md` body. */
export function scaffold(opts: ScaffoldOptions): BuiltinParserScaffold {
	const { name, stage, order, description, doc, code } = opts;
	return {
		name,
		stage,
		order,
		description,
		scaffoldContent: `---
cpn-type: parser
cpn-parser-name: ${name}
cpn-parser-stage: ${stage}
cpn-parser-order: ${order}
cpn-description: "${description.replace(/"/g, '\\"')}"
---

${doc.trimEnd()}

\`\`\`ts
${code.trim()}
\`\`\`
`,
	};
}
