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

import * as cloudfront from '@aws-sdk/client-cloudfront';
import * as s3 from '@aws-sdk/client-s3';
import * as sts from '@aws-sdk/client-sts';
import * as lambda from '@aws-sdk/client-lambda';
import * as iam from '@aws-sdk/client-iam';
import { buildProfileCredentialProvider } from '../../utils/awsCredentialChain';
import type CommonplaceNotesPlugin from '../../main';
import type { PublishingProfile } from '../../types';
import type { DeployHookAws } from './types';

/** Build the injected `aws` handle, pre-bound to the deploy's profile. */
export function buildDeployHookAws(
	plugin: CommonplaceNotesPlugin,
	profile: PublishingProfile,
): DeployHookAws {
	const m = plugin.awsSdkManager;
	return {
		cloudFront: () => m.getCloudFrontClient(profile),
		s3: () => m.getS3Client(profile),
		s3ForRegion: (region) => m.getS3ClientForRegion(profile, region),
		sts: () => m.getSTSClient(profile),
		dynamoDB: () => m.getDynamoDBClient(profile),
		lambda: (region) => m.getLambdaClient(profile, region),
		iam: (region) => m.getIamClient(profile, region),
		bedrockAgent: () => m.getBedrockAgentClient(profile),
		credentials: buildProfileCredentialProvider(profile.awsSettings!.awsProfile),
		sdk: { cloudfront, s3, sts, lambda, iam },
	};
}
