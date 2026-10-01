/**
 * Keep a site's live custom domains through a CloudFormation update of the
 * site stack.
 *
 * CloudFormation writes the distribution's whole config on every update, so
 * aliases or a certificate attached outside the stack (for example by hand in
 * the CloudFront console) are wiped the first time the stack is updated. Before
 * each site-stack update, compare what the deployed parameters would render
 * with what the distribution actually has. On a mismatch, carry the live values
 * into the update so CloudFormation adopts them. Refuse when the live setup
 * can't be expressed by the template, or the caller is deliberately changing
 * the domain at the same time.
 *
 * Pure functions: no AWS SDK or Obsidian imports.
 */

/** The template's TLS policy when the stack doesn't set one. */
export const DEFAULT_MIN_TLS = 'TLSv1.2_2021';

/** The viewer-facing parts of a live distribution config. */
export interface LiveDomainConfig {
	aliases: string[];
	/** Set when the distribution uses an ACM certificate. */
	acmCertificateArn?: string;
	/** Set when the distribution uses an IAM server certificate (the template can't express this). */
	iamCertificateId?: string;
	minimumProtocolVersion?: string;
}

/** The domain-related parameters of the site stack. */
export interface DomainParams {
	CustomDomain: string;
	AdditionalAliases: string;
	CertificateArn: string;
	MinimumProtocolVersion: string;
}

export type DomainReconcileResult =
	| { kind: 'in-sync' }
	| { kind: 'adopt'; params: DomainParams; dropped: string[] }
	| { kind: 'conflict'; reason: string };

const DOMAIN_KEYS: Array<keyof DomainParams> = ['CustomDomain', 'AdditionalAliases', 'CertificateArn', 'MinimumProtocolVersion'];

function splitAliases(list: string | undefined): string[] {
	return (list || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** The aliases a set of stack parameters renders onto the distribution. */
export function renderedAliases(params: Partial<DomainParams>): string[] {
	const primary = (params.CustomDomain || '').trim().toLowerCase();
	if (!primary) return [];
	return [...new Set([primary, ...splitAliases(params.AdditionalAliases)])];
}

/** Compare parameter values the way the template renders them. */
function normalizeParam(key: keyof DomainParams, value: string | undefined): string {
	switch (key) {
		case 'CustomDomain': return (value || '').trim().toLowerCase();
		case 'AdditionalAliases': return splitAliases(value).sort().join(',');
		case 'MinimumProtocolVersion': return value || DEFAULT_MIN_TLS;
		default: return value || '';
	}
}

function sameSet(a: string[], b: string[]): boolean {
	const sa = new Set(a.map((s) => s.toLowerCase()));
	const sb = new Set(b.map((s) => s.toLowerCase()));
	return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

/** Normalize deployed parameter values (missing keys take the template defaults). */
export function deployedDomainParams(deployed: Record<string, string | undefined>): DomainParams {
	return {
		CustomDomain: deployed.CustomDomain || '',
		AdditionalAliases: deployed.AdditionalAliases || '',
		CertificateArn: deployed.CertificateArn || '',
		MinimumProtocolVersion: deployed.MinimumProtocolVersion || DEFAULT_MIN_TLS,
	};
}

/**
 * Decide whether an update would change the distribution's live domain setup,
 * and if so what parameters keep it.
 *
 * - `deployed`: the stack's current parameter values.
 * - `live`: what the distribution really has.
 * - `overrides`: the parameters the caller is about to set explicitly.
 * - `preferredHost`: the site's own hostname (from its base URL); it becomes
 *   the primary `CustomDomain` when it is one of the live aliases.
 */
export function reconcileLiveDomain(
	deployed: Record<string, string | undefined>,
	live: LiveDomainConfig,
	overrides: Partial<Record<string, string>>,
	preferredHost?: string,
): DomainReconcileResult {
	const current = deployedDomainParams(deployed);
	const liveAliases = live.aliases.map((a) => a.toLowerCase());

	// What the deployed parameters render, versus what is really there.
	const certMatches = current.CertificateArn
		? live.acmCertificateArn === current.CertificateArn
			&& (live.minimumProtocolVersion || DEFAULT_MIN_TLS) === current.MinimumProtocolVersion
		: !live.acmCertificateArn && !live.iamCertificateId;
	if (sameSet(renderedAliases(current), liveAliases) && certMatches) {
		return { kind: 'in-sync' };
	}

	const changed = DOMAIN_KEYS.filter((k) => k in overrides && normalizeParam(k, overrides[k]) !== normalizeParam(k, current[k]));
	const describeLive = liveAliases.length ? liveAliases.join(', ') : 'no custom domain';
	if (changed.length > 0) {
		return {
			kind: 'conflict',
			reason: `The CloudFront distribution's domain setup was changed outside CloudFormation (it serves ${describeLive}), `
				+ `and this update also changes ${changed.join(', ')}. Applying it could drop the live domains. `
				+ 'Make the change in one place: either revert the manual change in the CloudFront console, or re-run this without changing the domain so the live setup is adopted first.',
		};
	}
	if (live.iamCertificateId) {
		return {
			kind: 'conflict',
			reason: `The CloudFront distribution uses an IAM server certificate (${live.iamCertificateId}) set outside CloudFormation. `
				+ 'The site stack only supports ACM certificates, so this update would remove it and break HTTPS for '
				+ `${describeLive}. Move the domain to an ACM certificate in us-east-1 first.`,
		};
	}
	if (liveAliases.length > 0 && !live.acmCertificateArn) {
		return {
			kind: 'conflict',
			reason: `The CloudFront distribution serves ${describeLive} without a custom certificate. This setup can't be expressed by the site stack.`,
		};
	}

	const preferred = (preferredHost || '').toLowerCase();
	const primary = liveAliases.includes(preferred)
		? preferred
		: liveAliases.includes(current.CustomDomain.toLowerCase()) ? current.CustomDomain.toLowerCase() : (liveAliases[0] || '');
	const params: DomainParams = {
		CustomDomain: primary,
		AdditionalAliases: liveAliases.filter((a) => a !== primary).join(','),
		CertificateArn: live.acmCertificateArn || '',
		MinimumProtocolVersion: live.acmCertificateArn ? (live.minimumProtocolVersion || DEFAULT_MIN_TLS) : current.MinimumProtocolVersion,
	};
	const dropped = renderedAliases(current).filter((a) => !liveAliases.includes(a));
	return { kind: 'adopt', params, dropped };
}

/** Hostname of a site base URL, or undefined when it isn't a URL. */
export function hostOf(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) return undefined;
	try {
		return new URL(baseUrl).hostname.toLowerCase() || undefined;
	} catch {
		return undefined;
	}
}
