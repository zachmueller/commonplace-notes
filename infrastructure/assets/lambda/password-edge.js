// Viewer-request Lambda@Edge for built-in password (HTTP Basic Auth) read-gating.
//
// The canonical "readable by anyone with a password" gate: no/invalid
// Authorization header -> 401 with WWW-Authenticate (native browser prompt);
// a matching password -> pass the request through to the origin. The username
// is ignored — any username plus the shared password unlocks the site.
//
// Feeds the SAME `AuthLambdaEdgeArn` seam as the Cognito edge fn (only one
// viewer-request fn attaches to the default behavior at a time), so read-gating
// is a single interchangeable axis: cognito | password | byo | none.
//
// Hard constraints (identical to auth-edge.js):
//   * Lambda@Edge forbids environment variables -> config is concatenated in by
//     the CDK stack as a leading `const CFG = {...};` (see password-auth-stack.ts).
//   * Inline CloudFormation `ZipFile` is capped at 4096 bytes -> dependency-free
//     (Node `crypto` only) and terse. The body must contain no `${...}` or
//     backticks so it can ride through Fn::Join/Fn::Sub without collisions.
//
// `CFG` (injected by the stack):
//   { hash, realm }   // hash = lowercase hex sha256 of the shared password

const crypto = require('crypto');

function sha256Hex(s) {
	return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// Constant-time compare of two equal-length lowercase hex strings.
function hexEqual(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
	return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function unauthorized() {
	return {
		status: '401',
		statusDescription: 'Unauthorized',
		headers: {
			'www-authenticate': [{ key: 'WWW-Authenticate', value: 'Basic realm="' + CFG.realm + '", charset="UTF-8"' }],
			'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
		},
		body: 'Authentication required.',
	};
}

exports.handler = async (event) => {
	const request = event.Records[0].cf.request;
	const headers = request.headers;
	const auth = headers.authorization && headers.authorization[0] && headers.authorization[0].value;
	if (!auth || auth.indexOf('Basic ') !== 0) return unauthorized();

	let decoded;
	try {
		decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
	} catch (e) {
		return unauthorized();
	}
	// Everything after the first ':' is the password (the username is ignored).
	const i = decoded.indexOf(':');
	const password = i === -1 ? '' : decoded.slice(i + 1);
	if (!password) return unauthorized();

	if (hexEqual(sha256Hex(password), CFG.hash)) return request;
	return unauthorized();
};
