import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Per-account bootstrap stack (pinned to us-east-1).
 *
 * Owns a single versioned S3 bucket that holds Lambda@Edge code artifacts. This
 * exists because a Lambda@Edge function packaged as an S3 asset (`Code: {
 * S3Bucket, S3Key }`, the escape hatch from the 4096-byte inline `ZipFile` cap)
 * needs its code bucket to live in us-east-1 AND to exist BEFORE the edge stack
 * is created. The plugin uploads a content-addressed zip here, then passes the
 * bucket + key into the password auth stack.
 *
 * One per account (stack name `cpn-bootstrap`, no variant suffix): every
 * variant/profile in the account shares this bucket, keyed by content hash so
 * artifacts never collide. Versioning + a noncurrent-version expiry keep old
 * artifacts recoverable briefly while bounding storage cost.
 *
 * Deployed as a self-contained JSON TemplateBody (like the other cpn stacks),
 * so `bin/synth.ts` serializes it into `BOOTSTRAP_TEMPLATE`.
 */
export class BootstrapStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		// The globally-unique bucket name is computed plugin-side (needs the
		// account id) and passed in, so the template stays account-agnostic.
		const assetsBucketName = new cdk.CfnParameter(this, 'AssetsBucketName', {
			type: 'String',
			description: 'Globally-unique name for the Lambda@Edge code assets bucket',
		});

		const bucket = new cdk.aws_s3.CfnBucket(this, 'AssetsBucket', {
			bucketName: assetsBucketName.valueAsString,
			versioningConfiguration: { status: 'Enabled' },
			publicAccessBlockConfiguration: {
				blockPublicAcls: true,
				blockPublicPolicy: true,
				ignorePublicAcls: true,
				restrictPublicBuckets: true,
			},
			lifecycleConfiguration: {
				rules: [
					{
						id: 'expire-noncurrent-artifacts',
						status: 'Enabled',
						noncurrentVersionExpiration: { noncurrentDays: 30 },
					},
				],
			},
		});
		// Keep the shared artifact bucket across a stack delete — other variants
		// in the account may still reference artifacts in it.
		bucket.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;
		bucket.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;

		new cdk.CfnOutput(this, 'AssetsBucketNameOutput', {
			value: bucket.ref,
			description: 'Name of the Lambda@Edge code assets bucket',
		});
	}
}
