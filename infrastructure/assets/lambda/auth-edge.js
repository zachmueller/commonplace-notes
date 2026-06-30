// Viewer-request Lambda@Edge for built-in Cognito + Google auth.
//
// Responsibilities (intentionally minimal — see the "Built-in Cognito and
// Google identity" idea note):
//   * No / invalid `cpn_id` session cookie  -> 302 to the Cognito Hosted UI
//     (identity_provider=Google), with redirect_uri host-relative so this
//     function never needs the two-phase CallbackURL rewrite.
//   * Valid cookie -> verify the raw Cognito JWT against the pool JWKS and pass
//     the request through to the origin.
//
// Hard constraints this file is written against:
//   * Lambda@Edge forbids environment variables -> config is concatenated in by
//     the CDK stack as a leading `const CFG = {...};` (see cognito-auth-stack.ts),
//     and the shared verifier (lib-jwt-verify.js) is concatenated between them.
//   * Inline CloudFormation `ZipFile` code is capped at 4096 bytes -> the shared
//     helper is dependency-free and terse; synth reports the byte size.
//
// `CFG` (injected by the stack) has shape:
//   { domain, clientId, region, userPoolId }   // domain = full https Hosted UI origin
//
// The shared verifier expects JWKS_URI / TOKEN_ISS / TOKEN_AUD in module scope;
// derive them from CFG here (the verifier snippet follows this file at synth).

const JWKS_URI = 'https://cognito-idp.' + CFG.region + '.amazonaws.com/' + CFG.userPoolId + '/.well-known/jwks.json';
const TOKEN_ISS = 'https://cognito-idp.' + CFG.region + '.amazonaws.com/' + CFG.userPoolId;
const TOKEN_AUD = CFG.clientId;

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
	const cookieHeader = request.headers.cookie ? request.headers.cookie.map((h) => h.value).join('; ') : '';
	const token = readCpnCookie(cookieHeader);
	if (token && (await verifyIdToken(token))) return request;
	return loginRedirect(request);
};
