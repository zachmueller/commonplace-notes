// Cookie-based Lambda authorizer for the comment write API (Option C).
//
// A REQUEST authorizer (not JWT/TOKEN) so it can read the HttpOnly `cpn_id`
// cookie that the auth callback set — the same cookie the edge fn validates.
// Because /api/comments is same-origin with the site, the cookie rides along
// automatically; client JS never touches the token.
//
// Config comes from env vars (set by the comment stack); the JWT-verify helper
// (lib-jwt-verify.js) is concatenated ahead of this file at synth time and
// reads JWKS_URI / TOKEN_ISS / TOKEN_AUD from those same env vars.

const JWKS_URI = process.env.JWKS_URI;
const TOKEN_ISS = process.env.TOKEN_ISS;
const TOKEN_AUD = process.env.TOKEN_AUD;

function policy(effect, resource, context) {
	return {
		principalId: (context && context.sub) || 'anonymous',
		policyDocument: {
			Version: '2012-10-17',
			Statement: [{ Action: 'execute-api:Invoke', Effect: effect, Resource: resource }],
		},
		context: context || {},
	};
}

exports.handler = async (event) => {
	// API Gateway HTTP API REQUEST authorizer (payload 2.0) puts cookies on
	// event.cookies (array) and headers on event.headers.
	const resource = event.routeArn || event.methodArn || '*';
	let token = null;

	if (Array.isArray(event.cookies)) {
		for (const c of event.cookies) {
			const i = c.indexOf('=');
			if (i > -1 && c.slice(0, i).trim() === 'cpn_id') { token = c.slice(i + 1).trim(); break; }
		}
	}
	if (!token) {
		const cookieHeader = event.headers && (event.headers.cookie || event.headers.Cookie);
		token = readCpnCookie(cookieHeader);
	}

	if (!token) return policy('Deny', resource);

	const claims = await verifyIdToken(token);
	if (!claims) return policy('Deny', resource);

	return policy('Allow', resource, { sub: claims.sub, email: claims.email || '' });
};
