import type { S3Client } from '@aws-sdk/client-s3';
import type { STSClient } from '@aws-sdk/client-sts';
import type { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import type { IAMClient } from '@aws-sdk/client-iam';
import type { BedrockAgentClient } from '@aws-sdk/client-bedrock-agent';
import type { AwsCredentialIdentityProvider } from '@smithy/types';
import type { PublishingProfile } from '../types';
import type CommonplaceNotesPlugin from '../main';
import { buildProfileCredentialProvider } from './awsCredentialChain';
import { awsSdk } from './awsModules';

/**
 * Per-profile AWS SDK clients, cached until invalidated.
 *
 * The `get*Client` getters are async: the first call loads the SDK module
 * (src/utils/awsModules.ts), so the SDK is never evaluated at plugin load. A
 * cached client is returned without loading anything.
 *
 * The `*ClientSync` twins are for code that has to hand out clients
 * synchronously (the deploy-hook `aws` handle). They throw unless
 * `preloadClientModules()` has resolved first.
 */
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
	private bedrockAgentClients: Map<string, BedrockAgentClient> = new Map();

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
	}

	/** Load every module the client getters use, so the `*ClientSync` twins work. */
	async preloadClientModules(): Promise<void> {
		await Promise.all([
			awsSdk.s3(),
			awsSdk.sts(),
			awsSdk.cloudFront(),
			awsSdk.dynamoDB(),
			awsSdk.dynamoDBDocument(),
			awsSdk.lambda(),
			awsSdk.iam(),
			awsSdk.bedrockAgent(),
		]);
	}

	async getS3Client(profile: PublishingProfile): Promise<S3Client> {
		if (!this.s3Clients.has(profile.id)) await awsSdk.s3();
		return this.getS3ClientSync(profile);
	}

	getS3ClientSync(profile: PublishingProfile): S3Client {
		const existing = this.s3Clients.get(profile.id);
		if (existing) return existing;

		const { S3Client } = awsSdk.s3.loaded();
		const client = new S3Client({
			region: profile.awsSettings!.region,
			credentials: this.buildCredentialProvider(profile),
		});
		this.s3Clients.set(profile.id, client);
		return client;
	}

	/**
	 * S3 client scoped to an explicit region, keyed by `${profile.id}:${region}`.
	 * The default getS3Client is pinned to the SITE region; uploading Lambda@Edge
	 * code artifacts targets the us-east-1 bootstrap bucket, which differs. Mirrors
	 * getLambdaClient's region-keyed caching so it never collides with the
	 * site-region client.
	 */
	async getS3ClientForRegion(profile: PublishingProfile, region: string): Promise<S3Client> {
		if (!this.s3Clients.has(`${profile.id}:${region}`)) await awsSdk.s3();
		return this.getS3ClientForRegionSync(profile, region);
	}

	getS3ClientForRegionSync(profile: PublishingProfile, region: string): S3Client {
		const key = `${profile.id}:${region}`;
		const existing = this.s3Clients.get(key);
		if (existing) return existing;

		const { S3Client } = awsSdk.s3.loaded();
		const client = new S3Client({
			region,
			credentials: this.buildCredentialProvider(profile),
		});
		this.s3Clients.set(key, client);
		return client;
	}

	async getSTSClient(profile: PublishingProfile): Promise<STSClient> {
		if (!this.stsClients.has(profile.id)) await awsSdk.sts();
		return this.getSTSClientSync(profile);
	}

	getSTSClientSync(profile: PublishingProfile): STSClient {
		const existing = this.stsClients.get(profile.id);
		if (existing) return existing;

		const { STSClient } = awsSdk.sts.loaded();
		const client = new STSClient({
			region: profile.awsSettings!.region,
			credentials: this.buildCredentialProvider(profile),
		});
		this.stsClients.set(profile.id, client);
		return client;
	}

	async getCloudFrontClient(profile: PublishingProfile): Promise<CloudFrontClient> {
		if (!this.cfClients.has(profile.id)) await awsSdk.cloudFront();
		return this.getCloudFrontClientSync(profile);
	}

	getCloudFrontClientSync(profile: PublishingProfile): CloudFrontClient {
		const existing = this.cfClients.get(profile.id);
		if (existing) return existing;

		const { CloudFrontClient } = awsSdk.cloudFront.loaded();
		const client = new CloudFrontClient({
			region: profile.awsSettings!.region,
			credentials: this.buildCredentialProvider(profile),
		});
		this.cfClients.set(profile.id, client);
		return client;
	}

	async getDynamoDBClient(profile: PublishingProfile): Promise<DynamoDBDocumentClient> {
		if (!this.ddbClients.has(profile.id)) await Promise.all([awsSdk.dynamoDB(), awsSdk.dynamoDBDocument()]);
		return this.getDynamoDBClientSync(profile);
	}

	getDynamoDBClientSync(profile: PublishingProfile): DynamoDBDocumentClient {
		const existing = this.ddbClients.get(profile.id);
		if (existing) return existing;

		const { DynamoDBClient } = awsSdk.dynamoDB.loaded();
		const { DynamoDBDocumentClient } = awsSdk.dynamoDBDocument.loaded();
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
	async getLambdaClient(profile: PublishingProfile, region: string = 'us-east-1'): Promise<LambdaClient> {
		if (!this.lambdaClients.has(`${profile.id}:${region}`)) await awsSdk.lambda();
		return this.getLambdaClientSync(profile, region);
	}

	getLambdaClientSync(profile: PublishingProfile, region: string = 'us-east-1'): LambdaClient {
		const key = `${profile.id}:${region}`;
		const existing = this.lambdaClients.get(key);
		if (existing) return existing;

		const { LambdaClient } = awsSdk.lambda.loaded();
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
	async getIamClient(profile: PublishingProfile, region: string = 'us-east-1'): Promise<IAMClient> {
		if (!this.iamClients.has(`${profile.id}:${region}`)) await awsSdk.iam();
		return this.getIamClientSync(profile, region);
	}

	getIamClientSync(profile: PublishingProfile, region: string = 'us-east-1'): IAMClient {
		const key = `${profile.id}:${region}`;
		const existing = this.iamClients.get(key);
		if (existing) return existing;

		const { IAMClient } = awsSdk.iam.loaded();
		const client = new IAMClient({
			region,
			credentials: this.buildCredentialProvider(profile),
		});
		this.iamClients.set(key, client);
		return client;
	}

	/**
	 * Bedrock Agent client for firing KB ingestion jobs (StartIngestionJob) after a
	 * publish uploads changed kb/{uid}.md corpus objects. Pinned to the site region
	 * (where the chat stack + KB live).
	 */
	async getBedrockAgentClient(profile: PublishingProfile): Promise<BedrockAgentClient> {
		if (!this.bedrockAgentClients.has(profile.id)) await awsSdk.bedrockAgent();
		return this.getBedrockAgentClientSync(profile);
	}

	getBedrockAgentClientSync(profile: PublishingProfile): BedrockAgentClient {
		const existing = this.bedrockAgentClients.get(profile.id);
		if (existing) return existing;

		const { BedrockAgentClient } = awsSdk.bedrockAgent.loaded();
		const client = new BedrockAgentClient({
			region: profile.awsSettings!.region,
			credentials: this.buildCredentialProvider(profile),
		});
		this.bedrockAgentClients.set(profile.id, client);
		return client;
	}

	private buildCredentialProvider(profile: PublishingProfile): AwsCredentialIdentityProvider {
		return buildProfileCredentialProvider(profile.awsSettings!.awsProfile);
	}

	invalidateClients(profileId: string): void {
		// S3 map holds both the site-region client (keyed by profileId) and any
		// region-keyed clients (`${profileId}:${region}`) — drop them all.
		for (const [key, client] of this.s3Clients) {
			if (key === profileId || key.startsWith(`${profileId}:`)) { client.destroy(); this.s3Clients.delete(key); }
		}

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

		const bedrock = this.bedrockAgentClients.get(profileId);
		if (bedrock) { bedrock.destroy(); this.bedrockAgentClients.delete(profileId); }
	}

	dispose(): void {
		for (const client of this.s3Clients.values()) client.destroy();
		for (const client of this.stsClients.values()) client.destroy();
		for (const client of this.cfClients.values()) client.destroy();
		for (const client of this.ddbClients.values()) client.destroy();
		for (const client of this.lambdaClients.values()) client.destroy();
		for (const client of this.iamClients.values()) client.destroy();
		for (const client of this.bedrockAgentClients.values()) client.destroy();
		this.s3Clients.clear();
		this.stsClients.clear();
		this.cfClients.clear();
		this.ddbClients.clear();
		this.lambdaClients.clear();
		this.iamClients.clear();
		this.bedrockAgentClients.clear();
	}
}
