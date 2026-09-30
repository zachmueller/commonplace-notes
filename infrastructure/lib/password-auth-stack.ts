import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { addAssetEdgeFunction } from './edge-function';

/**
 * Built-in password read-gate sub-stack (branded HTML unlock page).
 *
 * Deployed FIRST (like the certificate / Cognito sub-stacks), pinned to
 * us-east-1 because it owns a viewer-request Lambda@Edge function whose
 * *versioned* ARN is fed into the existing `AuthLambdaEdgeArn` parameter of the
 * full-site stack. The full-site gating mechanism is untouched — this just
 * produces an interchangeable read-gate ARN (cognito | password | byo).
 *
 * Packaging: the edge fn code is an **S3 asset** (see edge-function.ts). The
 * plugin bakes a `const CFG = { hash, realm }` line (only the sha256 hash of the
 * password, never the plaintext), zips it, and uploads it to the per-account
 * bootstrap bucket at a content-addressed key BEFORE deploying this stack.
 *
 * Logical IDs (EdgeFnRole / PasswordEdgeFn / PasswordEdgeFnVersion) are frozen:
 * existing deployments depend on them, and renaming would replace a replicated
 * Lambda@Edge function.
 */
export class PasswordAuthStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		addAssetEdgeFunction(this, {
			role: 'EdgeFnRole',
			fn: 'PasswordEdgeFn',
			version: 'PasswordEdgeFnVersion',
		});

		new cdk.CfnOutput(this, 'EdgeGateKind', {
			value: 'password',
			description: 'Which built-in read gate this edge stack implements',
		});
	}
}
