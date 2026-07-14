// Streaming Bedrock chat handler for the LLM-over-published-notes feature.
//
// Exposed via a Lambda Function URL with InvokeMode: RESPONSE_STREAM, fronted by
// the same CloudFront distribution as the site so it inherits any viewer-request
// auth (Cognito / password / BYO). The Function URL itself is AuthType: NONE —
// CloudFront OAC cannot sign a forwarded POST body in a way a Function URL's IAM
// auth accepts (proven in the Phase 0 spike), so bypass protection is instead a
// CloudFront-injected shared-secret custom origin header, validated FAIL-CLOSED
// here. A request without the matching secret is rejected outright, so the
// endpoint is only reachable through the auth-gated CloudFront path.
//
// Retrieval is grounded on a Bedrock Knowledge Base whose S3 data source is
// scoped to the per-profile `kb/{uid}.md` corpus (latest-only). Citations carry
// the source object key `kb/{uid}.md`, from which we extract the UID and emit a
// `#/{uid}` deep link the site client resolves to the note.
//
// Model note: the default (Claude Sonnet 5) is INFERENCE_PROFILE-only, so
// CFG.modelArn must be an inference-profile ARN, not a bare model id. Sonnet 5
// via RetrieveAndGenerate also REQUIRES custom prompt templates for BOTH
// orchestration and generation, and the generation template MUST contain
// $output_format_instructions$ or citations come back empty. The role needs
// bedrock:GetInferenceProfile in addition to the retrieve/generate actions.
//
// SSE frames: {type:'token',text} | {type:'citation',uid,deepLink} |
// {type:'done',...} | {type:'error',error}.
//
// Config is baked into a `const CFG = {...}` line prepended at package time (the
// same S3-asset pattern as password-edge.js), because a Function URL cannot be
// templated into and we want the artifact content-addressed. CFG carries
// { knowledgeBaseId, modelArn, originSecret }.

const { BedrockAgentRuntimeClient, RetrieveAndGenerateStreamCommand } = require('@aws-sdk/client-bedrock-agent-runtime');

const client = new BedrockAgentRuntimeClient({ region: process.env.AWS_REGION });

// Strict-grounding generation template. MUST contain $search_results$, $query$
// AND $output_format_instructions$ (the last is what makes the model tag source
// spans — omitting it silently yields empty citations).
const GEN_TEMPLATE = [
	'You are a research assistant answering questions strictly and ONLY from the',
	"author's published notes provided below. Do not use any outside knowledge. If",
	'the notes do not contain the answer, say you do not have a note covering that.',
	'Keep answers concise and cite the notes you drew from.',
	'',
	'$search_results$',
	'',
	'User question: $query$',
	'',
	'$output_format_instructions$',
].join('\n');

// Orchestration template. MUST contain $conversation_history$, $query$ AND
// $output_format_instructions$.
const ORCH_TEMPLATE = [
	'$conversation_history$',
	'',
	'Given the conversation above, rephrase the following into a standalone search',
	'query for retrieving the most relevant notes: $query$',
	'$output_format_instructions$',
].join('\n');

/** Extract the note UID from a `.../kb/{uid}.md` source object key. */
function uidFromUri(uri) {
	const m = /kb\/([^/]+)\.md/.exec(uri || '');
	return m ? m[1] : null;
}

exports.handler = awslambda.streamifyResponse(async (event, responseStream, _context) => {
	const write = (obj) => responseStream.write('data: ' + JSON.stringify(obj) + '\n\n');

	// Fail-closed shared-secret check (the sole bypass protection for an
	// AuthType:NONE Function URL). Header names arrive lowercased in the Function
	// URL event.
	const headers = event.headers || {};
	if (CFG.originSecret) {
		const provided = headers['x-cpn-origin-secret'];
		if (provided !== CFG.originSecret) {
			responseStream.write('data: ' + JSON.stringify({ type: 'error', error: 'forbidden' }) + '\n\n');
			responseStream.end();
			return;
		}
	}

	let question = '';
	let sessionId;
	try {
		const raw = event.body
			? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body)
			: '{}';
		const parsed = JSON.parse(raw);
		question = (parsed.question || '').toString().trim();
		sessionId = parsed.conversationId || undefined;
	} catch (e) {
		write({ type: 'error', error: 'invalid request body' });
		responseStream.end();
		return;
	}

	if (!question) {
		write({ type: 'error', error: 'missing question' });
		responseStream.end();
		return;
	}

	try {
		const input = {
			input: { text: question },
			retrieveAndGenerateConfiguration: {
				type: 'KNOWLEDGE_BASE',
				knowledgeBaseConfiguration: {
					knowledgeBaseId: CFG.knowledgeBaseId,
					modelArn: CFG.modelArn,
					generationConfiguration: { promptTemplate: { textPromptTemplate: GEN_TEMPLATE } },
					orchestrationConfiguration: { promptTemplate: { textPromptTemplate: ORCH_TEMPLATE } },
					retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 8 } },
				},
			},
		};
		if (sessionId) input.sessionId = sessionId;

		const resp = await client.send(new RetrieveAndGenerateStreamCommand(input));
		const citedUids = new Set();
		let outSessionId;

		for await (const ev of resp.stream) {
			if (ev.output && ev.output.text) {
				write({ type: 'token', text: ev.output.text });
			}
			if (ev.citation && ev.citation.citation) {
				const refs = ev.citation.citation.retrievedReferences || [];
				for (const r of refs) {
					const uri = r.location && r.location.s3Location && r.location.s3Location.uri;
					const uid = uidFromUri(uri);
					if (uid && !citedUids.has(uid)) {
						citedUids.add(uid);
						// Site note deep links are #/u{uid} (the raw UID is stored in the
						// object key kb/{uid}.md; the site prefixes it with 'u').
						write({ type: 'citation', uid, deepLink: '#/u' + uid });
					}
				}
			}
		}
		if (resp.sessionId) outSessionId = resp.sessionId;
		write({ type: 'done', citations: Array.from(citedUids), conversationId: outSessionId });
	} catch (e) {
		write({ type: 'error', error: String((e && e.message) || e) });
	}
	responseStream.end();
});
