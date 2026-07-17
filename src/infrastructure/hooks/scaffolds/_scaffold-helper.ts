/**
 * Helper that emits a complete deploy-hook `.md` file from metadata + code.
 *
 * Modeled on `src/utils/parser/scaffolds/_scaffold-helper.ts`. Unlike the parser
 * scaffolds, the emitted content is ONLY ever written to the vault when a user
 * materializes the example — it is never parsed into a running in-memory
 * fallback (deploy hooks have no built-in behavior).
 */

import type { BuiltinDeployHookScaffold, DeployHookPhase } from '../types';

export interface ScaffoldOptions {
	name: string;
	phase: DeployHookPhase;
	description: string;
	/** Prose shown above the code fence (docs + risk notes). No trailing newline needed. */
	doc: string;
	/** The code-fence body. Runs for side effects; return value ignored. */
	code: string;
}

/** The `cpn-type` frontmatter value for a phase. */
function cpnTypeFor(phase: DeployHookPhase): string {
	return phase === 'pre' ? 'pre-deploy-hook' : 'post-deploy-hook';
}

/** Build a {@link BuiltinDeployHookScaffold} with a fully-rendered `.md` body. */
export function scaffold(opts: ScaffoldOptions): BuiltinDeployHookScaffold {
	const { name, phase, description, doc, code } = opts;
	return {
		name,
		phase,
		description,
		scaffoldContent: `---
cpn-type: ${cpnTypeFor(phase)}
cpn-hook-name: ${name}
cpn-description: "${description.replace(/"/g, '\\"')}"
---

${doc.trimEnd()}

\`\`\`ts
${code.trim()}
\`\`\`
`,
	};
}
