#!/usr/bin/env npx tsx
/**
 * Site Domain Drift Unit Test
 *
 * Exercises the pure logic that keeps a distribution's live custom domains
 * through a site-stack update. CloudFormation rewrites the whole distribution
 * config on update, so aliases or a certificate attached outside the stack
 * must be carried into the update parameters (adopted), or the update refused.
 *
 * The first case is the production incident: zach.nz + notes.zach.nz attached
 * by hand, stack CustomDomain/CertificateArn empty, and the access-groups edge
 * re-point wiping both domains.
 *
 * Pure functions — no AWS SDK or Obsidian imports.
 *
 * Run: npx tsx e2e/scripts/test-domain-drift.ts
 */

import * as driftModule from '../../src/infrastructure/domainDrift';

// Under this repo's tsx/Node ESM setup, named exports from a src .ts module are
// surfaced under `default` (same workaround as test-cert-match.ts).
const drift: any =
	(driftModule as any).reconcileLiveDomain !== undefined
		? driftModule
		: (driftModule as any).default;
const { reconcileLiveDomain, renderedAliases, hostOf, DEFAULT_MIN_TLS } = drift;

const CERT = 'arn:aws:acm:us-east-1:111122223333:certificate/abc';
const OTHER_CERT = 'arn:aws:acm:us-east-1:111122223333:certificate/def';
const failures: string[] = [];

function check(label: string, got: unknown, want: unknown) {
	const g = JSON.stringify(got);
	const w = JSON.stringify(want);
	if (g !== w) failures.push(`${label}: got ${g}, expected ${w}`);
}

