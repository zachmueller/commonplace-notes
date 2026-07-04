// Profile / identity API for the comment widget: GET (whoami) and POST (claim a
// username). Backs /api/me, behind the same cookie authorizer as the write API,
// so identity comes exclusively from the authorizer context (sub = claims.sub),
// never the request body.
//
// Two purposes, both surfaced to the client widget on load:
//   * GET  -> tell the widget whether the reader is signed in AND whether they
//             have already chosen a username (gates the composer + drives the
//             one-time username-setup step).
//   * POST -> claim a UNIQUE, PERMANENT username. Uniqueness across the site and
//             immutability per user are enforced atomically via TransactWriteItems
//             with two conditional puts:
//               USER#<sub>/PROFILE          (guard: attribute_not_exists -> set once)
//               USERNAME#<lower(name)>/CLAIM (guard: attribute_not_exists -> unique)
//
// Uses the bare @aws-sdk/client-dynamodb (always present in the nodejs runtime)
// with hand-written AttributeValue maps — mirrors comment-write.js.
//
// env: TABLE_NAME
//
// HTTP API payload format 2.0. Routes (under /api/me):
//   GET   -> { authenticated: true, username: <string|null> }
//   POST  { username } -> 200 { username } | 400 invalid | 409 taken/already-set

const { DynamoDBClient, GetItemCommand, TransactWriteItemsCommand } = require('@aws-sdk/client-dynamodb');

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;

// Chosen handle: 3-20 chars, letters/digits/underscore. Case-insensitive for
// uniqueness (stored lower-cased in the CLAIM key) but the display form is kept.
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

function resp(status, obj) {
	return {
		statusCode: status,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(obj),
	};
}

function authorOf(event) {
	const ctx = event.requestContext && event.requestContext.authorizer;
	const lambdaCtx = ctx && (ctx.lambda || ctx);
	return lambdaCtx && lambdaCtx.sub ? lambdaCtx.sub : null;
}

async function getUsername(sub) {
	const out = await ddb.send(new GetItemCommand({
		TableName: TABLE,
		Key: { PK: { S: 'USER#' + sub }, SK: { S: 'PROFILE' } },
	}));
	return out.Item && out.Item.username && out.Item.username.S ? out.Item.username.S : null;
}

exports.handler = async (event) => {
	const sub = authorOf(event);
	if (!sub) return resp(401, { error: 'unauthorized' });

	const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || '';

	if (method === 'GET') {
		const username = await getUsername(sub);
		return resp(200, { authenticated: true, username });
	}

	if (method === 'POST') {
		let payload = {};
		try { payload = event.body ? JSON.parse(event.body) : {}; } catch (e) { return resp(400, { error: 'invalid json' }); }
		const username = (payload.username || '').trim();
		if (!USERNAME_RE.test(username)) {
			return resp(400, { error: 'username must be 3-20 letters, digits or underscore' });
		}
		const now = Math.floor(Date.now() / 1000);
		try {
			await ddb.send(new TransactWriteItemsCommand({
				TransactItems: [
					{
						Put: {
							TableName: TABLE,
							Item: {
								PK: { S: 'USER#' + sub },
								SK: { S: 'PROFILE' },
								username: { S: username },
								createdAt: { N: String(now) },
							},
							ConditionExpression: 'attribute_not_exists(PK)',
						},
					},
					{
						Put: {
							TableName: TABLE,
							Item: {
								PK: { S: 'USERNAME#' + username.toLowerCase() },
								SK: { S: 'CLAIM' },
								authorId: { S: sub },
								createdAt: { N: String(now) },
							},
							ConditionExpression: 'attribute_not_exists(PK)',
						},
					},
				],
			}));
			return resp(200, { username });
		} catch (e) {
			if (e && e.name === 'TransactionCanceledException') {
				// Either the user already claimed a handle, or the name is taken.
				const existing = await getUsername(sub);
				if (existing) return resp(409, { error: 'username already set', username: existing });
				return resp(409, { error: 'username taken' });
			}
			return resp(500, { error: 'could not set username' });
		}
	}

	return resp(405, { error: 'method not allowed' });
};
