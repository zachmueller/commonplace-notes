// Comment re-export Lambda: DynamoDB Streams -> S3.
//
// On any add/edit/delete, re-Query the affected note's partition, fold the
// current state (drop status=deleted, keep edits, sort chronologically by SK),
// and PutObject {note_uid}.json to the comment bucket. Bodies are stored as raw
// Markdown — the client renders/sanitizes at display time.
//
// IDEMPOTENT BY CONSTRUCTION: it always rebuilds the whole note file from the
// current table state (never from the stream delta), so duplicate/retried
// stream records converge to the same object. Failures go to a DLQ via the
// event source mapping's OnFailure destination.
//
// env: TABLE_NAME, COMMENT_BUCKET

const { DynamoDBClient, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});
const TABLE = process.env.TABLE_NAME;
const BUCKET = process.env.COMMENT_BUCKET;

// Collect the distinct note UIDs touched by this batch of stream records.
function affectedNoteUids(event) {
	const uids = new Set();
	for (const rec of event.Records || []) {
		const img = (rec.dynamodb && (rec.dynamodb.NewImage || rec.dynamodb.OldImage)) || {};
		if (img.noteUid && img.noteUid.S) uids.add(img.noteUid.S);
	}
	return [...uids];
}

async function queryPartition(noteUid) {
	const items = [];
	let lastKey;
	do {
		const out = await ddb.send(new QueryCommand({
			TableName: TABLE,
			KeyConditionExpression: 'PK = :pk',
			ExpressionAttributeValues: { ':pk': { S: 'NOTE#' + noteUid } },
			ExclusiveStartKey: lastKey,
		}));
		for (const it of out.Items || []) items.push(it);
		lastKey = out.LastEvaluatedKey;
	} while (lastKey);
	return items;
}

// Build the public comment view for a note: chronological, deleted bodies
// redacted (kept as tombstones so threading/reply structure survives).
function buildView(items) {
	const comments = items
		.map((it) => {
			const deleted = it.status && it.status.S === 'deleted';
			let quote = null;
			if (it.quote && it.quote.S) { try { quote = JSON.parse(it.quote.S); } catch (e) { quote = null; } }
			return {
				commentUid: it.commentUid && it.commentUid.S,
				noteHash: (it.noteHash && it.noteHash.S) || '',
				parentCommentUid: (it.parentCommentUid && it.parentCommentUid.S) || null,
				authorId: (it.authorId && it.authorId.S) || '',
				body: deleted ? null : (it.body && it.body.S) || '',
				createdAt: it.createdAt ? Number(it.createdAt.N) : 0,
				updatedAt: it.updatedAt ? Number(it.updatedAt.N) : 0,
				status: deleted ? 'deleted' : 'active',
				quote: deleted ? null : quote,
			};
		})
		.sort((a, b) => a.createdAt - b.createdAt);
	return { version: 1, comments };
}

exports.handler = async (event) => {
	for (const noteUid of affectedNoteUids(event)) {
		const items = await queryPartition(noteUid);
		const view = buildView(items);
		await s3.send(new PutObjectCommand({
			Bucket: BUCKET,
			Key: noteUid + '.json',
			Body: JSON.stringify(view),
			ContentType: 'application/json',
			CacheControl: 'public, max-age=30',
		}));
	}
};
