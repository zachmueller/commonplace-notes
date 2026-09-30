import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { readInlineLambda } from './inline-code';

/**
 * Built-in Cognito + Google identity sub-stack.
 *
 * Deployed FIRST (like the certificate sub-stack), pinned to us-east-1. It owns
 * the user pool, Google IdP, Hosted UI domain, app client, the OAuth callback
 * API, and (when the plugin supplies the bootstrap bucket + artifact) the
 * pre-token-generation trigger that carries per-note access groups into tokens.
 *
 * The viewer-request Lambda@Edge read gate is NOT in this stack any more. It is
 * deployed separately (cognito-edge-stack.ts) as an S3 asset, after this stack,
 * because its baked config needs this stack's outputs.
 *
 * Two-phase deploy: the `UserPoolClient` callback URL is a stack PARAMETER
 * (`CallbackURL`) so a default-CloudFront-domain site can deploy this stack with
 * a placeholder, deploy the site stack to learn its domain, then `update-stack`
 * here with the real callback URL — a pure parameter update, no resource
 * replacement.
 *
 * All resources are L1 (`Cfn*`) constructs so `bin/synth.ts` can serialize the
 * stack to a self-contained JSON TemplateBody with no asset staging. The OAuth
 * callback Lambda is still inlined (`ZipFile`, 4096-byte cap enforced by
 * readInlineLambda); the trigger is an S3 asset.
 */
