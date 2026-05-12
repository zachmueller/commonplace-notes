import { S3Client } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { fromEnv, fromIni, fromSSO } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentityProvider } from '@smithy/types';
import type { PublishingProfile } from '../types';
import type CommonplaceNotesPlugin from '../main';

export class AwsSdkManager {
	private plugin: CommonplaceNotesPlugin;
	private s3Clients: Map<string, S3Client> = new Map();
	private stsClients: Map<string, STSClient> = new Map();
	private cfClients: Map<string, CloudFrontClient> = new Map();

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
	}

	dispose(): void {
		for (const client of this.s3Clients.values()) client.destroy();
		for (const client of this.stsClients.values()) client.destroy();
		for (const client of this.cfClients.values()) client.destroy();
		this.s3Clients.clear();
		this.stsClients.clear();
		this.cfClients.clear();
	}
}
