import {
	CloudFormationClient,
	CreateStackCommand,
	UpdateStackCommand,
	DeleteStackCommand,
	DescribeStacksCommand,
	DescribeStackEventsCommand,
} from '@aws-sdk/client-cloudformation';
import {
	ACMClient,
	DescribeCertificateCommand,
} from '@aws-sdk/client-acm';
import {
	Route53Client,
	ListHostedZonesCommand,
	CreateHostedZoneCommand,
} from '@aws-sdk/client-route-53';
import { fromEnv, fromIni, fromSSO } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentityProvider } from '@smithy/types';
import type { PublishingProfile } from '../types';
import type CommonplaceNotesPlugin from '../main';
import {
	CERTIFICATE_TEMPLATE,
	COGNITO_AUTH_TEMPLATE,
	FULL_STACK_OAC_TEMPLATE,
	FULL_STACK_OAI_TEMPLATE,
} from './templates';
import type {
	CognitoAuthOutputs,
	DeploymentConfig,
	DnsValidationRecord,
	HostedZoneInfo,
	StackEvent,
	StackOutputs,
} from './types';

const POLL_INTERVAL_MS = 5000;

const TERMINAL_STATUSES = new Set([
	'CREATE_COMPLETE',
	'CREATE_FAILED',
	'ROLLBACK_COMPLETE',
	'ROLLBACK_FAILED',
	'DELETE_COMPLETE',
	'DELETE_FAILED',
	'UPDATE_COMPLETE',
	'UPDATE_ROLLBACK_COMPLETE',
	'UPDATE_ROLLBACK_FAILED',
]);

