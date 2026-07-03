/**
 * Pure domain-matching logic for reusing existing ACM certificates.
 *
 * Kept free of any AWS SDK / Obsidian imports so it can be unit-tested under
 * plain tsx (see e2e/scripts/test-cert-match.ts). The wizard uses this to
 * decide whether an already-issued certificate covers the site's custom domain.
 */

export type CertMatchType = 'exact' | 'wildcard';

/** Lowercase and strip a single trailing dot (ACM sometimes returns FQDNs with one). */
function normalizeDomain(domain: string): string {
	return domain.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Whether a single ACM certificate domain entry covers the target FQDN.
 *
 * A wildcard entry (`*.example.com`) matches exactly ONE leading label, per ACM
 * semantics:
 *   - `*.example.com` covers `notes.example.com`   (one label)   -> 'wildcard'
 *   - `*.example.com` does NOT cover `example.com`  (the apex)    -> null
 *   - `*.example.com` does NOT cover `a.b.example.com` (two labels) -> null
 * An exact entry must equal the target. Returns null when there is no coverage.
 */
export function domainCovers(certDomain: string, target: string): CertMatchType | null {
	const cert = normalizeDomain(certDomain);
	const host = normalizeDomain(target);
	if (!cert || !host) return null;

	if (cert === host) return 'exact';

	if (cert.startsWith('*.')) {
		// suffix keeps the leading dot, e.g. '*.example.com' -> '.example.com'.
		const suffix = cert.slice(1);
		const rest = cert.slice(2); // 'example.com'
		if (!rest) return null; // guard against a bare '*.'
		if (!host.endsWith(suffix)) return null; // excludes the apex (host is shorter)

		// The single label the '*' stands in for must be exactly one label deep.
		const label = host.slice(0, host.length - suffix.length);
		if (!label || label.includes('.')) return null;
		return 'wildcard';
	}

	return null;
}

/**
 * Best coverage of a target FQDN across a certificate's primary DomainName plus
 * all of its SANs. An exact match anywhere wins over a wildcard match; returns
 * null when no name covers the target.
 */
export function certCoversDomain(allNames: string[], target: string): CertMatchType | null {
	let best: CertMatchType | null = null;
	for (const name of allNames) {
		const match = domainCovers(name, target);
		if (match === 'exact') return 'exact';
		if (match === 'wildcard') best = 'wildcard';
	}
	return best;
}
