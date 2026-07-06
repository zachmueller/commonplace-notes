import { S3Client } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { IAMClient } from '@aws-sdk/client-iam';
import { fromEnv, fromIni, fromSSO } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentityProvider } from '@smithy/types';
import type { PublishingProfile } from '../types';
import type CommonplaceNotesPlugin from '../main';

export class AwsSdkManager {
	private plugin: CommonplaceNotesPlugin;
	private s3Clients: Map<string, S3Client> = new Map();
	private stsClients: Map<string, STSClient> = new Map();
	private cfClients: Map<string, CloudFrontClient> = new Map();
	private ddbClients: Map<string, DynamoDBDocumentClient> = new Map();
	// Lambda/IAM clients are keyed by `${profile.id}:${region}` — orphaned
	// Lambda@Edge cleanup targets us-east-1, which differs from the site region.
	private lambdaClients: Map<string, LambdaClient> = new Map();
	private iamClients: Map<string, IAMClient> = new Map();

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
	}

	getS3Client(profile: PublishingProfile): S3Client {
		const existing = this.s3Clients.get(profile.id);
		if (existing) return existing;

		const client = new S3Client({
			region: profile.awsSettings!.region,
			credentials: this.buildCredentialProvider(profile),
		});
		this.s3Clients.set(profile.id, client);
		return client;
	}

	getSTSClient(profile: PublishingProfile): STSClient {
		const existing = this.stsClients.get(profile.id);
		if (existing) return existing;

		const client = new STSClient({
			region: profile.awsSettings!.region,
			credentials: this.buildCredentialProvider(profile),
		});
		this.stsClients.set(profile.id, client);
		return client;
	}

	getCloudFrontClient(profile: PublishingProfile): CloudFrontClient {
		const existing = this.cfClients.get(profile.id);
		if (existing) return existing;

		const client = new CloudFrontClient({
			region: profile.awsSettings!.region,
			credentials: this.buildCredentialProvider(profile),
		});
		this.cfClients.set(profile.id, client);
		return client;
	}

	getDynamoDBClient(profile: PublishingProfile): DynamoDBDocumentClient {
		const existing = this.ddbClients.get(profile.id);
		if (existing) return existing;

		const base = new DynamoDBClient({
			region: profile.awsSettings!.region,
			credentials: this.buildCredentialProvider(profile),
		});
		// The Document client auto-marshals plain JS objects to/from
		// AttributeValue maps, so callers work with ordinary comment items.
		const client = DynamoDBDocumentClient.from(base);
		this.ddbClients.set(profile.id, client);
		return client;
	}

	/**
	 * Lambda client for deleting orphaned Lambda@Edge functions. Defaults to
	 * us-east-1 (where all Lambda@Edge functions live), region-keyed so it never
	 * collides with a site-region client.
	 */
	getLambdaClient(profile: PublishingProfile, region: string = 'us-east-1'): LambdaClient {
		const key = `${profile.id}:${region}`;
		const existing = this.lambdaClients.get(key);
		if (existing) return existing;

		const client = new LambdaClient({
			region,
			credentials: this.buildCredentialProvider(profile),
		});
		this.lambdaClients.set(key, client);
		return client;
	}

	/**
	 * IAM client for deleting orphaned edge-function execution roles. IAM is global;
	 * the region only sets the endpoint. Keyed like the Lambda client for symmetry.
	 */
	getIamClient(profile: PublishingProfile, region: string = 'us-east-1'): IAMClient {
		const key = `${profile.id}:${region}`;
		const existing = this.iamClients.get(key);
		if (existing) return existing;

		const client = new IAMClient({
			region,
			credentials: this.buildCredentialProvider(profile),
		});
		this.iamClients.set(key, client);
		return client;
	}

	private buildCredentialProvider(profile: PublishingProfile): AwsCredentialIdentityProvider {
		const awsProfile = profile.awsSettings!.awsProfile;

		const providers: AwsCredentialIdentityProvider[] = [
			fromEnv(),
			fromIni({ profile: awsProfile }),
			fromSSO({ profile: awsProfile }),
		];

		return async (identityProperties?: Record<string, any>) => {
			for (const provider of providers) {
				try {
					return await provider(identityProperties);
				} catch {
					// Fall through to next provider
				}
			}
			throw new Error(
				`No valid AWS credentials found for profile "${awsProfile}". ` +
				`Checked: environment variables, shared credentials file, SSO.`
			);
		};
	}

	invalidateClients(profileId: string): void {
		const s3 = this.s3Clients.get(profileId);
		if (s3) { s3.destroy(); this.s3Clients.delete(profileId); }

		const sts = this.stsClients.get(profileId);
		if (sts) { sts.destroy(); this.stsClients.delete(profileId); }

		const cf = this.cfClients.get(profileId);
		if (cf) { cf.destroy(); this.cfClients.delete(profileId); }

		const ddb = this.ddbClients.get(profileId);
		if (ddb) { ddb.destroy(); this.ddbClients.delete(profileId); }

		// Lambda/IAM maps are region-keyed (`${profileId}:${region}`) — drop every
		// region entry for this profile.
		for (const [key, client] of this.lambdaClients) {
			if (key === profileId || key.startsWith(`${profileId}:`)) { client.destroy(); this.lambdaClients.delete(key); }
		}
		for (const [key, client] of this.iamClients) {
			if (key === profileId || key.startsWith(`${profileId}:`)) { client.destroy(); this.iamClients.delete(key); }
		}
	}

	dispose(): void {
		for (const client of this.s3Clients.values()) client.destroy();
		for (const client of this.stsClients.values()) client.destroy();
		for (const client of this.cfClients.values()) client.destroy();
		for (const client of this.ddbClients.values()) client.destroy();
		for (const client of this.lambdaClients.values()) client.destroy();
		for (const client of this.iamClients.values()) client.destroy();
		this.s3Clients.clear();
		this.stsClients.clear();
		this.cfClients.clear();
		this.ddbClients.clear();
		this.lambdaClients.clear();
		this.iamClients.clear();
	}
}
