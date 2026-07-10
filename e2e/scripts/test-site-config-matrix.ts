#!/usr/bin/env npx tsx
/**
 * Site config.json + Cognito URL Matrix Unit Test
 *
 * Exercises the pure logic that turns a publishing profile's read-gate /
 * commenting / auth settings into the site's `config.json` (consumed client-side
 * via window.__CPN_CONFIG__), plus the Cognito Hosted UI / Google OAuth URL
 * helpers. These decide whether the deployed site shows the comment widget, gates
 * reads, and which login URL it points at — the runtime consequence of the many
 * deployment variants, validated here without Obsidian or AWS.
 *
 * Pure functions — no AWS SDK; the only transitive `obsidian` import is types-only
 * (empty runtime main), so this imports cleanly under tsx.
 *
 * Run: npx tsx e2e/scripts/test-site-config-matrix.ts
 */

import * as siteRendererModule from '../../src/publish/siteRenderer';
import * as cognitoUrlsModule from '../../src/infrastructure/cognitoUrls';
import { type PublishingProfile } from '../../src/types';

// Under this repo's tsx/Node ESM setup, named exports from a src .ts module are
// sometimes surfaced under `default` (same workaround as test-cert-match.ts).
const siteRenderer: any =
	(siteRendererModule as any).renderConfigJson !== undefined
		? siteRendererModule
		: (siteRendererModule as any).default;
const cognitoUrls: any =
	(cognitoUrlsModule as any).googleOAuthUrls !== undefined
		? cognitoUrlsModule
		: (cognitoUrlsModule as any).default;

const { renderConfigJson } = siteRenderer;
const { cognitoHostedUiDomain, googleOAuthUrls } = cognitoUrls;

const failures: string[] = [];

