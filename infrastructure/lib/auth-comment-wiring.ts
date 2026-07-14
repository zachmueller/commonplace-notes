import * as cdk from 'aws-cdk-lib';

/**
 * Shared CloudFront wiring for the built-in auth callback and the comment
 * read/write paths, added to BOTH the OAC and OAI full-stack templates.
 *
 * Everything here is gated behind new `''`-default parameters so a site that
 * passes none of them deploys a distribution behaviourally identical to today:
 * the conditional origins resolve to `AWS::NoValue` (pruned from the array) and
 * the `CacheBehaviors` array collapses to empty (which CloudFront treats the
 * same as having no extra behaviors).
 *
 * Paths (deliberately distinct prefixes so each maps cleanly to one origin):
 *   /auth/*        -> callback API Gateway (sets the HttpOnly session cookie)
 *   /api/comments  -> comment write API Gateway (cookie-authorized writes)
 *   /comments/*    -> comment S3 bucket (open, CDN-cached comment JSON reads)
 *   /api/chat      -> chat Lambda Function URL (SSE streaming; auth-gated)
 *
 * The comment S3 origin's access config differs between OAC and OAI, so the
 * caller passes it in via `commentOriginAccess`.
 *
 * The chat origin is identical across OAC and OAI: a plain custom origin with a
 * CloudFront-injected shared-secret custom header the chat Lambda validates
 * fail-closed (CloudFront OAC cannot sign a forwarded POST body for a Function
 * URL — proven in the Phase 0 spike — so the secret header, not OAC, is the
 * bypass protection). Both the chat domain and the secret are '' by default, so
 * a site that passes neither is behaviourally unchanged.
 */

// AWS-managed policy IDs (global constants, same as the hardcoded CachingOptimized
// the default behavior already uses).
const CACHE_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6';
const CACHE_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';
// AllViewerExceptHostHeader: forwards all viewer headers (incl. Cookie) + query
// strings to the origin but NOT the Host header — required for API Gateway
// custom origins, which reject a forwarded CloudFront Host header.
const ORIGIN_REQ_ALL_VIEWER_EXCEPT_HOST = 'b689b0a8-53d0-40ab-baf2-68738e2966ac';

const ALL_METHODS = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE'];

export interface AuthCommentWiring {
	/** Conditional origin entries to append to distributionConfig.origins. */
	extraOrigins: any[];
	/** Conditional cache-behavior entries forming distributionConfig.cacheBehaviors. */
	extraCacheBehaviors: any[];
}

/**
 * Create the auth/comment parameters + conditions on `stack` and return the
 * conditional origins and cache behaviors to splice into the distribution.
 *
 * @param commentOriginAccess access-method-specific properties for the comment
 *   S3 origin (OAC: `{ originAccessControlId, s3OriginConfig:{originAccessIdentity:''} }`;
 *   OAI: `{ s3OriginConfig:{ originAccessIdentity: 'origin-access-identity/...' } }`).
 * @param chatOriginAccessControlId id of the lambda-type CloudFront OAC that
 *   SigV4-signs origin requests to the chat Function URL (created in each full
 *   stack). OAC is per-origin, so this is independent of the site's S3
 *   OAC/OAI choice — the chat origin uses it in both variants.
 */
