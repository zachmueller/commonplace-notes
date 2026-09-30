// Viewer-request Lambda@Edge for built-in Cognito + Google auth.
//
// Responsibilities:
//   * Valid `cpn_id` session cookie (a raw Cognito id_token) -> verify it
//     against the pool JWKS and pass the request through to the origin.
//   * No / invalid cookie:
//       - top-level navigation -> 302 to the Cognito Hosted UI
//         (identity_provider=Google), redirect_uri host-relative.
//       - data fetch (notes JSON, mappings, config) -> 401 with
//         `x-cpn-auth: required`, which the SPA turns into a reload (and thus a
//         navigation that gets the 302). A fetch() cannot follow a cross-origin
//         302 to the Hosted UI, so redirecting data requests only breaks them.
//   * Per-note access groups (see docs/auth-and-access.md):
//       - `/restricted/<group>/...` additionally requires `<group>` to be in the
//         token's `cognito:groups` claim (set by the pool's pre-token-generation
//         trigger from the plugin-managed groups.json). Otherwise
//         403 with `x-cpn-auth: forbidden`.
//       - `GET /restricted/whoami` answers `{ groups, email, signedIn }` from the
//         verified token, so the SPA knows which partitions to load without probing.
//
// Public-reads mode (`CFG.publicReads`, a public site that only gates the notes
// that list access groups):
//   * Every path outside `/restricted/` passes straight through: no cookie read,
//     no token verification, no JWKS fetch. Public notes stay anonymous.
//   * `GET /restricted/whoami` without a valid token answers 200
//     `{ groups: [], signedIn: false }`. A 401 here would make the SPA's
//     `cpnAuthGate` reload the page on a public site.
//   * `/restricted/<group>/...` without a valid token, or without membership,
//     gets the same 403 `x-cpn-auth: forbidden`, even for a navigation. The SPA
//     only fetch()es restricted paths (it can't follow a cross-origin 302 to the
//     Hosted UI), and one uniform answer for "signed out" and "not a member"
//     tells an anonymous reader nothing about whether a note exists. The SPA
//     offers sign-in itself, from whoami's `signedIn` flag.
//
// Packaging: an S3 asset (see infrastructure/lib/cognito-edge-stack.ts). The
// plugin bakes a leading `const CFG = {...};` line (Lambda@Edge forbids env
// vars) ahead of lib-jwt-verify.js + this file. No inline size cap applies.
//
// `CFG` shape:
//   { domain, clientId, region, userPoolId, publicReads }
//   domain = full https Hosted UI origin; publicReads = true for public sites.

const JWKS_URI = 'https://cognito-idp.' + CFG.region + '.amazonaws.com/' + CFG.userPoolId + '/.well-known/jwks.json';
const TOKEN_ISS = 'https://cognito-idp.' + CFG.region + '.amazonaws.com/' + CFG.userPoolId;
const TOKEN_AUD = CFG.clientId;

const RESTRICTED_PREFIX = '/restricted/';
const WHOAMI_URI = '/restricted/whoami';
// Must match the plugin's group-name validation (src/utils/access.ts).
const GROUP_NAME_RE = /^[a-z0-9-]{1,40}$/;

function header(name, value) {
	return [{ key: name, value: value }];
}

// A no-store JSON response tagged with the `x-cpn-auth` header the SPA keys on.
function jsonResponse(status, authValue, bodyObj) {
	const headers = {
		'content-type': header('Content-Type', 'application/json'),
		'cache-control': header('Cache-Control', 'no-store'),
	};
	if (authValue) headers['x-cpn-auth'] = header('X-Cpn-Auth', authValue);
	return { status: String(status), headers: headers, body: JSON.stringify(bodyObj) };
}

function loginRedirect(request) {
	const host = request.headers.host[0].value;
	const state = encodeURIComponent(request.uri + (request.querystring ? '?' + request.querystring : ''));
	const redirectUri = encodeURIComponent('https://' + host + '/auth/callback');
	const location =
		CFG.domain + '/oauth2/authorize' +
		'?client_id=' + encodeURIComponent(CFG.clientId) +
		'&response_type=code' +
		'&scope=' + encodeURIComponent('openid email profile') +
		'&identity_provider=Google' +
		'&redirect_uri=' + redirectUri +
		'&state=' + state;
	return {
		status: '302',
		statusDescription: 'Found',
		headers: {
			location: header('Location', location),
			'cache-control': header('Cache-Control', 'no-store'),
		},
	};
}

// True for a top-level document navigation; false for a data/subresource fetch.
// Prefers Fetch Metadata headers, then falls back to the path and Accept header
// for older clients. Mirrors password-edge.js.
function isNavigation(request) {
	const h = request.headers || {};
	const mode = h['sec-fetch-mode'] && h['sec-fetch-mode'][0].value;
	const dest = h['sec-fetch-dest'] && h['sec-fetch-dest'][0].value;
	if (mode === 'navigate' || dest === 'document') return true;
	if (mode || dest) return false;
	if (/\.json$/.test(request.uri || '')) return false;
	if ((request.uri || '').indexOf(RESTRICTED_PREFIX) === 0) return false;
	const accept = h.accept && h.accept[0].value;
	return !!accept && accept.indexOf('text/html') !== -1;
}

function tokenGroups(claims) {
	const g = claims['cognito:groups'];
	if (Array.isArray(g)) return g.filter((x) => typeof x === 'string');
	// Some token shapes carry a single group as a string.
	if (typeof g === 'string' && g) return [g];
	return [];
}

// Group segment of `/restricted/<group>/...`, or null if malformed.
function restrictedGroup(uri) {
	const group = uri.slice(RESTRICTED_PREFIX.length).split('/')[0];
	return GROUP_NAME_RE.test(group) ? group : null;
}

exports.handler = async (event) => {
	const request = event.Records[0].cf.request;
	const uri = request.uri || '/';

	// Let the OAuth callback through unauthenticated; it is what sets the cookie.
	if (uri.indexOf('/auth/') === 0) return request;

	// Public site: only the restricted partitions need a token.
	const publicReads = CFG.publicReads === true;
	if (publicReads && uri.indexOf(RESTRICTED_PREFIX) !== 0) return request;

	const cookieHeader = request.headers.cookie ? request.headers.cookie.map((h) => h.value).join('; ') : '';
	const token = readCpnCookie(cookieHeader);
	const claims = token ? await verifyIdToken(token) : null;
	if (!claims) {
		if (publicReads) {
			return uri === WHOAMI_URI
				? jsonResponse(200, null, { groups: [], email: '', signedIn: false })
				: jsonResponse(403, 'forbidden', { error: 'cpn_forbidden' });
		}
		return isNavigation(request)
			? loginRedirect(request)
			: jsonResponse(401, 'required', { error: 'cpn_auth_required' });
	}

	if (uri === WHOAMI_URI) {
		return jsonResponse(200, null, { groups: tokenGroups(claims), email: claims.email || '', signedIn: true });
	}

	if (uri.indexOf(RESTRICTED_PREFIX) === 0) {
		const group = restrictedGroup(uri);
		if (!group || tokenGroups(claims).indexOf(group) === -1) {
			return jsonResponse(403, 'forbidden', { error: 'cpn_forbidden' });
		}
	}

	return request;
};
