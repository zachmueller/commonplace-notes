import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { addAssetEdgeFunction } from './edge-function';

/**
 * Viewer-request Lambda@Edge for the built-in Cognito read gate, as its own
 * small us-east-1 stack (`cpn-authedge-<variant>`).
 *
 * This used to live inside the Cognito pool stack as an inline `ZipFile`, which
 * capped the handler at 4096 bytes. It is now an S3 asset (edge-function.ts), so
 * the handler (lib-jwt-verify.js + auth-edge.js) can grow freely, e.g. for
 * per-note access groups.
 *
 * The plugin deploys it AFTER the pool stack: the baked `const CFG = { domain,
 * clientId, region, userPoolId }` line needs the pool's outputs. Its versioned
 * ARN then feeds the full-site stack's `AuthLambdaEdgeArn` parameter.
 */
export class CognitoEdgeStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		addAssetEdgeFunction(this, {
			role: 'AuthEdgeFnRole',
			fn: 'AuthEdgeFn',
			version: 'AuthEdgeFnVersion',
		});

		new cdk.CfnOutput(this, 'EdgeGateKind', {
			value: 'cognito',
			description: 'Which built-in read gate this edge stack implements',
		});
	}
}