export class CloudFormationManager {
	private plugin: CommonplaceNotesPlugin;
	private cfClients: Map<string, CloudFormationClient> = new Map();
	private acmClients: Map<string, ACMClient> = new Map();
	private route53Clients: Map<string, Route53Client> = new Map();

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
	}

	async deployCertificateStack(config: DeploymentConfig): Promise<string> {
		const stackName = this.getStackName(config.variantName, 'cert');
		const client = this.getCloudFormationClient(config, 'us-east-1');

		await client.send(new CreateStackCommand({
			StackName: stackName,
			TemplateBody: CERTIFICATE_TEMPLATE,
			Parameters: [
				{ ParameterKey: 'CustomDomain', ParameterValue: config.customDomain },
			],
			Tags: [
				{ Key: 'cpn:managed', Value: 'true' },
				{ Key: 'cpn:profile', Value: config.profileId },
			],
		}));

		return stackName;
	}

	private buildCognitoAuthParameters(config: DeploymentConfig) {
		return [
			{ ParameterKey: 'VariantName', ParameterValue: config.variantName },
			{ ParameterKey: 'GoogleClientId', ParameterValue: config.googleClientId || '' },
			{ ParameterKey: 'GoogleClientSecret', ParameterValue: config.googleClientSecret || '' },
			{ ParameterKey: 'CallbackURL', ParameterValue: config.callbackUrl || 'https://placeholder.invalid/auth/callback' },
			{ ParameterKey: 'AuthDomainPrefix', ParameterValue: config.authDomainPrefix || '' },
		];
	}

	/**
	 * Phase 1 of the two-phase Cognito deploy: create the auth sub-stack (user
	 * pool + Google IdP + Hosted UI + app client + viewer-request edge fn).
	 * Pinned to us-east-1 because it owns a Lambda@Edge function; needs
	 * CAPABILITY_IAM because it creates the Lambda execution roles.
	 */
	async deployCognitoAuthStack(config: DeploymentConfig): Promise<string> {
		const stackName = this.getStackName(config.variantName, 'cognito');
		const client = this.getCloudFormationClient(config, 'us-east-1');

		await client.send(new CreateStackCommand({
			StackName: stackName,
			TemplateBody: COGNITO_AUTH_TEMPLATE,
			Parameters: this.buildCognitoAuthParameters(config),
			Capabilities: ['CAPABILITY_IAM'],
			Tags: [
				{ Key: 'cpn:managed', Value: 'true' },
				{ Key: 'cpn:profile', Value: config.profileId },
			],
		}));

		return stackName;
	}

	/**
	 * Phase 2 of the two-phase Cognito deploy: re-pass all parameters with the
	 * real CallbackURL now that the site distribution domain is known. A pure
	 * parameter update — the UserPoolClient's CallbackURLs allow-list updates in
	 * place, no resource replacement. Skipped for custom-domain sites where the
	 * callback URL was already correct in phase 1.
	 */
	async updateCognitoAuthStack(config: DeploymentConfig): Promise<string> {
		const stackName = this.getStackName(config.variantName, 'cognito');
		const client = this.getCloudFormationClient(config, 'us-east-1');

		await client.send(new UpdateStackCommand({
			StackName: stackName,
			TemplateBody: COGNITO_AUTH_TEMPLATE,
			Parameters: this.buildCognitoAuthParameters(config),
			Capabilities: ['CAPABILITY_IAM'],
			Tags: [
				{ Key: 'cpn:managed', Value: 'true' },
				{ Key: 'cpn:profile', Value: config.profileId },
			],
		}));

		return stackName;
	}

	async getCognitoAuthOutputs(stackName: string, profile: PublishingProfile): Promise<CognitoAuthOutputs> {
		const client = this.getCloudFormationClientForProfile(profile, 'us-east-1');
		const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
		const stack = response.Stacks?.[0];
		if (!stack) throw new Error(`Cognito auth stack ${stackName} not found`);

		const outputs = stack.Outputs || [];
		const get = (key: string) => outputs.find(o => o.OutputKey === key)?.OutputValue || '';

		return {
			edgeFunctionVersionArn: get('EdgeFunctionVersionArn'),
			userPoolId: get('UserPoolId'),
			userPoolClientId: get('UserPoolClientId'),
			hostedUiDomain: get('HostedUiDomain'),
			jwksUri: get('JwksUri'),
			issuer: get('Issuer'),
			callbackApiDomain: get('CallbackApiDomain'),
		};
	}

	private buildFullStackParameters(config: DeploymentConfig) {
		return [
			{ ParameterKey: 'VariantName', ParameterValue: config.variantName },
			{ ParameterKey: 'S3Prefix', ParameterValue: config.s3Prefix },
			{ ParameterKey: 'CustomDomain', ParameterValue: config.customDomain },
			{ ParameterKey: 'CertificateArn', ParameterValue: config.certificateArn || '' },
			{ ParameterKey: 'UseRoute53', ParameterValue: config.useRoute53 ? 'true' : 'false' },
			{ ParameterKey: 'HostedZoneId', ParameterValue: config.hostedZoneId },
			{ ParameterKey: 'HostedZoneName', ParameterValue: config.hostedZoneName },
			{ ParameterKey: 'AuthLambdaEdgeArn', ParameterValue: config.authLambdaEdgeArn || '' },
			{ ParameterKey: 'CallbackApiDomainName', ParameterValue: config.callbackApiDomainName || '' },
			{ ParameterKey: 'CommentBucketDomainName', ParameterValue: config.commentBucketDomainName || '' },
			{ ParameterKey: 'CommentApiDomainName', ParameterValue: config.commentApiDomainName || '' },
		];
	}

	async deployFullStack(config: DeploymentConfig): Promise<string> {
		const stackName = this.getStackName(config.variantName, 'full');
		const client = this.getCloudFormationClient(config, config.region);
		const template = config.originAccessMethod === 'oac'
			? FULL_STACK_OAC_TEMPLATE
			: FULL_STACK_OAI_TEMPLATE;

		await client.send(new CreateStackCommand({
			StackName: stackName,
			TemplateBody: template,
			Parameters: this.buildFullStackParameters(config),
			Capabilities: ['CAPABILITY_IAM'],
			Tags: [
				{ Key: 'cpn:managed', Value: 'true' },
				{ Key: 'cpn:profile', Value: config.profileId },
			],
		}));

		return stackName;
	}

	async updateFullStack(config: DeploymentConfig): Promise<string> {
		const stackName = this.getStackName(config.variantName, 'full');
		const client = this.getCloudFormationClient(config, config.region);
		const template = config.originAccessMethod === 'oac'
			? FULL_STACK_OAC_TEMPLATE
			: FULL_STACK_OAI_TEMPLATE;

		await client.send(new UpdateStackCommand({
			StackName: stackName,
			TemplateBody: template,
			Parameters: this.buildFullStackParameters(config),
			Capabilities: ['CAPABILITY_IAM'],
			Tags: [
				{ Key: 'cpn:managed', Value: 'true' },
				{ Key: 'cpn:profile', Value: config.profileId },
			],
		}));

		return stackName;
	}

	async deleteStack(stackName: string, profile: PublishingProfile, region?: string): Promise<void> {
		const client = this.getCloudFormationClientForProfile(profile, region);
		await client.send(new DeleteStackCommand({ StackName: stackName }));
	}

	async getStackStatus(stackName: string, profile: PublishingProfile, region?: string): Promise<string> {
		const client = this.getCloudFormationClientForProfile(profile, region);
		const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
		const stack = response.Stacks?.[0];
		if (!stack) throw new Error(`Stack ${stackName} not found`);
		return stack.StackStatus!;
	}

	async getStackOutputs(stackName: string, profile: PublishingProfile, region?: string): Promise<StackOutputs> {
		const client = this.getCloudFormationClientForProfile(profile, region);
		const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
		const stack = response.Stacks?.[0];
		if (!stack) throw new Error(`Stack ${stackName} not found`);

		const outputs = stack.Outputs || [];
		const get = (key: string) => outputs.find(o => o.OutputKey === key)?.OutputValue || '';

		return {
			bucketName: get('BucketName'),
			distributionDomainName: get('DistributionDomainName'),
			distributionId: get('DistributionID'),
			siteUrl: get('SiteUrl'),
		};
	}

	async getCertificateArn(stackName: string, profile: PublishingProfile): Promise<string> {
		const client = this.getCloudFormationClientForProfile(profile, 'us-east-1');
		const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
		const stack = response.Stacks?.[0];
		if (!stack) throw new Error(`Certificate stack ${stackName} not found`);

		const outputs = stack.Outputs || [];
		return outputs.find(o => o.OutputKey === 'CertificateArn')?.OutputValue || '';
	}

	async getCertificateValidationRecords(certArn: string, profile: PublishingProfile): Promise<DnsValidationRecord[]> {
		const client = this.getAcmClient(profile);
		const response = await client.send(new DescribeCertificateCommand({
			CertificateArn: certArn,
		}));

		const options = response.Certificate?.DomainValidationOptions || [];
		return options
			.filter(opt => opt.ResourceRecord)
			.map(opt => ({
				name: opt.ResourceRecord!.Name!,
				value: opt.ResourceRecord!.Value!,
				type: 'CNAME' as const,
			}));
	}

	async checkCertificateStatus(certArn: string, profile: PublishingProfile): Promise<string> {
		const client = this.getAcmClient(profile);
		const response = await client.send(new DescribeCertificateCommand({
			CertificateArn: certArn,
		}));
		return response.Certificate?.Status || 'UNKNOWN';
	}

	async pollStackUntilComplete(
		stackName: string,
		profile: PublishingProfile,
		onEvent: (event: StackEvent) => void,
		region?: string,
	): Promise<string> {
		const client = this.getCloudFormationClientForProfile(profile, region);
		const seenEventIds = new Set<string>();
		const startTime = new Date();

		while (true) {
			const response = await client.send(new DescribeStackEventsCommand({
				StackName: stackName,
			}));

			const events = (response.StackEvents || [])
				.filter(e => e.Timestamp && e.Timestamp >= startTime)
				.sort((a, b) => a.Timestamp!.getTime() - b.Timestamp!.getTime());

			for (const event of events) {
				if (seenEventIds.has(event.EventId!)) continue;
				seenEventIds.add(event.EventId!);

				onEvent({
					resourceType: event.ResourceType || '',
					logicalResourceId: event.LogicalResourceId || '',
					status: event.ResourceStatus || '',
					reason: event.ResourceStatusReason,
					timestamp: event.Timestamp!,
				});
			}

			const statusResponse = await client.send(new DescribeStacksCommand({ StackName: stackName }));
			const currentStatus = statusResponse.Stacks?.[0]?.StackStatus || '';

			if (TERMINAL_STATUSES.has(currentStatus)) {
				return currentStatus;
			}

			await this.sleep(POLL_INTERVAL_MS);
		}
	}

	async importStack(stackName: string, profile: PublishingProfile, region?: string): Promise<StackOutputs> {
		return this.getStackOutputs(stackName, profile, region);
	}

	async listHostedZones(profile: PublishingProfile): Promise<HostedZoneInfo[]> {
		const client = this.getRoute53Client(profile);
		const zones: HostedZoneInfo[] = [];
		let marker: string | undefined;

		do {
			const response = await client.send(new ListHostedZonesCommand({
				Marker: marker,
			}));
			for (const zone of response.HostedZones || []) {
				zones.push({
					id: zone.Id!.replace('/hostedzone/', ''),
					name: zone.Name!.replace(/\.$/, ''),
				});
			}
			marker = response.IsTruncated ? response.NextMarker : undefined;
		} while (marker);

		return zones;
	}

	async findHostedZoneForDomain(profile: PublishingProfile, domain: string): Promise<HostedZoneInfo | null> {
		const zones = await this.listHostedZones(profile);
		const domainParts = domain.split('.');

		for (let i = 0; i < domainParts.length - 1; i++) {
			const candidate = domainParts.slice(i).join('.');
			const match = zones.find(z => z.name === candidate);
			if (match) return match;
		}
		return null;
	}

	async createHostedZone(profile: PublishingProfile, domain: string): Promise<HostedZoneInfo> {
		const client = this.getRoute53Client(profile);
		const response = await client.send(new CreateHostedZoneCommand({
			Name: domain,
			CallerReference: `cpn-${Date.now()}`,
		}));
		return {
			id: response.HostedZone!.Id!.replace('/hostedzone/', ''),
			name: response.HostedZone!.Name!.replace(/\.$/, ''),
		};
	}

	getStackName(variantName: string, type: 'cert' | 'full' | 'cognito' | 'comment'): string {
		const suffix = variantName || 'default';
		switch (type) {
			case 'cert': return `cpn-cert-${suffix}`;
			case 'cognito': return `cpn-cognito-${suffix}`;
			case 'comment': return `cpn-comment-${suffix}`;
			default: return `cpn-${suffix}`;
		}
	}

	dispose(): void {
		for (const client of this.cfClients.values()) client.destroy();
		for (const client of this.acmClients.values()) client.destroy();
		for (const client of this.route53Clients.values()) client.destroy();
		this.cfClients.clear();
		this.acmClients.clear();
		this.route53Clients.clear();
	}

	private getCloudFormationClient(config: DeploymentConfig, region: string): CloudFormationClient {
		const key = `${config.awsProfile}:${region}`;
		const existing = this.cfClients.get(key);
		if (existing) return existing;

		const client = new CloudFormationClient({
			region,
			credentials: this.buildCredentialProvider(config.awsProfile),
		});
		this.cfClients.set(key, client);
		return client;
	}

	private getCloudFormationClientForProfile(profile: PublishingProfile, region?: string): CloudFormationClient {
		const awsProfile = profile.awsSettings!.awsProfile;
		const resolvedRegion = region || profile.awsSettings!.region;
		const key = `${awsProfile}:${resolvedRegion}`;
		const existing = this.cfClients.get(key);
		if (existing) return existing;

		const client = new CloudFormationClient({
			region: resolvedRegion,
			credentials: this.buildCredentialProvider(awsProfile),
		});
		this.cfClients.set(key, client);
		return client;
	}

	private getRoute53Client(profile: PublishingProfile): Route53Client {
		const awsProfile = profile.awsSettings!.awsProfile;
		const key = awsProfile;
		const existing = this.route53Clients.get(key);
		if (existing) return existing;

		const client = new Route53Client({
			region: 'us-east-1',
			credentials: this.buildCredentialProvider(awsProfile),
		});
		this.route53Clients.set(key, client);
		return client;
	}

	private getAcmClient(profile: PublishingProfile): ACMClient {
		const awsProfile = profile.awsSettings!.awsProfile;
		const key = awsProfile;
		const existing = this.acmClients.get(key);
		if (existing) return existing;

		const client = new ACMClient({
			region: 'us-east-1',
			credentials: this.buildCredentialProvider(awsProfile),
		});
		this.acmClients.set(key, client);
		return client;
	}

	private buildCredentialProvider(awsProfile: string): AwsCredentialIdentityProvider {
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

	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
}
