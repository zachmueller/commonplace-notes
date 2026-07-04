import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { readInlineLambda } from './inline-code';

/**
 * Built-in password read-gate sub-stack (branded HTML unlock page).
 *
 * Deployed FIRST (like the certificate / Cognito sub-stacks), pinned to
 * us-east-1 because it owns a viewer-request Lambda@Edge function whose
 * *versioned* ARN is fed into the existing `AuthLambdaEdgeArn` parameter of the
 * full-site stack. The full-site gating mechanism is untouched — this just
 * produces an interchangeable read-gate ARN (cognito | password | byo).
 *
 * The plugin computes sha256(password) and passes only the hash; the plaintext
 * never leaves the plugin. The hash is baked into the inline edge-fn code via
 * Fn::Sub, so (like the Cognito CFG) it is visible to anyone with AWS read
 * access to the account — acceptable for a shared low-sensitivity read password.
 *
 * All L1 (Cfn*) constructs + inline Lambda code so synth produces a
 * self-contained JSON TemplateBody with no asset staging.
 */
export class PasswordAuthStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		const passwordHash = new cdk.CfnParameter(this, 'PasswordHash', {
			type: 'String',
			noEcho: true,
			description: 'Lowercase hex sha256 of the shared read password (computed plugin-side)',
		});

		// Kept the param name `Realm` (avoids a template migration); it now feeds
		// the heading/title of the branded unlock page rather than a Basic Auth realm.
		const realm = new cdk.CfnParameter(this, 'Realm', {
			type: 'String',
			default: 'Protected',
			description: 'Site name shown as the heading on the password unlock page',
		});

		const edgeRole = new cdk.aws_iam.CfnRole(this, 'EdgeFnRole', {
			assumeRolePolicyDocument: {
				Version: '2012-10-17',
				Statement: [
					{
						Effect: 'Allow',
						Principal: { Service: ['lambda.amazonaws.com', 'edgelambda.amazonaws.com'] },
						Action: 'sts:AssumeRole',
					},
				],
			},
			managedPolicyArns: ['arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
		});

		// Inject CFG ahead of the verbatim (comment-stripped) body. The body
		// contains no `${...}` or backticks, so Fn::Join carries it safely.
		const body = readInlineLambda('password-edge.js');
		const cfgLine = cdk.Fn.sub(
			'const CFG = { hash: "${Hash}", realm: "${Realm}" };\n',
			{ Hash: passwordHash.valueAsString, Realm: realm.valueAsString },
		);
		const zipFile = cdk.Fn.join('', [cfgLine, body]);

		const edgeFn = new cdk.aws_lambda.CfnFunction(this, 'PasswordEdgeFn', {
			runtime: 'nodejs20.x',
			handler: 'index.handler',
			role: edgeRole.attrArn,
			code: { zipFile },
		});

		// Lambda@Edge requires a *versioned* ARN; CloudFront rejects $LATEST.
		const edgeVersion = new cdk.aws_lambda.CfnVersion(this, 'PasswordEdgeFnVersion', {
			functionName: edgeFn.ref,
		});

		new cdk.CfnOutput(this, 'EdgeFunctionVersionArn', {
			value: edgeVersion.ref,
			description: 'Versioned ARN of the password viewer-request Lambda@Edge fn (feed AuthLambdaEdgeArn)',
		});
	}
}
