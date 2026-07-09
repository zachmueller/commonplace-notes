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
function compactSource(filename: string): string {
	const p = path.resolve(__dirname, '../assets/lambda', filename);
	const raw = fs.readFileSync(p, 'utf-8');
	return raw
		.split('\n')
		.filter((line) => !/^\s*\/\//.test(line))
		.filter((line) => line.trim() !== '')
		.join('\n');
}

function enforceInlineLimit(label: string, code: string): string {
	if (Buffer.byteLength(code, 'utf-8') > 4096) {
		// Guard rail: an inline function that outgrows the cap must move to an
		// S3 asset. Fail loudly at synth time rather than at deploy time.
		throw new Error(
			`Inline Lambda ${label} is ${Buffer.byteLength(code, 'utf-8')} bytes after ` +
				`compaction, over the 4096-byte CloudFormation ZipFile limit.`,
		);
	}
	return code;
}

export function readInlineLambda(filename: string): string {
	return enforceInlineLimit(filename, compactSource(filename));
}

/**
 * Compact a Lambda source WITHOUT the 4096-byte inline cap. For functions
 * packaged as an S3 asset (not inline `ZipFile`), the cap does not apply — the
 * plugin bakes config in and zips the result. Same comment/blank stripping as
 * the inline path, so a baked S3 artifact is byte-identical to what the inline
 * path would have produced for the same config.
 */
export function compactLambdaSource(filename: string): string {
	return compactSource(filename);
}

/**
 * Concatenate several inline Lambda sources into one ZipFile body (in order),
 * compacting each. Used to share a helper (e.g. lib-jwt-verify.js) across
 * single-file inline functions that cannot `require` a sibling module.
 */
export function readInlineLambdaBundle(...filenames: string[]): string {
	const code = filenames.map(compactSource).join('\n');
	return enforceInlineLimit(filenames.join('+'), code);
}
