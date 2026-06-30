import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { readInlineLambda } from './inline-code';

/**
 * Built-in Cognito + Google identity sub-stack.
 *
 * Deployed FIRST (like the certificate sub-stack), pinned to us-east-1 because
 * it owns a viewer-request Lambda@Edge function whose *versioned* ARN is fed
 * into the existing `AuthLambdaEdgeArn` parameter of the full-site stack. The
 * full-site stack's gating mechanism is untouched — this stack just produces
 * the ARN an author would otherwise have to bring themselves.
 *
 * Two-phase deploy (see the idea note's Q8): the `UserPoolClient` callback URL
 * is a stack PARAMETER (`CallbackURL`) so a default-CloudFront-domain site can
 * deploy this stack with a placeholder, deploy the site stack to learn its
 * domain, then `update-stack` here with the real callback URL — a pure
 * parameter update, no resource replacement. The edge function itself derives
 * its redirect_uri host-relative, so it never needs phase-2 rewriting.
 *
 * All resources are L1 (`Cfn*`) constructs so `bin/synth.ts` can serialize the
 * stack to a self-contained JSON TemplateBody with no asset staging. Lambda
 * code is inlined (`ZipFile`) and therefore must stay under 4096 bytes after
 * compaction (enforced by readInlineLambda).
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

		// ---- Viewer-request Lambda@Edge --------------------------------------
		// Config is injected as a leading `const CFG = {...};` line via Fn::Sub,
		// then concatenated with the verbatim (comment-stripped) function body.
		// The body contains no `${...}` or backticks after stripping, so it is
		// safe to carry through Fn::Join without Sub-token collisions.
		const edgeBody = readInlineLambda('auth-edge.js');
		const cfgLine = cdk.Fn.sub(
			'const CFG = { domain: "${Domain}", clientId: "${ClientId}", region: "${Region}", userPoolId: "${PoolId}" };\n',
			{
				Domain: hostedUiDomain,
				ClientId: userPoolClient.ref,
				Region: cdk.Aws.REGION,
				PoolId: userPool.ref,
			},
		);
		const edgeZipFile = cdk.Fn.join('', [cfgLine, edgeBody]);

		const edgeRole = new cdk.aws_iam.CfnRole(this, 'EdgeFnRole', {
			assumeRolePolicyDocument: {
				Version: '2012-10-17',
				Statement: [
					{
						Effect: 'Allow',
						Principal: {
							Service: ['lambda.amazonaws.com', 'edgelambda.amazonaws.com'],
						},
						Action: 'sts:AssumeRole',
					},
				],
			},
			managedPolicyArns: [
				'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
			],
		});

		const edgeFn = new cdk.aws_lambda.CfnFunction(this, 'AuthEdgeFn', {
			runtime: 'nodejs20.x',
			handler: 'index.handler',
			role: edgeRole.attrArn,
			// Lambda@Edge forbids env vars — config is baked into the code above.
			code: { zipFile: edgeZipFile },
		});

		// Lambda@Edge requires a *versioned* ARN; CloudFront rejects $LATEST.
		const edgeVersion = new cdk.aws_lambda.CfnVersion(this, 'AuthEdgeFnVersion', {
			functionName: edgeFn.ref,
		});

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
		new cdk.CfnOutput(this, 'EdgeFunctionVersionArn', {
			value: edgeVersion.ref,
			description: 'Versioned ARN of the viewer-request Lambda@Edge function (feed AuthLambdaEdgeArn)',
		});
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
