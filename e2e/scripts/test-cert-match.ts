#!/usr/bin/env npx tsx
/**
 * ACM Certificate Matcher Unit Test
 *
 * Exercises the pure domain-matching logic used to decide whether an existing
 * ACM certificate can be reused for a site's custom domain. The wildcard
 * semantics here are the crux of the reuse feature: a cert for `example.com`
 * with a `*.example.com` SAN must be recognized as covering `notes.example.com`
 * but NOT the apex and NOT a two-level subdomain.
 *
 * Pure functions — no AWS SDK or Obsidian imports.
 *
 * Run: npx tsx e2e/scripts/test-cert-match.ts
 */

import * as certMatchModule from '../../src/infrastructure/certMatch';
import { type CertMatchType } from '../../src/infrastructure/certMatch';

// Under this repo's tsx/Node ESM setup, named exports from a src .ts module are
// surfaced under `default` (same workaround as test-comment-sanitizer.ts).
const certMatch: any =
	(certMatchModule as any).domainCovers !== undefined
		? certMatchModule
		: (certMatchModule as any).default;
const { domainCovers, certCoversDomain } = certMatch;

const failures: string[] = [];

function expectCovers(certDomain: string, target: string, expected: CertMatchType | null, label: string) {
	const got = domainCovers(certDomain, target);
	if (got !== expected) {
		failures.push(`${label}: domainCovers("${certDomain}", "${target}") = ${got}, expected ${expected}`);
	}
}

function expectCertCovers(names: string[], target: string, expected: CertMatchType | null, label: string) {
	const got = certCoversDomain(names, target);
	if (got !== expected) {
		failures.push(`${label}: certCoversDomain([${names.join(', ')}], "${target}") = ${got}, expected ${expected}`);
	}
}

function main() {
	// --- exact matches ---
	expectCovers('notes.example.com', 'notes.example.com', 'exact', 'exact FQDN');
	expectCovers('example.com', 'example.com', 'exact', 'exact apex');

	// --- wildcard: the user's scenario ---
	expectCovers('*.example.com', 'notes.example.com', 'wildcard', 'wildcard covers one-label subdomain');
	expectCovers('*.example.com', 'example.com', null, 'wildcard does NOT cover the apex');
	expectCovers('*.example.com', 'a.b.example.com', null, 'wildcard does NOT cover two-level subdomain');
	expectCovers('*.example.com', 'other.com', null, 'wildcard does not cover a different domain');
	expectCovers('*.example.com', 'notesexample.com', null, 'wildcard requires a label boundary (no suffix-only match)');

	// --- normalization: case + trailing dot ---
	expectCovers('*.Example.com', 'NOTES.example.com', 'wildcard', 'case-insensitive wildcard');
	expectCovers('notes.example.com.', 'notes.example.com', 'exact', 'trailing dot on cert normalized');
	expectCovers('notes.example.com', 'notes.example.com.', 'exact', 'trailing dot on target normalized');

	// --- non-matches ---
	expectCovers('foo.example.com', 'notes.example.com', null, 'sibling subdomain does not match');
	expectCovers('', 'notes.example.com', null, 'empty cert domain');
	expectCovers('*.', 'notes.example.com', null, 'bare wildcard is not a match');

	// --- certCoversDomain across DomainName + SANs ---
	expectCertCovers(['example.com', '*.example.com'], 'notes.example.com', 'wildcard', 'match found via wildcard SAN, not primary');
	expectCertCovers(['other.com', 'notes.example.com'], 'notes.example.com', 'exact', 'match found via exact SAN');
	expectCertCovers(['example.com', '*.example.com'], 'example.com', 'exact', 'apex covered by primary even when wildcard SAN present');
	expectCertCovers(['*.example.com', 'notes.example.com'], 'notes.example.com', 'exact', 'exact preferred over wildcard when both present');
	expectCertCovers(['a.com', 'b.com'], 'notes.example.com', null, 'no coverage across unrelated names');
	expectCertCovers([], 'notes.example.com', null, 'empty name list');

	report();
}

function report() {
	if (failures.length === 0) {
		console.log('All cert matcher cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} cert matcher assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main();
