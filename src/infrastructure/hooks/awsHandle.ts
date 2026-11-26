/**
 * Builds the `aws` handle injected into every deploy hook.
 *
 * Curated client factories forward to the plugin's `AwsSdkManager` getters, so
 * the hook borrows the SAME cached, per-`profile.id` clients the rest of the
 * plugin uses (and `invalidateClients()`/`dispose()` clears them too). The raw
 * credential provider and the `@aws-sdk/client-*` namespaces are exposed for
 * hooks that need to construct arbitrary clients + Command objects the vault
 * `.md` sandbox cannot `import`.
 */

import { buildProfileCredentialProvider } from '../../utils/awsCredentialChain';
import { awsSdk } from '../../utils/awsModules';
import type CommonplaceNotesPlugin from '../../main';
import type { PublishingProfile } from '../../types';
import type { DeployHookAws } from './types';

/**
 * Build the injected `aws` handle, pre-bound to the deploy's profile.
 *
 * Async because it loads the SDK modules first (src/utils/awsModules.ts):
 * the handle's client factories and `sdk` namespaces stay synchronous for
 * hooks, which is the contract hook files are written against.
 */
export async function buildDeployHookAws(
	plugin: CommonplaceNotesPlugin,
	profile: PublishingProfile,
): Promise<DeployHookAws> {
	const m = plugin.awsSdkManager;
	await m.preloadClientModules();
	return {
		cloudFront: () => m.getCloudFrontClientSync(profile),
		s3: () => m.getS3ClientSync(profile),
		s3ForRegion: (region) => m.getS3ClientForRegionSync(profile, region),
		sts: () => m.getSTSClientSync(profile),
		dynamoDB: () => m.getDynamoDBClientSync(profile),
		lambda: (region) => m.getLambdaClientSync(profile, region),
		iam: (region) => m.getIamClientSync(profile, region),
		bedrockAgent: () => m.getBedrockAgentClientSync(profile),
		credentials: buildProfileCredentialProvider(profile.awsSettings!.awsProfile),
		sdk: {
			cloudfront: awsSdk.cloudFront.loaded(),
			s3: awsSdk.s3.loaded(),
			sts: awsSdk.sts.loaded(),
			lambda: awsSdk.lambda.loaded(),
			iam: awsSdk.iam.loaded(),
		},
	};
}