function check(label: string, cond: boolean, detail?: string) {
	if (!cond) failures.push(`${label}${detail ? `: ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOSTED_UI = 'https://my-notes-auth.auth.us-west-2.amazoncognito.com';
const CLIENT_ID = '11112222-3333.apps.googleusercontent.com';

type ProfileShape = {
	readGateMode?: string;
	commentIdentity?: boolean;
	commentingEnabled?: boolean;
	hostedUiDomain?: string;
	userPoolClientId?: string;
	baseUrl?: string;
};

/**
 * Build a minimal PublishingProfile whose fields drive renderConfigJson's
 * commenting/auth branch. renderConfigJson reads the DEPLOYMENT bookkeeping
 * (infrastructureState.cognitoAuth + infrastructureState.readGateMode), not the
 * author-intent profile.cognitoAuth — so populate that.
 */
function makeProfile(shape: ProfileShape): PublishingProfile {
	const {
		readGateMode = 'none',
		commentIdentity = false,
		commentingEnabled = false,
		hostedUiDomain = HOSTED_UI,
		userPoolClientId = CLIENT_ID,
		baseUrl = 'https://d999888.cloudfront.net/',
	} = shape;

	return {
		name: 'Test',
		id: 'test',
		lastFullPublishTimestamp: 0,
		excludedDirectories: [],
		baseUrl,
		homeNotePath: '',
		isPublic: true,
		publishContentIndex: false,
		publishMechanism: 'AWS',
		indicator: { style: 'color', color: '#3366cc' },
		commenting: { enabled: commentingEnabled },
		infrastructureState: {
			status: 'deployed',
			useRoute53: false,
			originAccessMethod: 'oac',
			readGateMode: readGateMode as any,
			cognitoAuth: {
				stackName: 'cpn-cognito-test',
				enabled: true,
				commentIdentity,
				userPoolId: 'us-west-2_pool',
				userPoolClientId,
				hostedUiDomain,
				jwksUri: 'https://example/.well-known/jwks.json',
				issuer: 'https://example/issuer',
				edgeFunctionVersionArn: 'arn:aws:lambda:us-east-1:1:function:f:1',
				callbackApiDomain: 'api.example.com',
			},
		} as any,
	} as PublishingProfile;
}

function config(shape: ProfileShape): Record<string, any> {
	return JSON.parse(renderConfigJson(makeProfile(shape)));
}

// ---------------------------------------------------------------------------
// renderConfigJson matrix
// ---------------------------------------------------------------------------

function testConfigMatrix() {
	// commentsEnabled requires BOTH commenting.enabled AND cognitoAuth.commentIdentity.
	const bothOn = config({ commentIdentity: true, commentingEnabled: true });
	check('comments both-on: commentsEnabled', bothOn.commentsEnabled === true, JSON.stringify(bothOn.commentsEnabled));
	check('comments both-on: read path', bothOn.commentReadPath === '/comments/', bothOn.commentReadPath);
	check('comments both-on: write path', bothOn.commentWritePath === '/api/comments', bothOn.commentWritePath);

	const identityOnly = config({ commentIdentity: true, commentingEnabled: false });
	check('identity-only: commentsEnabled absent', identityOnly.commentsEnabled === undefined, JSON.stringify(identityOnly.commentsEnabled));
	check('identity-only: no login url', identityOnly.authLoginUrl === undefined);

	const commentingOnly = config({ commentIdentity: false, commentingEnabled: true });
	check('commenting-without-identity: commentsEnabled absent', commentingOnly.commentsEnabled === undefined, JSON.stringify(commentingOnly.commentsEnabled));

	const neither = config({ commentIdentity: false, commentingEnabled: false });
	check('neither: commentsEnabled absent', neither.commentsEnabled === undefined);
	check('neither: readGating absent', neither.readGating === undefined);
	check('neither: authLoginUrl absent', neither.authLoginUrl === undefined);

	// authLoginUrl present only when hostedUiDomain + userPoolClientId + baseUrl all set.
	check('both-on: authLoginUrl present', typeof bothOn.authLoginUrl === 'string' && bothOn.authLoginUrl.startsWith(HOSTED_UI + '/oauth2/authorize'), bothOn.authLoginUrl);
	check('both-on: login url has client_id', bothOn.authLoginUrl?.includes(encodeURIComponent(CLIENT_ID)) || bothOn.authLoginUrl?.includes(CLIENT_ID), bothOn.authLoginUrl);
	check('both-on: login url identity_provider=Google', bothOn.authLoginUrl?.includes('identity_provider=Google'), bothOn.authLoginUrl);
	check('both-on: redirect_uri is site /auth/callback', bothOn.authLoginUrl?.includes(encodeURIComponent('https://d999888.cloudfront.net/auth/callback')), bothOn.authLoginUrl);

	const noBaseUrl = config({ commentIdentity: true, commentingEnabled: true, baseUrl: '' });
	check('no-baseUrl: still commentsEnabled', noBaseUrl.commentsEnabled === true);
	check('no-baseUrl: authLoginUrl absent', noBaseUrl.authLoginUrl === undefined, JSON.stringify(noBaseUrl.authLoginUrl));

	const noClientId = config({ commentIdentity: true, commentingEnabled: true, userPoolClientId: '' });
	check('no-clientId: authLoginUrl absent', noClientId.authLoginUrl === undefined, JSON.stringify(noClientId.authLoginUrl));

	// readGating is TRUE only when the whole site requires Cognito login for reads.
	const cognitoReads = config({ readGateMode: 'cognito', commentIdentity: true, commentingEnabled: true });
	check('cognito reads: readGating true', cognitoReads.readGating === true, JSON.stringify(cognitoReads.readGating));

	const passwordReads = config({ readGateMode: 'password', commentIdentity: true, commentingEnabled: true });
	check('password reads + comments: readGating false', passwordReads.readGating === false, JSON.stringify(passwordReads.readGating));
	check('password reads + comments: still commentsEnabled', passwordReads.commentsEnabled === true);

	const publicReads = config({ readGateMode: 'none', commentIdentity: true, commentingEnabled: true });
	check('public reads + comments: readGating false', publicReads.readGating === false, JSON.stringify(publicReads.readGating));

	const byoReads = config({ readGateMode: 'byo', commentIdentity: true, commentingEnabled: true });
	check('byo reads + comments: readGating false', byoReads.readGating === false, JSON.stringify(byoReads.readGating));
}

// ---------------------------------------------------------------------------
// Theme overrides + per-note named styles (config.theme / config.styles)
// ---------------------------------------------------------------------------

/** Render config.json from a profile carrying only a siteCustomization block. */
function customConfig(siteCustomization: any): Record<string, any> {
	const profile = {
		name: 'T', id: 't', lastFullPublishTimestamp: 0, excludedDirectories: [],
		baseUrl: '', homeNotePath: '', isPublic: true, publishContentIndex: false,
		publishMechanism: 'AWS', indicator: { style: 'color', color: '#000' },
		siteCustomization,
	} as unknown as PublishingProfile;
	return JSON.parse(renderConfigJson(profile));
}

function testStylesAndTheme() {
	// --- emitThemeVars refactor: config.theme regression ---
	// Only set keys are emitted, camelCase → kebab-case, and a side with no set
	// keys is omitted entirely (guards preserved by the refactor).
	const themed = customConfig({
		siteTitle: 'N', headerLinks: [], panelWidth: 600, fontFamily: '',
		themeOverrides: {
			light: { bgPrimary: '#fff', linkColor: '#0366d6' },
			dark: {},
		},
	});
	check('theme: light emitted with kebab keys',
		JSON.stringify(themed.theme?.light) === JSON.stringify({ 'bg-primary': '#fff', 'link-color': '#0366d6' }),
		JSON.stringify(themed.theme?.light));
	check('theme: empty dark side omitted', themed.theme?.dark === undefined, JSON.stringify(themed.theme?.dark));

	// No overrides ⇒ no theme key at all.
	const noTheme = customConfig({ siteTitle: 'N', headerLinks: [], panelWidth: 600, fontFamily: '', themeOverrides: {} });
	check('theme: absent when nothing set', noTheme.theme === undefined, JSON.stringify(noTheme.theme));

	// --- config.styles emission ---
	const styled = customConfig({
		siteTitle: 'N', headerLinks: [], panelWidth: 600, fontFamily: '',
		themeOverrides: {},
		namedStyles: {
			ai: {
				light: { bgPrimary: '#f0f0f5' },
				dark: { bgPrimary: '#01030a' },
				fontFamily: 'monospace',
			},
			// Only a font, no colors — still emitted.
			serif: { fontFamily: 'Georgia, serif' },
			// Fully empty — must be dropped entirely.
			empty: {},
		},
	});
	check('styles: present', styled.styles !== undefined, JSON.stringify(styled.styles));
	check('styles: ai.light kebab var', styled.styles?.ai?.light?.['bg-primary'] === '#f0f0f5', JSON.stringify(styled.styles?.ai));
	check('styles: ai.dark kebab var', styled.styles?.ai?.dark?.['bg-primary'] === '#01030a');
	check('styles: ai.font emitted as font', styled.styles?.ai?.font === 'monospace', JSON.stringify(styled.styles?.ai?.font));
	check('styles: font-only style kept', styled.styles?.serif?.font === 'Georgia, serif' && styled.styles?.serif?.light === undefined, JSON.stringify(styled.styles?.serif));
	check('styles: empty style dropped', styled.styles?.empty === undefined, JSON.stringify(styled.styles?.empty));

	// No namedStyles ⇒ no styles key.
	check('styles: absent when no namedStyles', noTheme.styles === undefined, JSON.stringify(noTheme.styles));

	// A namedStyles record whose only entry is empty ⇒ no styles key.
	const allEmpty = customConfig({ siteTitle: 'N', headerLinks: [], panelWidth: 600, fontFamily: '', themeOverrides: {}, namedStyles: { x: {} } });
	check('styles: absent when all entries empty', allEmpty.styles === undefined, JSON.stringify(allEmpty.styles));
}

// ---------------------------------------------------------------------------
// cognitoUrls helpers
// ---------------------------------------------------------------------------

function testCognitoUrls() {
	check('hostedUiDomain composed',
		cognitoHostedUiDomain('my-notes-auth', 'us-west-2') === 'https://my-notes-auth.auth.us-west-2.amazoncognito.com',
		cognitoHostedUiDomain('my-notes-auth', 'us-west-2'));
	check('hostedUiDomain undefined without prefix', cognitoHostedUiDomain('', 'us-west-2') === undefined);
	check('hostedUiDomain undefined without region', cognitoHostedUiDomain('my-notes-auth', '') === undefined);
	check('hostedUiDomain undefined when both missing', cognitoHostedUiDomain(undefined, undefined) === undefined);

	const urls = googleOAuthUrls(HOSTED_UI);
	check('jsOrigin is bare domain', urls.jsOrigin === HOSTED_UI, urls.jsOrigin);
	check('jsOrigin has no path', !urls.jsOrigin.includes('/oauth2'), urls.jsOrigin);
	check('redirectUri appends idpresponse', urls.redirectUri === HOSTED_UI + '/oauth2/idpresponse', urls.redirectUri);

	// Tolerates a trailing slash on the domain.
	const trailing = googleOAuthUrls(HOSTED_UI + '/');
	check('trailing slash stripped from jsOrigin', trailing.jsOrigin === HOSTED_UI, trailing.jsOrigin);
	check('trailing slash: single idpresponse suffix', trailing.redirectUri === HOSTED_UI + '/oauth2/idpresponse', trailing.redirectUri);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function main() {
	testConfigMatrix();
	testStylesAndTheme();
	testCognitoUrls();

	if (failures.length === 0) {
		console.log('All site-config + cognito-url matrix cases passed.');
		process.exit(0);
	}
	console.log(`${failures.length} site-config matrix assertion(s) FAILED:`);
	for (const f of failures) console.log('  - ' + f);
	process.exit(1);
}

main();
