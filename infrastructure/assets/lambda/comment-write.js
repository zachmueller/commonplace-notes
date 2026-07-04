// Comment write API handler: POST (create), PATCH (edit), DELETE (soft-delete).
//
// Each comment is a single authoritative DynamoDB item (the item IS the current
// state — no event sourcing). Identity comes from the cookie authorizer's
// context (authorId = claims.sub); edit/delete require authorId == the stored
// item's authorId. Comment UIDs are minted here server-side (the reader's
// browser never runs the plugin's uid.ts).
//
// Uses the bare @aws-sdk/client-dynamodb (always present in the nodejs runtime)
// with hand-written AttributeValue maps — the lib-dynamodb DocumentClient is not
// guaranteed to be bundled.
//
// env: TABLE_NAME
//
// HTTP API payload format 2.0. Routes (all under /api/comments):
//   POST   { noteUid, noteHash, body, parentCommentUid?, quote? }
//   PATCH  { commentUid, noteUid, createdAt, body }
//   DELETE { commentUid, noteUid, createdAt }

const { DynamoDBClient, PutItemCommand, GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

// Look up the poster's chosen username (denormalized onto each comment so the
// read path needs no join). Set once via /api/me; see comment-me.js.
async function usernameOf(ddb, table, sub) {
	const out = await ddb.send(new GetItemCommand({
		TableName: table,
		Key: { PK: { S: 'USER#' + sub }, SK: { S: 'PROFILE' } },
	}));
	return out.Item && out.Item.username && out.Item.username.S ? out.Item.username.S : null;
}
const crypto = require('crypto');

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;

// Crockford Base32 — kept in sync with src/utils/uid.ts (excludes I, L, O, U).
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function mintUid(len) {
	const n = len || 8;
	const bytes = crypto.randomBytes(n);
	let out = '';
	for (let i = 0; i < n; i++) out += CROCKFORD[bytes[i] % 32];
	return out;
}

function pk(noteUid) { return 'NOTE#' + noteUid; }
function sk(createdAt, commentUid) { return 'COMMENT#' + createdAt + '#' + commentUid; }

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

exports.handler = async (event) => {
	const authorId = authorOf(event);
	if (!authorId) return resp(401, { error: 'unauthorized' });

	const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || '';
	let payload = {};
	try { payload = event.body ? JSON.parse(event.body) : {}; } catch (e) { return resp(400, { error: 'invalid json' }); }

	if (method === 'POST') {
		const { noteUid, noteHash, body, parentCommentUid, quote } = payload;
		if (!noteUid || !body) return resp(400, { error: 'noteUid and body are required' });
		// Every commenter must have claimed a username (the widget enforces this
		// via /api/me before enabling the composer; this is the server guard).
		const authorName = await usernameOf(ddb, TABLE, authorId);
		if (!authorName) return resp(409, { error: 'choose a username first' });
		const commentUid = mintUid(8);
		const now = Math.floor(Date.now() / 1000);
		const item = {
			PK: { S: pk(noteUid) },
			SK: { S: sk(now, commentUid) },
			commentUid: { S: commentUid },
			noteUid: { S: noteUid },
			noteHash: { S: noteHash || '' },
			authorId: { S: authorId },
			authorName: { S: authorName },
			body: { S: body },
			createdAt: { N: String(now) },
			updatedAt: { N: String(now) },
			status: { S: 'active' },
		};
		if (parentCommentUid) item.parentCommentUid = { S: parentCommentUid };
		if (quote) item.quote = { S: JSON.stringify(quote) };
		await ddb.send(new PutItemCommand({ TableName: TABLE, Item: item }));
		return resp(201, { commentUid, createdAt: now });
	}

	if (method === 'PATCH' || method === 'DELETE') {
		const { commentUid, noteUid, createdAt, body } = payload;
		if (!commentUid || !noteUid || !createdAt) {
			return resp(400, { error: 'commentUid, noteUid and createdAt are required' });
		}

		const key = { PK: { S: pk(noteUid) }, SK: { S: sk(createdAt, commentUid) } };
		const existing = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: key }));
		if (!existing.Item) return resp(404, { error: 'not found' });
		if (!existing.Item.authorId || existing.Item.authorId.S !== authorId) return resp(403, { error: 'forbidden' });

		const now = Math.floor(Date.now() / 1000);
		if (method === 'DELETE') {
			await ddb.send(new UpdateItemCommand({
				TableName: TABLE,
				Key: key,
				UpdateExpression: 'SET #s = :deleted, updatedAt = :now',
				ExpressionAttributeNames: { '#s': 'status' },
				ExpressionAttributeValues: { ':deleted': { S: 'deleted' }, ':now': { N: String(now) } },
			}));
			return resp(200, { commentUid, status: 'deleted' });
		}

		if (!body) return resp(400, { error: 'body is required' });
		await ddb.send(new UpdateItemCommand({
			TableName: TABLE,
			Key: key,
			UpdateExpression: 'SET body = :b, updatedAt = :now',
			ExpressionAttributeValues: { ':b': { S: body }, ':now': { N: String(now) } },
		}));
		return resp(200, { commentUid, status: 'active' });
	}

	return resp(405, { error: 'method not allowed' });
};