export class CognitoAuthStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		// ---- Parameters -------------------------------------------------------
		const variantName = new cdk.CfnParameter(this, 'VariantName', {
			type: 'String',
			default: '',
			description: 'Optional variant name for multi-instance deployments',
		});

		const googleClientId = new cdk.CfnParameter(this, 'GoogleClientId', {
			type: 'String',
			description: 'Google OAuth client ID (from Google Cloud Console)',
		});

		const googleClientSecret = new cdk.CfnParameter(this, 'GoogleClientSecret', {
			type: 'String',
			noEcho: true,
			description: 'Google OAuth client secret (from Google Cloud Console)',
		});

		const callbackUrl = new cdk.CfnParameter(this, 'CallbackURL', {
			type: 'String',
			default: 'https://placeholder.invalid/auth/callback',
			description:
				'OAuth redirect_uri allowed on the app client. Set to the real site ' +
				'domain + /auth/callback in phase 2 (placeholder is fine for phase 1).',
		});

		const domainPrefix = new cdk.CfnParameter(this, 'AuthDomainPrefix', {
			type: 'String',
			description:
				'Hosted UI domain prefix; yields <prefix>.auth.<region>.amazoncognito.com',
		});

		const assetsBucket = new cdk.CfnParameter(this, 'AssetsBucket', {
			type: 'String',
			default: '',
			description:
				'Per-account bootstrap bucket (us-east-1). Holds the pre-token trigger code ' +
				'and the access-group membership file. Empty disables access groups.',
		});

		const triggerAssetsKey = new cdk.CfnParameter(this, 'TriggerAssetsKey', {
			type: 'String',
			default: '',
			description: 'S3 key of the pre-token-generation trigger code zip in AssetsBucket',
		});

		// ---- User pool + Google IdP ------------------------------------------
		const userPool = new cdk.aws_cognito.CfnUserPool(this, 'UserPool', {
			userPoolName: cdk.Fn.join('', ['cpn-', cdk.Aws.STACK_NAME]),
			usernameAttributes: ['email'],
			autoVerifiedAttributes: ['email'],
			adminCreateUserConfig: { allowAdminCreateUserOnly: false },
		});

		const googleIdp = new cdk.aws_cognito.CfnUserPoolIdentityProvider(this, 'GoogleIdp', {
			userPoolId: userPool.ref,
			providerName: 'Google',
			providerType: 'Google',
			providerDetails: {
				client_id: googleClientId.valueAsString,
				client_secret: googleClientSecret.valueAsString,
				authorize_scopes: 'openid email profile',
			},
			attributeMapping: {
				email: 'email',
				email_verified: 'email_verified',
				name: 'name',
			},
		});

		const userPoolDomain = new cdk.aws_cognito.CfnUserPoolDomain(this, 'UserPoolDomain', {
			userPoolId: userPool.ref,
			domain: domainPrefix.valueAsString,
		});

		const userPoolClient = new cdk.aws_cognito.CfnUserPoolClient(this, 'UserPoolClient', {
			userPoolId: userPool.ref,
			generateSecret: true,
			supportedIdentityProviders: ['Google'],
			allowedOAuthFlows: ['code'],
			allowedOAuthScopes: ['openid', 'email', 'profile'],
			allowedOAuthFlowsUserPoolClient: true,
			callbackUrLs: [callbackUrl.valueAsString],
			logoutUrLs: [callbackUrl.valueAsString],
		});
		// The client must exist after the Google IdP it references.
		userPoolClient.addDependency(googleIdp);

		const hostedUiDomain = cdk.Fn.join('', [
			'https://',
			domainPrefix.valueAsString,
			'.auth.',
			cdk.Aws.REGION,
			'.amazoncognito.com',
		]);

		// ---- Pre-token-generation trigger (per-note access groups) ----------
		// Regional Lambda (same region as the pool) packaged as an S3 asset in the
		// per-account bootstrap bucket, like the edge functions. It reads the
		// plugin-managed membership file from the same bucket and injects
		// `cognito:groups` into issued id tokens. Omitted entirely when the plugin
		// hasn't supplied the bucket + artifact (older deploy paths), so the pool
		// still works; it just carries no groups.
		const hasAccessGroups = new cdk.CfnCondition(this, 'HasAccessGroups', {
			expression: cdk.Fn.conditionAnd(
				cdk.Fn.conditionNot(cdk.Fn.conditionEquals(assetsBucket.valueAsString, '')),
				cdk.Fn.conditionNot(cdk.Fn.conditionEquals(triggerAssetsKey.valueAsString, '')),
			),
		});
		const groupsKey = cdk.Fn.join('', ['access/', cdk.Aws.STACK_NAME, '/groups.json']);

		const triggerRole = new cdk.aws_iam.CfnRole(this, 'PreTokenGroupsFnRole', {
			assumeRolePolicyDocument: {
				Version: '2012-10-17',
				Statement: [
					{
						Effect: 'Allow',
						Principal: { Service: 'lambda.amazonaws.com' },
						Action: 'sts:AssumeRole',
					},
				],
			},
			managedPolicyArns: [
				'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
			],
			policies: [
				{
					policyName: 'ReadAccessGroups',
					policyDocument: {
						Version: '2012-10-17',
						Statement: [
							{
								Effect: 'Allow',
								Action: 's3:GetObject',
								Resource: cdk.Fn.join('', [
									'arn:aws:s3:::', assetsBucket.valueAsString, '/', groupsKey,
								]),
							},
							{
								// Lets a missing file surface as NoSuchKey (not AccessDenied).
								Effect: 'Allow',
								Action: 's3:ListBucket',
								Resource: cdk.Fn.join('', ['arn:aws:s3:::', assetsBucket.valueAsString]),
								Condition: { StringLike: { 's3:prefix': [groupsKey] } },
							},
						],
					},
				},
			],
		});
		triggerRole.cfnOptions.condition = hasAccessGroups;

		const triggerFn = new cdk.aws_lambda.CfnFunction(this, 'PreTokenGroupsFn', {
			runtime: 'nodejs20.x',
			handler: 'index.handler',
			role: triggerRole.attrArn,
			timeout: 5,
			code: {
				s3Bucket: assetsBucket.valueAsString,
				s3Key: triggerAssetsKey.valueAsString,
			},
			environment: {
				variables: {
					GROUPS_BUCKET: assetsBucket.valueAsString,
					GROUPS_KEY: groupsKey,
				},
			},
		});
		triggerFn.cfnOptions.condition = hasAccessGroups;

		const triggerPermission = new cdk.aws_lambda.CfnPermission(this, 'PreTokenGroupsInvokePermission', {
			action: 'lambda:InvokeFunction',
			functionName: triggerFn.ref,
			principal: 'cognito-idp.amazonaws.com',
			sourceArn: userPool.attrArn,
		});
		triggerPermission.cfnOptions.condition = hasAccessGroups;

		// Pool -> trigger (lambdaConfig). The trigger itself never references the
		// pool, so there is no cycle; the permission references both.
		userPool.lambdaConfig = cdk.Fn.conditionIf(
			hasAccessGroups.logicalId,
			{ PreTokenGeneration: triggerFn.attrArn },
			cdk.Aws.NO_VALUE,
		) as unknown as cdk.aws_cognito.CfnUserPool.LambdaConfigProperty;

		// ---- Callback API (regional API Gateway v2 HTTP API + Lambda) --------
		const callbackRole = new cdk.aws_iam.CfnRole(this, 'CallbackFnRole', {
			assumeRolePolicyDocument: {
				Version: '2012-10-17',
				Statement: [
					{
						Effect: 'Allow',
						Principal: { Service: 'lambda.amazonaws.com' },
						Action: 'sts:AssumeRole',
					},
				],
			},
			managedPolicyArns: [
				'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
			],
		});

		const callbackFn = new cdk.aws_lambda.CfnFunction(this, 'AuthCallbackFn', {
			runtime: 'nodejs20.x',
			handler: 'index.handler',
			role: callbackRole.attrArn,
			timeout: 10,
			code: { zipFile: readInlineLambda('auth-callback.js') },
			environment: {
				variables: {
					COGNITO_DOMAIN: hostedUiDomain,
					CLIENT_ID: userPoolClient.ref,
					CLIENT_SECRET: userPoolClient.attrClientSecret,
					// Exact redirect_uri registered on the app client; kept correct by
					// the two-phase CallbackURL param (no Host-header dependency).
					REDIRECT_URI: callbackUrl.valueAsString,
				},
			},
		});

		const httpApi = new cdk.aws_apigatewayv2.CfnApi(this, 'CallbackApi', {
			name: cdk.Fn.join('', ['cpn-auth-callback-', cdk.Aws.STACK_NAME]),
			protocolType: 'HTTP',
		});

		const integration = new cdk.aws_apigatewayv2.CfnIntegration(this, 'CallbackIntegration', {
			apiId: httpApi.ref,
			integrationType: 'AWS_PROXY',
			integrationUri: callbackFn.attrArn,
			integrationMethod: 'POST',
			payloadFormatVersion: '2.0',
		});

		new cdk.aws_apigatewayv2.CfnRoute(this, 'CallbackRoute', {
			apiId: httpApi.ref,
			routeKey: 'GET /auth/callback',
			target: cdk.Fn.join('', ['integrations/', integration.ref]),
		});

		new cdk.aws_apigatewayv2.CfnStage(this, 'CallbackStage', {
			apiId: httpApi.ref,
			stageName: '$default',
			autoDeploy: true,
		});

		// Allow API Gateway to invoke the callback Lambda.
		new cdk.aws_lambda.CfnPermission(this, 'CallbackInvokePermission', {
			action: 'lambda:InvokeFunction',
			functionName: callbackFn.ref,
			principal: 'apigateway.amazonaws.com',
			sourceArn: cdk.Fn.sub(
				'arn:aws:execute-api:${AWS::Region}:${AWS::AccountId}:${ApiId}/*/*/auth/callback',
				{ ApiId: httpApi.ref },
			),
		});

		// The API Gateway endpoint is https://<apiId>.execute-api.<region>.amazonaws.com;
		// the full-site stack uses just the host as a custom origin for /auth/*.
		const callbackApiDomain = cdk.Fn.join('', [
			httpApi.ref,
			'.execute-api.',
			cdk.Aws.REGION,
			'.amazonaws.com',
		]);

		// ---- Outputs ----------------------------------------------------------
		// The viewer-request edge fn now lives in its own stack (cognito-edge-stack.ts),
		// so this pool stack no longer emits EdgeFunctionVersionArn.
		const accessGroupsBucketOut = new cdk.CfnOutput(this, 'AccessGroupsBucket', {
			value: assetsBucket.valueAsString,
			description: 'Bucket holding the access-group membership file',
		});
		accessGroupsBucketOut.condition = hasAccessGroups;
		const accessGroupsKeyOut = new cdk.CfnOutput(this, 'AccessGroupsKey', {
			value: groupsKey,
			description: 'Object key of the access-group membership file (read by the pre-token trigger)',
		});
		accessGroupsKeyOut.condition = hasAccessGroups;
		new cdk.CfnOutput(this, 'UserPoolId', {
			value: userPool.ref,
			description: 'Cognito user pool ID',
		});
		new cdk.CfnOutput(this, 'UserPoolClientId', {
			value: userPoolClient.ref,
			description: 'Cognito app client ID',
		});
		new cdk.CfnOutput(this, 'HostedUiDomain', {
			value: hostedUiDomain,
			description: 'Cognito Hosted UI origin (https://<prefix>.auth.<region>.amazoncognito.com)',
		});
		new cdk.CfnOutput(this, 'JwksUri', {
			value: cdk.Fn.join('', [
				'https://cognito-idp.',
				cdk.Aws.REGION,
				'.amazonaws.com/',
				userPool.ref,
				'/.well-known/jwks.json',
			]),
			description: 'JWKS URI for validating pool-issued JWTs',
		});
		new cdk.CfnOutput(this, 'Issuer', {
			value: cdk.Fn.join('', [
				'https://cognito-idp.',
				cdk.Aws.REGION,
				'.amazonaws.com/',
				userPool.ref,
			]),
			description: 'Token issuer (iss) for pool-issued JWTs',
		});
		new cdk.CfnOutput(this, 'CallbackApiDomain', {
			value: callbackApiDomain,
			description: 'API Gateway host for the /auth/* CloudFront origin',
		});
		// Reference the domain resource so it is not pruned and deploys with the pool.
		new cdk.CfnOutput(this, 'UserPoolDomainName', {
			value: userPoolDomain.ref,
			description: 'Cognito user pool domain resource name',
		});
	}
}
