// Cognito pre-token-generation trigger (V1 event) for per-note access groups.
//
// On every token issuance (sign-in and refresh) this looks up the signing-in
// user's email in the plugin-managed membership file and injects the matching
// group names as the id token's `cognito:groups` claim. The viewer-request edge
// function (auth-edge.js) then allows `/restricted/<group>/...` only for tokens
// that carry `<group>`.
//
// Why a trigger instead of real Cognito groups: federated Google users do not
// exist in the pool until their first sign-in, so the plugin cannot add them to
// pool groups ahead of time. groupOverrideDetails works without the groups
// existing in the pool.
//
// Membership file (JSON, written by the plugin to the bootstrap bucket):
//   { "version": 1, "groups": { "<group>": ["alice@example.com", ...] } }
//
// Environment (regional Lambda, so env vars are allowed):
//   GROUPS_BUCKET — bucket holding the membership file ('' disables the lookup)
//   GROUPS_KEY    — object key of the membership file
//
// Fails closed: any error yields no groups, never a sign-in failure.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({});
const CACHE_TTL_MS = 60 * 1000;

let cached = null;
let cachedAt = 0;

async function loadMembership() {
	const now = Date.now();
	if (cached && now - cachedAt < CACHE_TTL_MS) return cached;
	const bucket = process.env.GROUPS_BUCKET;
	const key = process.env.GROUPS_KEY;
	if (!bucket || !key) return {};
	try {
		const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
		const text = await resp.Body.transformToString();
		const parsed = JSON.parse(text);
		cached = parsed && typeof parsed.groups === 'object' && parsed.groups ? parsed.groups : {};
	} catch (err) {
		// NoSuchKey (no groups defined yet) or a transient error: no groups.
		console.warn('pre-token-groups: membership lookup failed', err && err.name);
		cached = {};
	}
	cachedAt = now;
	return cached;
}

function groupsForEmail(membership, email) {
	if (!email) return [];
	const needle = String(email).trim().toLowerCase();
	const out = [];
	for (const group of Object.keys(membership)) {
		const members = membership[group];
		if (!Array.isArray(members)) continue;
		if (members.some((m) => typeof m === 'string' && m.trim().toLowerCase() === needle)) {
			out.push(group);
		}
	}
	return out.sort();
}

exports.groupsForEmail = groupsForEmail;

exports.handler = async (event) => {
	const attrs = (event.request && event.request.userAttributes) || {};
	// Only trust a verified email. Google-federated emails map email_verified.
	const verified = attrs.email_verified === 'true' || attrs.email_verified === true;
	let groups = [];
	if (attrs.email && verified) {
		groups = groupsForEmail(await loadMembership(), attrs.email);
	}
	event.response = event.response || {};
	event.response.claimsOverrideDetails = {
		groupOverrideDetails: { groupsToOverride: groups },
	};
	return event;
};
