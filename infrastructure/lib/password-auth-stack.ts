import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Built-in password read-gate sub-stack (branded HTML unlock page).
 *
 * Deployed FIRST (like the certificate / Cognito sub-stacks), pinned to
 * us-east-1 because it owns a viewer-request Lambda@Edge function whose
 * *versioned* ARN is fed into the existing `AuthLambdaEdgeArn` parameter of the
 * full-site stack. The full-site gating mechanism is untouched — this just
 * produces an interchangeable read-gate ARN (cognito | password | byo).
 *
 * Packaging: the edge fn code is an **S3 asset** (`Code: { S3Bucket, S3Key }`),
 * not inline `ZipFile`. The plugin composes the function source (baking in a
 * `const CFG = { hash, realm }` line — the plaintext password never leaves the
 * plugin; only its sha256 hash is baked in), zips it, and uploads it to the
 * per-account bootstrap bucket at a content-addressed key BEFORE deploying this
 * stack. This escapes the 4096-byte inline cap that the branded unlock page had
 * outgrown. Because the key is content-addressed, any code/config change yields
 * a new key -> the CfnFunction's Code changes on update -> CloudFormation
 * publishes a fresh Lambda@Edge version (CloudFront rejects $LATEST and only
 * re-points when the version ARN changes).
 *
 * Config could not stay a CloudFormation parameter here: an S3 asset cannot be
 * templated into, and Lambda@Edge forbids environment variables — hence the
 * bake-into-the-zip approach. The stack now takes the artifact location
 * (AssetsBucket/AssetsKey) instead of PasswordHash/Realm.
 */
export class PasswordAuthStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		const assetsBucket = new cdk.CfnParameter(this, 'AssetsBucket', {
			type: 'String',
			description: 'Name of the us-east-1 bootstrap bucket holding the edge-fn code zip',
		});

		const assetsKey = new cdk.CfnParameter(this, 'AssetsKey', {
			type: 'String',
			description: 'S3 key of the content-addressed edge-fn code zip (config baked in)',
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

		const edgeFn = new cdk.aws_lambda.CfnFunction(this, 'PasswordEdgeFn', {
			runtime: 'nodejs20.x',
			handler: 'index.handler',
			role: edgeRole.attrArn,
			code: {
				s3Bucket: assetsBucket.valueAsString,
				s3Key: assetsKey.valueAsString,
			},
		});

		// Lambda@Edge requires a *versioned* ARN; CloudFront rejects $LATEST. The
		// content-addressed AssetsKey means a code/config change alters the
		// function's Code, so CloudFormation publishes a new version on update.
		const edgeVersion = new cdk.aws_lambda.CfnVersion(this, 'PasswordEdgeFnVersion', {
			functionName: edgeFn.ref,
		});

		new cdk.CfnOutput(this, 'EdgeFunctionVersionArn', {
			value: edgeVersion.ref,
			description: 'Versioned ARN of the password viewer-request Lambda@Edge fn (feed AuthLambdaEdgeArn)',
		});
	}
}
