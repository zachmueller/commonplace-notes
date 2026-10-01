import * as cdk from 'aws-cdk-lib';

/**
 * Shared construction for a viewer-request Lambda@Edge function whose code is
 * an **S3 asset** in the per-account `cpn-bootstrap` bucket (never inline
 * `ZipFile`, so there is no 4096-byte cap on the function source).
 *
 * The plugin composes the source (baking a leading `const CFG = {...};` line,
 * since Lambda@Edge forbids environment variables), zips it deterministically,
 * uploads it at a content-addressed key, and passes three parameters:
 *   AssetsBucket / AssetsKey — where the zip lives
 *   CodeSha256              — base64 sha256 of the zip bytes (Lambda's CodeSha256)
 *
 * Why CodeSha256 is wired onto the Version: an `AWS::Lambda::Version` whose
 * properties don't change is never re-created, so a code-only update would move
 * `$LATEST` but leave the versioned ARN (the only thing CloudFront accepts)
 * pointing at the old code. CodeSha256 is a replacement-triggering property, so
 * every artifact change publishes a fresh version. `UpdateReplacePolicy: Retain`
 * keeps the superseded version: it is usually still attached to CloudFront (and
 * replicated) when the replacement runs, so a delete would fail anyway, and if
 * Lambda returns the same version for identical code the "old" physical ID is the
 * live one. Superseded versions are removed with the function on stack delete.
 *
 * Logical IDs are caller-supplied so existing stacks (password) keep theirs.
 * Renaming them would replace a replicated function on update.
 */
export interface AssetEdgeFunctionIds {
	role: string;
	fn: string;
	version: string;
}

export interface AssetEdgeFunction {
	fn: cdk.aws_lambda.CfnFunction;
	version: cdk.aws_lambda.CfnVersion;
}

export function addAssetEdgeFunction(stack: cdk.Stack, ids: AssetEdgeFunctionIds): AssetEdgeFunction {
	const assetsBucket = new cdk.CfnParameter(stack, 'AssetsBucket', {
		type: 'String',
		description: 'Name of the us-east-1 bootstrap bucket holding the edge-fn code zip',
	});

	const assetsKey = new cdk.CfnParameter(stack, 'AssetsKey', {
		type: 'String',
		description: 'S3 key of the content-addressed edge-fn code zip (config baked in)',
	});

	const codeSha256 = new cdk.CfnParameter(stack, 'CodeSha256', {
		type: 'String',
		default: '',
		description:
			'Base64 sha256 of the code zip. Changing it forces a new Lambda version so ' +
			'CloudFront can be re-pointed at new code. Empty skips the check.',
	});
	const hasCodeSha = new cdk.CfnCondition(stack, 'HasCodeSha256', {
		expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(codeSha256.valueAsString, '')),
	});

	const role = new cdk.aws_iam.CfnRole(stack, ids.role, {
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

	const fn = new cdk.aws_lambda.CfnFunction(stack, ids.fn, {
		runtime: 'nodejs24.x',
		handler: 'index.handler',
		role: role.attrArn,
		code: {
			s3Bucket: assetsBucket.valueAsString,
			s3Key: assetsKey.valueAsString,
		},
	});

	// Lambda@Edge requires a *versioned* ARN; CloudFront rejects $LATEST.
	const version = new cdk.aws_lambda.CfnVersion(stack, ids.version, {
		functionName: fn.ref,
		codeSha256: cdk.Fn.conditionIf(
			hasCodeSha.logicalId,
			codeSha256.valueAsString,
			cdk.Aws.NO_VALUE,
		).toString(),
	});
	version.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;

	new cdk.CfnOutput(stack, 'EdgeFunctionVersionArn', {
		value: version.ref,
		description: 'Versioned ARN of the viewer-request Lambda@Edge fn (feed AuthLambdaEdgeArn)',
	});

	return { fn, version };
}
