import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { readInlineLambda, readInlineLambdaBundle } from './inline-code';

/**
 * Self-hosted commenting backend (see the "Add commenting on published notes"
 * idea note). A separate stack, deployed AFTER the Cognito auth stack and the
 * full-site stack:
 *
 *   DynamoDB (system of record) --Stream--> re-export Lambda --> comment S3 bucket
 *   write API (HTTP API) behind a cookie-based Lambda authorizer (validates the
 *   same HttpOnly cpn_id JWT cookie the auth stack sets)
 *
 * The only seams back into the site stack are CloudFront origins/behaviors,
 * added in PR-3: /comments/{uid}.json reads the bucket (open, CDN-cached);
 * /api/comments routes to this stack's write API.
 *
 * All L1 (Cfn*) constructs + inline Lambda code so synth produces a
 * self-contained JSON TemplateBody with no asset staging.
 */
export class CommentStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		// ---- Parameters -------------------------------------------------------
		const variantName = new cdk.CfnParameter(this, 'VariantName', {
			type: 'String',
			default: '',
			description: 'Optional variant name for multi-instance deployments',
		});

		const jwksUri = new cdk.CfnParameter(this, 'JwksUri', {
			type: 'String',
			description: 'JWKS URI of the Cognito user pool (from the auth stack)',
		});

		const tokenIssuer = new cdk.CfnParameter(this, 'TokenIssuer', {
			type: 'String',
			description: 'Token issuer (iss) of the Cognito user pool (from the auth stack)',
		});

		const userPoolClientId = new cdk.CfnParameter(this, 'UserPoolClientId', {
			type: 'String',
			description: 'Cognito app client id, used as the token audience (from the auth stack)',
		});

		// Cross-stack grant for the site distribution to read the comment bucket.
		const originAccessMethod = new cdk.CfnParameter(this, 'OriginAccessMethod', {
			type: 'String',
			default: 'oac',
			allowedValues: ['oac', 'oai'],
			description: 'Must match the site distribution access method',
		});

		const siteDistributionId = new cdk.CfnParameter(this, 'SiteDistributionId', {
			type: 'String',
			default: '',
			description: 'Site CloudFront distribution id (OAC grant via AWS:SourceArn)',
		});

		const siteOaiId = new cdk.CfnParameter(this, 'SiteOriginAccessIdentityId', {
			type: 'String',
			default: '',
			description: 'Site CloudFront OAI id (OAI grant principal)',
		});

		const isOac = new cdk.CfnCondition(this, 'IsOac', {
			expression: cdk.Fn.conditionEquals(originAccessMethod.valueAsString, 'oac'),
		});

		// ---- DynamoDB (system of record) -------------------------------------
		const table = new cdk.aws_dynamodb.CfnTable(this, 'CommentsTable', {
			billingMode: 'PAY_PER_REQUEST',
			attributeDefinitions: [
				{ attributeName: 'PK', attributeType: 'S' },
				{ attributeName: 'SK', attributeType: 'S' },
				// Recency-feed GSI keys (author-facing Phase 2). Only comment items
				// carry these; profile/username items omit them and are left out of
				// the index (DynamoDB sparse-index behavior).
				{ attributeName: 'GSI1PK', attributeType: 'S' },
				{ attributeName: 'GSI1SK', attributeType: 'S' },
			],
			keySchema: [
				{ attributeName: 'PK', keyType: 'HASH' },
				{ attributeName: 'SK', keyType: 'RANGE' },
			],
			// GSI1 gives newest-N comments site-wide in one Query: every comment
			// shares the constant GSI1PK='ACTIVITY' partition, sorted by a
			// time-leading GSI1SK ({createdAt}#{noteUid}#{commentUid}). Reads use
			// ScanIndexForward=false + Limit. Does not affect the base PK/SK path
			// (per-note loading, re-export) at all — purely additive.
			globalSecondaryIndexes: [
				{
					indexName: 'GSI1',
					keySchema: [
						{ attributeName: 'GSI1PK', keyType: 'HASH' },
						{ attributeName: 'GSI1SK', keyType: 'RANGE' },
					],
					// Project everything so the recency Query returns render-ready
					// comment fields without a base-table fetch.
					projection: { projectionType: 'ALL' },
				},
			],
			streamSpecification: { streamViewType: 'NEW_AND_OLD_IMAGES' },
		});
		table.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;
		table.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;

		// ---- Comment S3 bucket (CDN-cached read cache) -----------------------
		const bucketName = cdk.Fn.conditionIf(
			'HasVariantName',
			cdk.Fn.join('', ['cpn-comments-', cdk.Aws.ACCOUNT_ID, '-', variantName.valueAsString]),
			cdk.Fn.join('', ['cpn-comments-', cdk.Aws.ACCOUNT_ID]),
		).toString();
		new cdk.CfnCondition(this, 'HasVariantName', {
			expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(variantName.valueAsString, '')),
		});

		const bucket = new cdk.aws_s3.CfnBucket(this, 'CommentBucket', {
			bucketName,
			publicAccessBlockConfiguration: {
				blockPublicAcls: true,
				blockPublicPolicy: true,
				ignorePublicAcls: true,
				restrictPublicBuckets: true,
			},
		});
		bucket.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;
		bucket.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;

		// Grant the site distribution read access, mirroring its access method.
		new cdk.aws_s3.CfnBucketPolicy(this, 'CommentBucketPolicy', {
			bucket: bucket.ref,
			policyDocument: {
				Version: '2012-10-17',
				Statement: [
					cdk.Fn.conditionIf(
						'IsOac',
						{
							Effect: 'Allow',
							Principal: { Service: 'cloudfront.amazonaws.com' },
							Action: 's3:GetObject',
							Resource: cdk.Fn.join('', ['arn:aws:s3:::', bucket.ref, '/*']),
							Condition: {
								StringEquals: {
									'AWS:SourceArn': cdk.Fn.sub(
										'arn:aws:cloudfront::${AWS::AccountId}:distribution/${DistId}',
										{ DistId: siteDistributionId.valueAsString },
									),
								},
							},
						},
						{
							Effect: 'Allow',
							Principal: {
								AWS: cdk.Fn.sub(
									'arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity ${OaiId}',
									{ OaiId: siteOaiId.valueAsString },
								),
							},
							Action: 's3:GetObject',
							Resource: cdk.Fn.join('', ['arn:aws:s3:::', bucket.ref, '/*']),
						},
					),
				],
			},
		});

		// ---- Shared inline-Lambda roles --------------------------------------
		const basicRole = (logicalId: string, extraStatements: unknown[] = []) => {
			const policies = extraStatements.length
				? [{
					policyName: 'inline',
					policyDocument: { Version: '2012-10-17', Statement: extraStatements },
				}]
				: undefined;
			return new cdk.aws_iam.CfnRole(this, logicalId, {
				assumeRolePolicyDocument: {
					Version: '2012-10-17',
					Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
				},
				managedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
				policies,
			});
		};

		// ---- Cookie-based authorizer Lambda ----------------------------------
		const authorizerRole = basicRole('AuthorizerFnRole');
		const authorizerFn = new cdk.aws_lambda.CfnFunction(this, 'AuthorizerFn', {
			runtime: 'nodejs20.x',
			handler: 'index.handler',
			role: authorizerRole.attrArn,
			timeout: 10,
			code: { zipFile: readInlineLambdaBundle('lib-jwt-verify.js', 'comment-authorizer.js') },
			environment: {
				variables: {
					JWKS_URI: jwksUri.valueAsString,
					TOKEN_ISS: tokenIssuer.valueAsString,
					TOKEN_AUD: userPoolClientId.valueAsString,
				},
			},
		});

		// ---- Write Lambda -----------------------------------------------------
		const writeRole = basicRole('WriteFnRole', [
			{
				Effect: 'Allow',
				Action: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem'],
				Resource: table.attrArn,
			},
		]);
		const writeFn = new cdk.aws_lambda.CfnFunction(this, 'WriteFn', {
			runtime: 'nodejs20.x',
			handler: 'index.handler',
			role: writeRole.attrArn,
			timeout: 10,
			code: { zipFile: readInlineLambda('comment-write.js') },
			environment: { variables: { TABLE_NAME: table.ref } },
		});

		// ---- Profile / identity Lambda (/api/me) -----------------------------
		// Whoami + one-time username claim. Uses TransactWriteItems for atomic
		// per-user immutability + site-wide uniqueness (see comment-me.js).
		const meRole = basicRole('MeFnRole', [
			{
				Effect: 'Allow',
				Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:TransactWriteItems'],
				Resource: table.attrArn,
			},
		]);
		const meFn = new cdk.aws_lambda.CfnFunction(this, 'MeFn', {
			runtime: 'nodejs20.x',
			handler: 'index.handler',
			role: meRole.attrArn,
			timeout: 10,
			code: { zipFile: readInlineLambda('comment-me.js') },
			environment: { variables: { TABLE_NAME: table.ref } },
		});

		// ---- Re-export Lambda + DLQ ------------------------------------------
		const dlq = new cdk.aws_sqs.CfnQueue(this, 'ReexportDlq', {
			messageRetentionPeriod: 1209600, // 14 days
		});
		const reexportRole = basicRole('ReexportFnRole', [
			{ Effect: 'Allow', Action: ['dynamodb:Query'], Resource: table.attrArn },
			{
				Effect: 'Allow',
				Action: ['dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:DescribeStream', 'dynamodb:ListStreams'],
				Resource: table.attrStreamArn,
			},
			{ Effect: 'Allow', Action: ['s3:PutObject'], Resource: cdk.Fn.join('', [bucket.attrArn, '/*']) },
			{ Effect: 'Allow', Action: ['sqs:SendMessage'], Resource: dlq.attrArn },
		]);
		const reexportFn = new cdk.aws_lambda.CfnFunction(this, 'ReexportFn', {
			runtime: 'nodejs20.x',
			handler: 'index.handler',
			role: reexportRole.attrArn,
			timeout: 30,
			code: { zipFile: readInlineLambda('comment-reexport.js') },
			environment: { variables: { TABLE_NAME: table.ref, COMMENT_BUCKET: bucket.ref } },
		});

		new cdk.aws_lambda.CfnEventSourceMapping(this, 'ReexportStreamMapping', {
			functionName: reexportFn.ref,
			eventSourceArn: table.attrStreamArn,
			startingPosition: 'LATEST',
			batchSize: 10,
			bisectBatchOnFunctionError: true,
			maximumRetryAttempts: 3,
			destinationConfig: { onFailure: { destination: dlq.attrArn } },
		});

		// ---- Write API (HTTP API + cookie authorizer) ------------------------
		const api = new cdk.aws_apigatewayv2.CfnApi(this, 'CommentApi', {
			name: cdk.Fn.join('', ['cpn-comments-', cdk.Aws.STACK_NAME]),
			protocolType: 'HTTP',
		});

		const authorizer = new cdk.aws_apigatewayv2.CfnAuthorizer(this, 'CookieAuthorizer', {
			apiId: api.ref,
			authorizerType: 'REQUEST',
			name: 'cpn-cookie-authorizer',
			authorizerPayloadFormatVersion: '2.0',
			enableSimpleResponses: false,
			// Re-run per request: the session cookie is the identity source.
			identitySource: ['$request.header.Cookie'],
			authorizerResultTtlInSeconds: 0,
			authorizerUri: cdk.Fn.sub(
				'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${FnArn}/invocations',
				{ FnArn: authorizerFn.attrArn },
			),
		});

		const integration = new cdk.aws_apigatewayv2.CfnIntegration(this, 'WriteIntegration', {
			apiId: api.ref,
			integrationType: 'AWS_PROXY',
			integrationUri: writeFn.attrArn,
			integrationMethod: 'POST',
			payloadFormatVersion: '2.0',
		});

		const meIntegration = new cdk.aws_apigatewayv2.CfnIntegration(this, 'MeIntegration', {
			apiId: api.ref,
			integrationType: 'AWS_PROXY',
			integrationUri: meFn.attrArn,
			integrationMethod: 'POST',
			payloadFormatVersion: '2.0',
		});

		for (const [method, logicalId] of [['POST', 'PostRoute'], ['PATCH', 'PatchRoute'], ['DELETE', 'DeleteRoute']] as const) {
			new cdk.aws_apigatewayv2.CfnRoute(this, logicalId, {
				apiId: api.ref,
				routeKey: `${method} /api/comments`,
				target: cdk.Fn.join('', ['integrations/', integration.ref]),
				authorizationType: 'CUSTOM',
				authorizerId: authorizer.ref,
			});
		}

		for (const [method, logicalId] of [['GET', 'MeGetRoute'], ['POST', 'MePostRoute']] as const) {
			new cdk.aws_apigatewayv2.CfnRoute(this, logicalId, {
				apiId: api.ref,
				routeKey: `${method} /api/me`,
				target: cdk.Fn.join('', ['integrations/', meIntegration.ref]),
				authorizationType: 'CUSTOM',
				authorizerId: authorizer.ref,
			});
		}

		new cdk.aws_apigatewayv2.CfnStage(this, 'CommentApiStage', {
			apiId: api.ref,
			stageName: '$default',
			autoDeploy: true,
		});

		new cdk.aws_lambda.CfnPermission(this, 'WriteInvokePermission', {
			action: 'lambda:InvokeFunction',
			functionName: writeFn.ref,
			principal: 'apigateway.amazonaws.com',
			sourceArn: cdk.Fn.sub(
				'arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/*/api/comments',
				{ ApiId: api.ref },
			),
		});

		new cdk.aws_lambda.CfnPermission(this, 'MeInvokePermission', {
			action: 'lambda:InvokeFunction',
			functionName: meFn.ref,
			principal: 'apigateway.amazonaws.com',
			sourceArn: cdk.Fn.sub(
				'arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/*/api/me',
				{ ApiId: api.ref },
			),
		});

		new cdk.aws_lambda.CfnPermission(this, 'AuthorizerInvokePermission', {
			action: 'lambda:InvokeFunction',
			functionName: authorizerFn.ref,
			principal: 'apigateway.amazonaws.com',
			sourceArn: cdk.Fn.sub(
				'arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/authorizers/*',
				{ ApiId: api.ref },
			),
		});

		// ---- Outputs ----------------------------------------------------------
		new cdk.CfnOutput(this, 'CommentBucketName', {
			value: bucket.ref,
			description: 'Comment S3 bucket name',
		});
		new cdk.CfnOutput(this, 'CommentBucketDomainName', {
			value: cdk.Fn.getAtt('CommentBucket', 'RegionalDomainName').toString(),
			description: 'Comment bucket regional domain name (for the /comments/* origin)',
		});
		new cdk.CfnOutput(this, 'CommentApiDomain', {
			value: cdk.Fn.join('', [api.ref, '.execute-api.', cdk.Aws.REGION, '.amazonaws.com']),
			description: 'Comment write API host (for the /api/comments origin)',
		});
		new cdk.CfnOutput(this, 'CommentTableName', {
			value: table.ref,
			description: 'Comments DynamoDB table name',
		});
	}
}
