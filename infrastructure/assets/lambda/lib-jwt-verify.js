// Shared Cognito JWT verification, inlined (concatenated) into Lambdas that
// validate the HttpOnly `cpn_id` session cookie: the viewer-request edge fn and
// the comment write API's cookie-based authorizer.
//
// Dependency-free (Node built-in crypto/https only) so it can live in an inline
// `ZipFile`. JWKS is cached in module-global scope across warm invocations.
//
// Expects these module-scope constants to be defined by the host (via env vars
// for regional Lambdas, or a baked CFG object for the edge fn):
//   JWKS_URI    — https://cognito-idp.<region>.amazonaws.com/<pool>/.well-known/jwks.json
//   TOKEN_ISS   — https://cognito-idp.<region>.amazonaws.com/<pool>
//   TOKEN_AUD   — the app client id
//
// Exposes: verifyIdToken(token) -> claims object, or null if invalid.

const _crypto = require('crypto');
const _https = require('https');

let _JWKS = null;
let _JWKS_AT = 0;
const _JWKS_TTL = 3600000; // 1h

function _fetchJwks() {
	return new Promise((resolve, reject) => {
		_https.get(JWKS_URI, (res) => {
			let b = '';
			res.on('data', (d) => { b += d; });
			res.on('end', () => {
				try { resolve(JSON.parse(b).keys); } catch (e) { reject(e); }
			});
		}).on('error', reject);
	});
}

async function _keyForKid(kid) {
	const now = Date.now();
	if (!_JWKS || now - _JWKS_AT > _JWKS_TTL) {
		_JWKS = await _fetchJwks();
		_JWKS_AT = now;
	}
	let jwk = _JWKS.find((k) => k.kid === kid);
	if (!jwk) {
		_JWKS = await _fetchJwks();
		_JWKS_AT = Date.now();
		jwk = _JWKS.find((k) => k.kid === kid);
	}
	return jwk ? _crypto.createPublicKey({ key: jwk, format: 'jwk' }) : null;
}

function _b64urlJson(seg) {
	return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

async function verifyIdToken(token) {
	try {
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		const header = _b64urlJson(parts[0]);
		if (header.alg !== 'RS256') return null;
		const key = await _keyForKid(header.kid);
		if (!key) return null;
		const ok = _crypto.verify(
			'RSA-SHA256',
			Buffer.from(parts[0] + '.' + parts[1]),
			key,
			Buffer.from(parts[2], 'base64url'),
		);
		if (!ok) return null;
		const claims = _b64urlJson(parts[1]);
		if (claims.iss !== TOKEN_ISS) return null;
		if (claims.aud !== TOKEN_AUD) return null;
		if (claims.token_use !== 'id') return null;
		if (!claims.exp || claims.exp * 1000 <= Date.now()) return null;
		return claims;
	} catch (e) {
		return null;
	}
}

function readCpnCookie(cookieHeader) {
	if (!cookieHeader) return null;
	for (const pair of cookieHeader.split(';')) {
		const i = pair.indexOf('=');
		if (i > -1 && pair.slice(0, i).trim() === 'cpn_id') {
			return pair.slice(i + 1).trim();
		}
	}
	return null;
}
