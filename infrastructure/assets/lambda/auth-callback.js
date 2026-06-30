// OAuth callback handler for built-in Cognito + Google auth.
//
// Regional Lambda (NOT Lambda@Edge), fronted by the site's CloudFront
// distribution at `/auth/callback` so the cookie it sets is first-party to the
// site origin (and therefore rides along to `/comments/*` for the comment write
// path). Because it is a normal regional function, environment variables are
// available — config is read from process.env (injected by the CDK stack).
//
// Flow: receives `?code=...&state=...` from the Hosted UI, exchanges the code at
// the Cognito token endpoint for an id token, sets it as an HttpOnly session
// cookie, and 302-redirects back to the original path carried in `state`.
//
// env: COGNITO_DOMAIN (full https Hosted UI origin), CLIENT_ID, CLIENT_SECRET
//
// This is an API Gateway HTTP API (payload format 2.0) integration.

const https = require('https');

function tokenExchange(body) {
	return new Promise((resolve, reject) => {
		const data = new URLSearchParams(body).toString();
		const url = new URL(process.env.COGNITO_DOMAIN + '/oauth2/token');
		const auth = Buffer.from(process.env.CLIENT_ID + ':' + process.env.CLIENT_SECRET).toString('base64');
		const req = https.request(
			url,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'Content-Length': Buffer.byteLength(data),
					Authorization: 'Basic ' + auth,
				},
			},
			(res) => {
				let b = '';
				res.on('data', (d) => { b += d; });
				res.on('end', () => resolve({ status: res.statusCode, body: b }));
			},
		);
		req.on('error', reject);
		req.write(data);
		req.end();
	});
}

// Only allow same-site relative redirect targets (defend against open redirect).
function safePath(state) {
	try {
		const p = decodeURIComponent(state || '');
		if (p.startsWith('/') && !p.startsWith('//')) return p;
	} catch (e) { /* fall through */ }
	return '/';
}

exports.handler = async (event) => {
	const q = (event && event.queryStringParameters) || {};
	const host = (event.headers && (event.headers.host || event.headers.Host)) || '';
	const dest = safePath(q.state);

	if (!q.code) {
		return { statusCode: 302, headers: { Location: dest }, body: '' };
	}

	try {
		const redirectUri = 'https://' + host + '/auth/callback';
		const res = await tokenExchange({
			grant_type: 'authorization_code',
			client_id: process.env.CLIENT_ID,
			code: q.code,
			redirect_uri: redirectUri,
		});
		if (res.status !== 200) {
			return { statusCode: 502, body: 'Token exchange failed' };
		}
		const tokens = JSON.parse(res.body);
		const idToken = tokens.id_token;
		if (!idToken) {
			return { statusCode: 502, body: 'No id_token in token response' };
		}
		const cookie =
			'cpn_id=' + idToken +
			'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600';
		return {
			statusCode: 302,
			headers: { Location: dest },
			cookies: [cookie],
			body: '',
		};
	} catch (e) {
		return { statusCode: 502, body: 'Auth callback error' };
	}
};
