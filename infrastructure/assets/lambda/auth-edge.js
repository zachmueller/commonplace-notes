// Viewer-request Lambda@Edge for built-in Cognito + Google auth.
//
// Responsibilities (intentionally minimal — see the "Built-in Cognito and
// Google identity" idea note):
//   * No / invalid `cpn_id` session cookie  -> 302 to the Cognito Hosted UI
//     (identity_provider=Google), with redirect_uri host-relative so this
//     function never needs the two-phase CallbackURL rewrite.
//   * Valid cookie -> verify the raw Cognito JWT signature/claims against the
//     pool JWKS and pass the request through to the origin.
//
// Hard constraints this file is written against:
//   * Lambda@Edge forbids environment variables -> config is concatenated in
//     by the CDK stack as a leading `const CFG = {...};` (see cognito-auth-stack.ts).
//   * Inline CloudFormation `ZipFile` code is capped at 4096 bytes -> keep this
//     dependency-free (Node's built-in crypto/https only) and terse. The synth
//     step reports the byte size; if it ever exceeds the cap, move to an S3
//     asset instead of inline code.
//
// `CFG` (injected by the stack) has shape:
//   { domain, clientId, region, userPoolId }   // domain = full https Hosted UI origin

const crypto = require('crypto');
const https = require('https');

// JWKS cached in module-global scope; warm across invocations on an edge node.
let JWKS = null;
let JWKS_AT = 0;
const JWKS_TTL = 3600000; // 1h

function jwksUri() {
	return 'https://cognito-idp.' + CFG.region + '.amazonaws.com/' + CFG.userPoolId + '/.well-known/jwks.json';
}
function issuer() {
	return 'https://cognito-idp.' + CFG.region + '.amazonaws.com/' + CFG.userPoolId;
}

function getJwks() {
	return new Promise((resolve, reject) => {
		https.get(jwksUri(), (res) => {
			let b = '';
			res.on('data', (d) => { b += d; });
			res.on('end', () => {
				try { resolve(JSON.parse(b).keys); } catch (e) { reject(e); }
			});
		}).on('error', reject);
	});
}

async function keyForKid(kid) {
	const now = Date.now();
	if (!JWKS || now - JWKS_AT > JWKS_TTL) {
		JWKS = await getJwks();
		JWKS_AT = now;
	}
	let jwk = JWKS.find((k) => k.kid === kid);
	if (!jwk) {
		// Unknown kid: force one refetch in case keys rotated.
		JWKS = await getJwks();
		JWKS_AT = Date.now();
		jwk = JWKS.find((k) => k.kid === kid);
	}
	return jwk ? crypto.createPublicKey({ key: jwk, format: 'jwk' }) : null;
}

function b64urlJson(seg) {
	return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

// Returns true iff the token is a structurally valid, unexpired, correctly-signed
// Cognito id token issued by this pool for this app client.
async function isValid(token) {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return false;
		const header = b64urlJson(parts[0]);
		if (header.alg !== 'RS256') return false;
		const key = await keyForKid(header.kid);
		if (!key) return false;
		const ok = crypto.verify(
			'RSA-SHA256',
			Buffer.from(parts[0] + '.' + parts[1]),
			key,
			Buffer.from(parts[2], 'base64url'),
		);
		if (!ok) return false;
		const claims = b64urlJson(parts[1]);
		if (claims.iss !== issuer()) return false;
		if (claims.aud !== CFG.clientId) return false;
		if (claims.token_use !== 'id') return false;
		if (!claims.exp || claims.exp * 1000 <= Date.now()) return false;
		return true;
	} catch (e) {
		return false;
	}
}

function readCookie(headers, name) {
	const c = headers.cookie;
	if (!c) return null;
	for (const h of c) {
		for (const pair of h.value.split(';')) {
			const i = pair.indexOf('=');
			if (i > -1 && pair.slice(0, i).trim() === name) {
				return pair.slice(i + 1).trim();
			}
		}
	}
	return null;
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
			location: [{ key: 'Location', value: location }],
			'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
		},
	};
}

exports.handler = async (event) => {
	const request = event.Records[0].cf.request;
	// Let the OAuth callback through unauthenticated; it is what sets the cookie.
	if (request.uri.indexOf('/auth/') === 0) return request;
	const token = readCookie(request.headers, 'cpn_id');
	if (token && (await isValid(token))) return request;
	return loginRedirect(request);
};
