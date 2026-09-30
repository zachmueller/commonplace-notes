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
 *
 * `PublicReads` records which mode the baked code runs in (the code itself
 * reads `CFG.publicReads`): 'false' gates the whole site behind sign-in,
 * 'true' leaves public notes anonymous and gates only `/restricted/<group>/*`.
 * It is echoed as an output so stack import can tell the modes apart.
 */
export class CognitoEdgeStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		const publicReads = new cdk.CfnParameter(this, 'PublicReads', {
			type: 'String',
			default: 'false',
			allowedValues: ['true', 'false'],
			description: "'true' when the baked edge code runs in public-reads mode (only /restricted/* needs sign-in)",
		});

		addAssetEdgeFunction(this, {
			role: 'AuthEdgeFnRole',
			fn: 'AuthEdgeFn',
			version: 'AuthEdgeFnVersion',
		});

		new cdk.CfnOutput(this, 'EdgeGateKind', {
			value: 'cognito',
			description: 'Which built-in read gate this edge stack implements',
		});

		// Parameters and outputs are separate CloudFormation namespaces, but CDK
		// construct ids are not, so name the construct differently and pin the
		// output's logical id.
		const publicReadsOut = new cdk.CfnOutput(this, 'PublicReadsOutput', {
			value: publicReads.valueAsString,
			description: "'true' when public notes pass without sign-in (per-note access groups on a public site)",
		});
		publicReadsOut.overrideLogicalId('PublicReads');
	}
}