export function addAuthCommentWiring(
	stack: cdk.Stack,
	commentOriginAccess: Record<string, unknown>,
	chatOriginAccessControlId: string,
): AuthCommentWiring {
	const callbackApiDomain = new cdk.CfnParameter(stack, 'CallbackApiDomainName', {
		type: 'String',
		default: '',
		description: 'API Gateway host backing the /auth/* callback origin (from the Cognito auth stack)',
	});

	const commentBucketDomain = new cdk.CfnParameter(stack, 'CommentBucketDomainName', {
		type: 'String',
		default: '',
		description: 'Regional domain name of the comment S3 bucket (from the comment stack)',
	});

	const commentApiDomain = new cdk.CfnParameter(stack, 'CommentApiDomainName', {
		type: 'String',
		default: '',
		description: 'API Gateway host backing the /api/comments write origin (from the comment stack)',
	});

	const chatFunctionUrlDomain = new cdk.CfnParameter(stack, 'ChatFunctionUrlDomainName', {
		type: 'String',
		default: '',
		description: 'Chat Lambda Function URL host backing the /api/chat origin (from the chat stack)',
	});

	new cdk.CfnCondition(stack, 'HasAuthCallback', {
		expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(callbackApiDomain.valueAsString, '')),
	});

	new cdk.CfnCondition(stack, 'HasComments', {
		expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(commentBucketDomain.valueAsString, '')),
	});

	new cdk.CfnCondition(stack, 'HasCommentApi', {
		expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(commentApiDomain.valueAsString, '')),
	});

	new cdk.CfnCondition(stack, 'HasChat', {
		expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(chatFunctionUrlDomain.valueAsString, '')),
	});

	const apiCustomOriginConfig = {
		originProtocolPolicy: 'https-only',
		originSslProtocols: ['TLSv1.2'],
		httpPort: 80,
		httpsPort: 443,
	};

	const extraOrigins = [
		// /auth/* -> callback API Gateway
		cdk.Fn.conditionIf(
			'HasAuthCallback',
			{
				Id: 'AuthApiOrigin',
				DomainName: callbackApiDomain.valueAsString,
				CustomOriginConfig: {
					OriginProtocolPolicy: apiCustomOriginConfig.originProtocolPolicy,
					OriginSSLProtocols: apiCustomOriginConfig.originSslProtocols,
					HTTPPort: apiCustomOriginConfig.httpPort,
					HTTPSPort: apiCustomOriginConfig.httpsPort,
				},
			},
			cdk.Aws.NO_VALUE,
		),
		// /comments/* -> comment S3 bucket (access config supplied by caller)
		cdk.Fn.conditionIf(
			'HasComments',
			{
				Id: 'CommentBucketOrigin',
				DomainName: commentBucketDomain.valueAsString,
				...mapCommentOriginAccessKeys(commentOriginAccess),
			},
			cdk.Aws.NO_VALUE,
		),
		// /api/comments -> comment write API Gateway
		cdk.Fn.conditionIf(
			'HasCommentApi',
			{
				Id: 'CommentApiOrigin',
				DomainName: commentApiDomain.valueAsString,
				CustomOriginConfig: {
					OriginProtocolPolicy: apiCustomOriginConfig.originProtocolPolicy,
					OriginSSLProtocols: apiCustomOriginConfig.originSslProtocols,
					HTTPPort: apiCustomOriginConfig.httpPort,
					HTTPSPort: apiCustomOriginConfig.httpsPort,
				},
			},
			cdk.Aws.NO_VALUE,
		),
		// /api/chat -> chat Lambda Function URL, locked to CloudFront via a lambda-type
		// OAC that SigV4-signs each origin request (the Function URL is AuthType:
		// AWS_IAM). No public URL, no shared secret — the endpoint is reachable only
		// through this auth-gated CloudFront path.
		cdk.Fn.conditionIf(
			'HasChat',
			{
				Id: 'ChatApiOrigin',
				DomainName: chatFunctionUrlDomain.valueAsString,
				OriginAccessControlId: chatOriginAccessControlId,
				CustomOriginConfig: {
					OriginProtocolPolicy: apiCustomOriginConfig.originProtocolPolicy,
					OriginSSLProtocols: apiCustomOriginConfig.originSslProtocols,
					HTTPPort: apiCustomOriginConfig.httpPort,
					HTTPSPort: apiCustomOriginConfig.httpsPort,
				},
			},
			cdk.Aws.NO_VALUE,
		),
	];

	const extraCacheBehaviors = [
		// /auth/* — never cache; forward cookies/query (sets the session cookie).
		cdk.Fn.conditionIf(
			'HasAuthCallback',
			{
				PathPattern: '/auth/*',
				TargetOriginId: 'AuthApiOrigin',
				ViewerProtocolPolicy: 'redirect-to-https',
				AllowedMethods: ALL_METHODS,
				CachedMethods: ['GET', 'HEAD'],
				Compress: true,
				CachePolicyId: CACHE_DISABLED,
				OriginRequestPolicyId: ORIGIN_REQ_ALL_VIEWER_EXCEPT_HOST,
			},
			cdk.Aws.NO_VALUE,
		),
		// /api/comments — never cache; forward the HttpOnly cookie to the authorizer.
		cdk.Fn.conditionIf(
			'HasCommentApi',
			{
				PathPattern: '/api/comments',
				TargetOriginId: 'CommentApiOrigin',
				ViewerProtocolPolicy: 'redirect-to-https',
				AllowedMethods: ALL_METHODS,
				CachedMethods: ['GET', 'HEAD'],
				Compress: true,
				CachePolicyId: CACHE_DISABLED,
				OriginRequestPolicyId: ORIGIN_REQ_ALL_VIEWER_EXCEPT_HOST,
			},
			cdk.Aws.NO_VALUE,
		),
		// /api/me — profile/whoami + username claim; same origin, same no-cache +
		// cookie-forwarding as /api/comments.
		cdk.Fn.conditionIf(
			'HasCommentApi',
			{
				PathPattern: '/api/me',
				TargetOriginId: 'CommentApiOrigin',
				ViewerProtocolPolicy: 'redirect-to-https',
				AllowedMethods: ALL_METHODS,
				CachedMethods: ['GET', 'HEAD'],
				Compress: true,
				CachePolicyId: CACHE_DISABLED,
				OriginRequestPolicyId: ORIGIN_REQ_ALL_VIEWER_EXCEPT_HOST,
			},
			cdk.Aws.NO_VALUE,
		),
		// /comments/* — open, CDN-cached reads. Inherit the site's gating: when an
		// edge fn is attached (HasAuthLambda), gate comment reads too; otherwise
		// they stay world-readable (open-blog model).
		cdk.Fn.conditionIf(
			'HasComments',
			{
				PathPattern: '/comments/*',
				TargetOriginId: 'CommentBucketOrigin',
				ViewerProtocolPolicy: 'redirect-to-https',
				AllowedMethods: ['GET', 'HEAD'],
				CachedMethods: ['GET', 'HEAD'],
				Compress: true,
				CachePolicyId: CACHE_OPTIMIZED,
				LambdaFunctionAssociations: cdk.Fn.conditionIf(
					'HasAuthLambda',
					[{ EventType: 'viewer-request', LambdaFunctionARN: cdk.Fn.ref('AuthLambdaEdgeArn') }],
					cdk.Aws.NO_VALUE,
				),
			},
			cdk.Aws.NO_VALUE,
		),
		// /api/chat — never cache; forward the viewer cookie to the origin. CRUCIALLY,
		// attach the SAME viewer-request auth edge fn as /comments/* when one is
		// configured (HasAuthLambda), so chat inherits the site's read-gate (Cognito
		// / password / BYO). Do NOT compress (breaks SSE streaming). The
		// shared-secret custom origin header is on the origin (above), not here.
		cdk.Fn.conditionIf(
			'HasChat',
			{
				PathPattern: '/api/chat',
				TargetOriginId: 'ChatApiOrigin',
				ViewerProtocolPolicy: 'redirect-to-https',
				AllowedMethods: ALL_METHODS,
				CachedMethods: ['GET', 'HEAD'],
				Compress: false,
				CachePolicyId: CACHE_DISABLED,
				OriginRequestPolicyId: ORIGIN_REQ_ALL_VIEWER_EXCEPT_HOST,
				LambdaFunctionAssociations: cdk.Fn.conditionIf(
					'HasAuthLambda',
					[{ EventType: 'viewer-request', LambdaFunctionARN: cdk.Fn.ref('AuthLambdaEdgeArn') }],
					cdk.Aws.NO_VALUE,
				),
			},
			cdk.Aws.NO_VALUE,
		),
	];

	return { extraOrigins, extraCacheBehaviors };
}

/**
 * The caller passes the comment-origin access props in camelCase (as the L2-ish
 * objects elsewhere in these stacks use). The conditional origin entry is a raw
 * CloudFormation fragment, so map the few keys we accept to their CFN casing.
 */
function mapCommentOriginAccessKeys(access: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if ('originAccessControlId' in access) out.OriginAccessControlId = access.originAccessControlId;
	if ('s3OriginConfig' in access) {
		const s3 = access.s3OriginConfig as Record<string, unknown>;
		out.S3OriginConfig = { OriginAccessIdentity: s3.originAccessIdentity };
	}
	return out;
}
