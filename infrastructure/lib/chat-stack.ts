import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * LLM-chat-over-published-notes backend (see the "LLM chat over published notes
 * behind CloudFront" idea note). A separate opt-in stack, deployed AFTER the
 * full-site stack (it needs the site bucket + distribution id):
 *
 *   S3 `kb/{uid}.md` corpus  --data source-->  Bedrock Knowledge Base
 *       (embeddings: Titan v2)  -->  S3 Vectors index (near-zero idle cost)
 *   Chat Lambda (RetrieveAndGenerateStream)  -->  Lambda Function URL (SSE)
 *
 * The only seam back into the site stack is a CloudFront origin/behavior for
 * /api/chat, added in auth-comment-wiring.ts. That behavior carries the same
 * viewer-request auth Lambda@Edge association as /comments/*, so chat inherits
 * whatever read-gate the site configured (Cognito / password / BYO).
 *
 * Bypass protection (Phase 0 finding): CloudFront OAC cannot sign a forwarded
 * POST body for a Function URL, so the Function URL is AuthType: NONE and the
 * handler validates a CloudFront-injected shared-secret custom origin header
 * FAIL-CLOSED. The endpoint is therefore only reachable through the auth-gated
 * CloudFront path.
 *
 * Packaging: the streaming handler exceeds the 4096-byte inline ZipFile cap, so
 * its code is an **S3 asset** (Code: { S3Bucket, S3Key }), uploaded to the
 * per-account bootstrap bucket at a content-addressed key with the config baked
 * in — the same pattern as password-edge.js.
 *
 * Newer resource types (S3 Vectors, Bedrock KB) are declared as raw CfnResource
 * since their typed L1 constructs may lag the service.
 */
export class ChatStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		// ---- Parameters -------------------------------------------------------
		const variantName = new cdk.CfnParameter(this, 'VariantName', {
			type: 'String',
			default: '',
			description: 'Optional variant name for multi-instance deployments',
		});

		const siteBucketName = new cdk.CfnParameter(this, 'SiteBucketName', {
			type: 'String',
			description: 'Name of the site S3 bucket holding the kb/ corpus',
		});

		const s3Prefix = new cdk.CfnParameter(this, 'S3Prefix', {
			type: 'String',
			default: '',
			description: 'Optional key prefix within the site bucket (matches the site s3Prefix)',
		});

		const assetsBucket = new cdk.CfnParameter(this, 'AssetsBucket', {
			type: 'String',
			description: 'Name of the bootstrap bucket holding the chat-handler code zip',
		});

		const assetsKey = new cdk.CfnParameter(this, 'AssetsKey', {
			type: 'String',
			description: 'S3 key of the content-addressed chat-handler zip (config baked in)',
		});

		const embeddingModelArn = new cdk.CfnParameter(this, 'EmbeddingModelArn', {
			type: 'String',
			default: 'arn:aws:bedrock:us-east-1::foundation-model/amazon.titan-embed-text-v2:0',
			description: 'Bedrock embedding model ARN used by the Knowledge Base (1024-dim)',
		});

		const bucketArn = cdk.Fn.join('', ['arn:aws:s3:::', siteBucketName.valueAsString]);
		// The kb/ prefix within the (optionally prefixed) site bucket.
		const inclusionPrefix = cdk.Fn.join('', [s3Prefix.valueAsString, 'kb/']);

		// ---- S3 Vectors store -------------------------------------------------
		const vectorBucketName = cdk.Fn.conditionIf(
			'HasVariantName',
			cdk.Fn.join('', ['cpn-chat-vec-', cdk.Aws.ACCOUNT_ID, '-', variantName.valueAsString]),
			cdk.Fn.join('', ['cpn-chat-vec-', cdk.Aws.ACCOUNT_ID]),
		).toString();
		new cdk.CfnCondition(this, 'HasVariantName', {
			expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(variantName.valueAsString, '')),
		});

		const vectorBucket = new cdk.CfnResource(this, 'VectorBucket', {
			type: 'AWS::S3Vectors::VectorBucket',
			properties: {
				VectorBucketName: vectorBucketName,
			},
		});
		vectorBucket.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;
		vectorBucket.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;

		const vectorIndex = new cdk.CfnResource(this, 'VectorIndex', {
			type: 'AWS::S3Vectors::Index',
			properties: {
				VectorBucketName: vectorBucketName,
				IndexName: 'cpn-chat-index',
				DataType: 'float32',
				Dimension: 1024,
				DistanceMetric: 'cosine',
			},
		});
		vectorIndex.addDependency(vectorBucket);
		vectorIndex.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;
		vectorIndex.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;

		const vectorBucketArn = cdk.Fn.join(
			'',
			['arn:aws:s3vectors:', cdk.Aws.REGION, ':', cdk.Aws.ACCOUNT_ID, ':bucket/', vectorBucketName],
		);
		const vectorIndexArn = cdk.Fn.join('', [vectorBucketArn, '/index/cpn-chat-index']);

		// ---- Knowledge Base service role -------------------------------------
		const kbRole = new cdk.aws_iam.CfnRole(this, 'KbServiceRole', {
			assumeRolePolicyDocument: {
				Version: '2012-10-17',
				Statement: [{
					Effect: 'Allow',
					Principal: { Service: 'bedrock.amazonaws.com' },
					Action: 'sts:AssumeRole',
					Condition: { StringEquals: { 'aws:SourceAccount': cdk.Aws.ACCOUNT_ID } },
				}],
			},
			policies: [{
				policyName: 'kb-inline',
				policyDocument: {
					Version: '2012-10-17',
					Statement: [
						{ Effect: 'Allow', Action: ['bedrock:InvokeModel'], Resource: [embeddingModelArn.valueAsString] },
						{
							Effect: 'Allow',
							Action: ['s3:GetObject', 's3:ListBucket'],
							Resource: [bucketArn, cdk.Fn.join('', [bucketArn, '/*'])],
							Condition: { StringEquals: { 'aws:ResourceAccount': cdk.Aws.ACCOUNT_ID } },
						},
						{ Effect: 'Allow', Action: ['s3vectors:*'], Resource: [vectorBucketArn, cdk.Fn.join('', [vectorBucketArn, '/*'])] },
					],
				},
			}],
		});

		// ---- Knowledge Base + data source ------------------------------------
		const kb = new cdk.CfnResource(this, 'KnowledgeBase', {
			type: 'AWS::Bedrock::KnowledgeBase',
			properties: {
				Name: cdk.Fn.join('', ['cpn-chat-', cdk.Aws.STACK_NAME]),
				RoleArn: kbRole.attrArn,
				KnowledgeBaseConfiguration: {
					Type: 'VECTOR',
					VectorKnowledgeBaseConfiguration: {
						EmbeddingModelArn: embeddingModelArn.valueAsString,
						EmbeddingModelConfiguration: {
							BedrockEmbeddingModelConfiguration: { Dimensions: 1024, EmbeddingDataType: 'FLOAT32' },
						},
					},
				},
				StorageConfiguration: {
					Type: 'S3_VECTORS',
					S3VectorsConfiguration: { IndexArn: vectorIndexArn },
				},
			},
		});
		kb.addDependency(vectorIndex);

		const dataSource = new cdk.CfnResource(this, 'ChatDataSource', {
			type: 'AWS::Bedrock::DataSource',
			properties: {
				Name: 'cpn-chat-corpus',
				KnowledgeBaseId: kb.ref,
				// RETAIN so KB/data-source teardown never blocks on purging vectors from
				// an already-removed store (Phase 0 teardown finding).
				DataDeletionPolicy: 'RETAIN',
				DataSourceConfiguration: {
					Type: 'S3',
					S3Configuration: {
						BucketArn: bucketArn,
						InclusionPrefixes: [inclusionPrefix],
					},
				},
			},
		});

		// ---- Chat Lambda (streaming) + Function URL --------------------------
		const chatRole = new cdk.aws_iam.CfnRole(this, 'ChatFnRole', {
			assumeRolePolicyDocument: {
				Version: '2012-10-17',
				Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
			},
			managedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
			policies: [{
				policyName: 'chat-inline',
				policyDocument: {
					Version: '2012-10-17',
					Statement: [{
						Effect: 'Allow',
						Action: [
							'bedrock:RetrieveAndGenerate',
							'bedrock:Retrieve',
							'bedrock:InvokeModel',
							'bedrock:InvokeModelWithResponseStream',
							// Required: the streaming call resolves the inference profile
							// (Sonnet 5 is INFERENCE_PROFILE-only). Discovered in Phase 0.
							'bedrock:GetInferenceProfile',
						],
						Resource: '*',
					}],
				},
			}],
		});

		const chatFn = new cdk.aws_lambda.CfnFunction(this, 'ChatFn', {
			runtime: 'nodejs20.x',
			handler: 'index.handler',
			role: chatRole.attrArn,
			timeout: 120,
			memorySize: 512,
			code: { s3Bucket: assetsBucket.valueAsString, s3Key: assetsKey.valueAsString },
		});

		const chatUrl = new cdk.aws_lambda.CfnUrl(this, 'ChatFnUrl', {
			targetFunctionArn: chatFn.attrArn,
			// AuthType NONE: CloudFront OAC cannot sign a forwarded POST body for a
			// Function URL (Phase 0). Bypass protection is the shared-secret header
			// validated fail-closed in the handler.
			authType: 'NONE',
			invokeMode: 'RESPONSE_STREAM',
		});

		// FunctionURL invoke permission for anonymous callers (AuthType NONE). The
		// shared-secret header check in the handler is the actual gate.
		new cdk.aws_lambda.CfnPermission(this, 'ChatUrlInvokePermission', {
			action: 'lambda:InvokeFunctionUrl',
			functionName: chatFn.ref,
			principal: '*',
			functionUrlAuthType: 'NONE',
		});

		// ---- Outputs ----------------------------------------------------------
		// The Function URL is https://<domain>/ ; strip the scheme+trailing slash to
		// yield the bare host for the CloudFront custom origin DomainName.
		new cdk.CfnOutput(this, 'ChatFunctionUrlDomainName', {
			value: cdk.Fn.select(2, cdk.Fn.split('/', chatUrl.attrFunctionUrl)),
			description: 'Chat Function URL host (for the /api/chat CloudFront origin)',
		});
		new cdk.CfnOutput(this, 'KnowledgeBaseId', {
			value: kb.ref,
			description: 'Bedrock Knowledge Base id',
		});
		new cdk.CfnOutput(this, 'DataSourceId', {
			value: dataSource.getAtt('DataSourceId').toString(),
			description: 'Bedrock KB data source id (for StartIngestionJob)',
		});
	}
}
