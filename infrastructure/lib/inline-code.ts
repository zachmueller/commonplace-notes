import * as fs from 'fs';
import * as path from 'path';

/**
 * Read a Lambda source file from infrastructure/assets/lambda and return a
 * compact version suitable for inlining into a CloudFormation `ZipFile`.
 *
 * Inline `ZipFile` code is capped at 4096 bytes by CloudFormation, so we strip
 * full-line `//` comments and blank lines. We deliberately only strip lines
 * whose trimmed form *starts* with `//` — this preserves `https://` and other
 * `//` sequences that appear inside string literals or mid-line code.
 *
 * The source files stay fully readable/reviewable on disk; only the inlined
 * copy is compacted.
 */
export function readInlineLambda(filename: string): string {
	const p = path.resolve(__dirname, '../assets/lambda', filename);
	const raw = fs.readFileSync(p, 'utf-8');
	const compact = raw
		.split('\n')
		.filter((line) => !/^\s*\/\//.test(line))
		.filter((line) => line.trim() !== '')
		.join('\n');
	if (Buffer.byteLength(compact, 'utf-8') > 4096) {
		// Guard rail: an inline function that outgrows the cap must move to an
		// S3 asset. Fail loudly at synth time rather than at deploy time.
		throw new Error(
			`Inline Lambda ${filename} is ${Buffer.byteLength(compact, 'utf-8')} bytes after ` +
				`compaction, over the 4096-byte CloudFormation ZipFile limit.`,
		);
	}
	return compact;
}