function main() {
	// --- The incident: domains attached by hand, edge re-point ---
	const incident = reconcileLiveDomain(
		{ CustomDomain: '', CertificateArn: '', AuthLambdaEdgeArn: '' },
		{ aliases: ['notes.zach.nz', 'zach.nz'], acmCertificateArn: CERT, minimumProtocolVersion: 'TLSv1.3_2025' },
		{ AuthLambdaEdgeArn: 'arn:edge:1', CallbackApiDomainName: 'cb.example.com' },
		'zach.nz',
	);
	check('incident adopts live domains, base-URL host as primary', incident, {
		kind: 'adopt',
		params: { CustomDomain: 'zach.nz', AdditionalAliases: 'notes.zach.nz', CertificateArn: CERT, MinimumProtocolVersion: 'TLSv1.3_2025' },
		dropped: [],
	});

	// Wizard re-run sends CustomDomain/CertificateArn = '' (same as deployed): still adopts.
	const wizard = reconcileLiveDomain(
		{ CustomDomain: '', CertificateArn: '' },
		{ aliases: ['notes.zach.nz', 'zach.nz'], acmCertificateArn: CERT, minimumProtocolVersion: 'TLSv1.3_2025' },
		{ CustomDomain: '', CertificateArn: '', MinimumProtocolVersion: '' },
		'zach.nz',
	);
	check('wizard re-run with unchanged domain params adopts', wizard.kind, 'adopt');

	// --- In sync: nothing to do ---
	check('no domain anywhere is in sync',
		reconcileLiveDomain({ CustomDomain: '', CertificateArn: '' }, { aliases: [] }, { AuthLambdaEdgeArn: 'x' }).kind, 'in-sync');
	check('stack-managed domain is in sync (pre-upgrade stack, default TLS)',
		reconcileLiveDomain(
			{ CustomDomain: 'notes.example.com', CertificateArn: CERT },
			{ aliases: ['notes.example.com'], acmCertificateArn: CERT, minimumProtocolVersion: 'TLSv1.2_2021' },
			{}).kind, 'in-sync');
	check('multi-alias stack in sync regardless of order and case',
		reconcileLiveDomain(
			{ CustomDomain: 'Example.com', AdditionalAliases: 'www.example.com, notes.example.com', CertificateArn: CERT, MinimumProtocolVersion: 'TLSv1.3_2025' },
			{ aliases: ['notes.example.com', 'example.com', 'WWW.example.com'], acmCertificateArn: CERT, minimumProtocolVersion: 'TLSv1.3_2025' },
			{}).kind, 'in-sync');
	check('in sync: caller may change the domain normally',
		reconcileLiveDomain(
			{ CustomDomain: 'old.example.com', CertificateArn: CERT },
			{ aliases: ['old.example.com'], acmCertificateArn: CERT, minimumProtocolVersion: DEFAULT_MIN_TLS },
			{ CustomDomain: 'new.example.com', CertificateArn: OTHER_CERT }).kind, 'in-sync');

	// --- Partial drift ---
	check('TLS policy changed by hand is adopted',
		reconcileLiveDomain(
			{ CustomDomain: 'notes.example.com', CertificateArn: CERT },
			{ aliases: ['notes.example.com'], acmCertificateArn: CERT, minimumProtocolVersion: 'TLSv1.3_2025' },
			{}),
		{ kind: 'adopt', params: { CustomDomain: 'notes.example.com', AdditionalAliases: '', CertificateArn: CERT, MinimumProtocolVersion: 'TLSv1.3_2025' }, dropped: [] });
	check('certificate swapped by hand is adopted',
		reconcileLiveDomain(
			{ CustomDomain: 'notes.example.com', CertificateArn: CERT },
			{ aliases: ['notes.example.com'], acmCertificateArn: OTHER_CERT, minimumProtocolVersion: DEFAULT_MIN_TLS },
			{}).params?.CertificateArn, OTHER_CERT);
	check('alias added by hand keeps the stack domain as primary',
		reconcileLiveDomain(
			{ CustomDomain: 'notes.example.com', CertificateArn: CERT },
			{ aliases: ['www.example.com', 'notes.example.com'], acmCertificateArn: CERT, minimumProtocolVersion: DEFAULT_MIN_TLS },
			{}, 'unrelated.example.org').params,
		{ CustomDomain: 'notes.example.com', AdditionalAliases: 'www.example.com', CertificateArn: CERT, MinimumProtocolVersion: DEFAULT_MIN_TLS });
	check('domain removed by hand stays removed and is reported',
		reconcileLiveDomain(
			{ CustomDomain: 'notes.example.com', CertificateArn: CERT },
			{ aliases: [] },
			{}),
		{ kind: 'adopt', params: { CustomDomain: '', AdditionalAliases: '', CertificateArn: '', MinimumProtocolVersion: DEFAULT_MIN_TLS }, dropped: ['notes.example.com'] });

	// --- Refusals ---
	const changing = reconcileLiveDomain(
		{ CustomDomain: '', CertificateArn: '' },
		{ aliases: ['zach.nz'], acmCertificateArn: CERT, minimumProtocolVersion: DEFAULT_MIN_TLS },
		{ CustomDomain: 'new.example.com', CertificateArn: OTHER_CERT });
	check('drift plus a deliberate domain change is refused', changing.kind, 'conflict');
	check('refusal names the changed params', /CustomDomain, CertificateArn/.test(changing.reason || ''), true);
	check('IAM server certificate is refused',
		reconcileLiveDomain({ CustomDomain: '' }, { aliases: ['zach.nz'], iamCertificateId: 'ASCAEXAMPLE' }, {}).kind, 'conflict');
	check('aliases without a custom certificate are refused',
		reconcileLiveDomain({ CustomDomain: '' }, { aliases: ['zach.nz'] }, {}).kind, 'conflict');

	// --- Helpers ---
	check('renderedAliases ignores extras without a primary', renderedAliases({ CustomDomain: '', AdditionalAliases: 'a.com' }), []);
	check('renderedAliases dedupes and lowercases', renderedAliases({ CustomDomain: 'A.com', AdditionalAliases: 'b.com,a.com, ' }), ['a.com', 'b.com']);
	check('hostOf parses a base URL', hostOf('https://Zach.nz/'), 'zach.nz');
	check('hostOf tolerates junk', hostOf('not a url'), undefined);
	check('hostOf tolerates empty', hostOf(''), undefined);

	report();
}

function report() {
	if (failures.length === 0) {
		console.log('All domain drift cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} domain drift assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main();
