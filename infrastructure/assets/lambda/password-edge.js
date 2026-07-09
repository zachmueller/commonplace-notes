// Viewer-request Lambda@Edge for built-in password read-gating.
//
// The canonical "readable by anyone with a password" gate. Instead of the
// browser's native HTTP Basic Auth modal (which awkwardly demands a *username*
// this gate never uses), an unauthenticated request gets a dedicated, branded
// HTML password page served directly as the edge response:
//   * No / invalid `cpn_pw` session cookie -> 200 with the inline unlock page.
//   * A cookie whose value matches CFG.hash -> pass the request to the origin.
//
// The page hashes the entered password client-side (Web Crypto; the site is
// HTTPS so `crypto.subtle` is available), stores the sha256 hex in the `cpn_pw`
// cookie, and reloads. The edge then compares that hash against CFG.hash in
// constant time. Storing the *hash* (not the plaintext) in the cookie is no
// more sensitive than the hash already baked into this publicly-readable edge
// fn — an accepted trade-off for a shared, low-sensitivity read password.
//
// A wrong password is detected without any extra handler branch: reaching this
// page while still holding a `cpn_pw` cookie means the edge just rejected it,
// so the page shows the error and clears the stale cookie on load.
//
// Navigation vs. data: only a top-level document navigation gets the HTML unlock
// page. A gated *data* request (fetch of /notes/*.json, /static/**, config.json)
// gets a small `401 {x-cpn-auth: required}` JSON instead — so the SPA can tell an
// expired session apart from a missing note (and from an unrelated API 401) and
// force a re-auth reload, rather than trying to parse the unlock HTML as note
// JSON and rendering a misleading "no permission" error. Both responses carry an
// `x-cpn-auth` header the client keys on.
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
//   { hash, realm }   // hash = lowercase hex sha256 of the shared password,
//                     // realm = site name shown as the page heading

const crypto = require('crypto');

// Constant-time compare of two equal-length lowercase hex strings.
function hexEqual(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
	return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// The branded unlock page. Single-quoted concatenation only (no backticks / no
// ${...}) so it survives Fn::Join. Client JS hashes the password, sets the
// cookie, and reloads; on load it surfaces the error for a rejected attempt.
function passwordPage() {
	const style =
		':root{color-scheme:light dark}' +
		'*{box-sizing:border-box}' +
		'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
		'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
		'background:Canvas;color:CanvasText;padding:1rem}' +
		'.c{width:min(92vw,340px);padding:2rem;border:1px solid color-mix(in srgb,CanvasText 15%,transparent);' +
		'border-radius:14px;box-shadow:0 8px 30px color-mix(in srgb,CanvasText 8%,transparent)}' +
		'h1{margin:0 0 .35rem;font-size:1.3rem;font-weight:650}' +
		'p{margin:0 0 1.35rem;opacity:.65;font-size:.92rem}' +
		'input,button{width:100%;padding:.65rem .8rem;font-size:1rem;border-radius:9px}' +
		'input{border:1px solid color-mix(in srgb,CanvasText 28%,transparent);background:Field;color:FieldText}' +
		'input:focus{outline:2px solid AccentColor;outline-offset:1px}' +
		'button{margin-top:.85rem;border:0;background:AccentColor;color:AccentColorText;font-weight:600;cursor:pointer}' +
		'#e{display:none;margin-top:.85rem;font-size:.85rem;color:#d64949}';
	const script =
		'var f=document.getElementById("f"),e=document.getElementById("e");' +
		'function clr(){document.cookie="cpn_pw=; Max-Age=0; Path=/; Secure; SameSite=Lax"}' +
		'if(/(?:^|;\\s*)cpn_pw=/.test(document.cookie)){e.style.display="block";clr()}' +
		'async function h(s){var b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));' +
		'return Array.from(new Uint8Array(b)).map(function(x){return x.toString(16).padStart(2,"0")}).join("")}' +
		'f.addEventListener("submit",async function(ev){ev.preventDefault();' +
		'var v=document.getElementById("p").value;if(!v)return;var d=await h(v);' +
		'document.cookie="cpn_pw="+d+"; Max-Age=2592000; Path=/; Secure; SameSite=Lax";location.reload()});';
	const heading = String(CFG.realm || 'Protected').replace(/[<>&]/g, ' ');
	const html =
		'<!doctype html><html lang="en"><head><meta charset="utf-8">' +
		'<meta name="viewport" content="width=device-width,initial-scale=1">' +
		'<title>' + heading + '</title><style>' + style + '</style></head><body>' +
		'<form class="c" id="f"><h1>' + heading + '</h1><p>Enter the password to view this site.</p>' +
		'<input id="p" type="password" autocomplete="current-password" autofocus placeholder="Password">' +
		'<button type="submit">Unlock</button><div id="e">Incorrect password. Try again.</div></form>' +
		'<script>' + script + '</script></body></html>';
	return reply('200', 'text/html; charset=UTF-8', 'password', html);
}

// Build a no-store CloudFront response tagged with the `x-cpn-auth` header the
// SPA keys on. Shared by the unlock page and the data 401.
function reply(status, ctype, authVal, body) {
	return {
		status: status,
		headers: {
			'content-type': [{ key: 'Content-Type', value: ctype }],
			'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
			'x-cpn-auth': [{ key: 'X-Cpn-Auth', value: authVal }],
		},
		body: body,
	};
}

// The data-request response for a missing/invalid cookie: a tiny JSON 401 the
// SPA keys on (x-cpn-auth: required) to force a re-auth reload. No
// WWW-Authenticate header, so no native Basic Auth modal.
function authRequired() {
	return reply('401', 'application/json', 'required', '{"error":"cpn_auth_required"}');
}

// True for a top-level document navigation (gets the HTML unlock page); false
// for a data/subresource fetch (gets authRequired). Prefers the Fetch Metadata
// headers, then falls back to Accept vs. the request path for older clients.
function isNavigation(request) {
	const h = request.headers || {};
	const mode = h['sec-fetch-mode'] && h['sec-fetch-mode'][0].value;
	const dest = h['sec-fetch-dest'] && h['sec-fetch-dest'][0].value;
	if (mode === 'navigate' || dest === 'document') return true;
	if (mode || dest) return false;
	if (/\.json$/.test(request.uri || '')) return false;
	const accept = h.accept && h.accept[0].value;
	return !!accept && accept.indexOf('text/html') !== -1;
}

exports.handler = async (event) => {
	const request = event.Records[0].cf.request;
	const headers = request.headers;
	const cookieHeader = headers.cookie ? headers.cookie.map((h) => h.value).join('; ') : '';
	const m = cookieHeader.match(/(?:^|;\s*)cpn_pw=([a-f0-9]{64})(?:;|$)/);
	if (m && hexEqual(m[1], CFG.hash)) return request;
	return isNavigation(request) ? passwordPage() : authRequired();
};
