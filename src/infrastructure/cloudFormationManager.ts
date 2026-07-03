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
	ListCertificatesCommand,
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
	COMMENT_STACK_TEMPLATE,
	FULL_STACK_OAC_TEMPLATE,
	FULL_STACK_OAI_TEMPLATE,
	PASSWORD_AUTH_TEMPLATE,
} from './templates';
import type {
	CertificateMatch,
	CognitoAuthOutputs,
	CommentStackOutputs,
	DeploymentConfig,
	DnsValidationRecord,
	HostedZoneInfo,
	StackEvent,
	StackOutputs,
} from './types';
import { certCoversDomain } from './certMatch';

const POLL_INTERVAL_MS = 5000;

/** CloudFront-compatible ACM key algorithms. ListCertificates defaults to RSA
 * only, so ECDSA certs must be requested explicitly via Includes.keyTypes. */
const CLOUDFRONT_KEY_TYPES = ['RSA_2048', 'EC_prime256v1', 'EC_secp384r1'];

/** Light projection of an ACM ListCertificates summary (SANs may be truncated). */
interface CertSummaryLite {
	arn: string;
	domainName: string;
	sans: string[];
	hasAdditionalSans: boolean;
	notAfter?: number;
	inUse: boolean;
}

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

	/**
	 * Deploy the built-in password (HTTP Basic Auth) read-gate sub-stack. Pinned
	 * to us-east-1 (Lambda@Edge) with CAPABILITY_IAM. Only the sha256 hash is
	 * passed; the plaintext password never leaves the plugin.
	 */
	async deployPasswordAuthStack(config: DeploymentConfig): Promise<string> {
		const stackName = this.getStackName(config.variantName, 'password');
		const client = this.getCloudFormationClient(config, 'us-east-1');

		await client.send(new CreateStackCommand({
			StackName: stackName,
			TemplateBody: PASSWORD_AUTH_TEMPLATE,
			Parameters: [
				{ ParameterKey: 'PasswordHash', ParameterValue: config.passwordHash || '' },
				{ ParameterKey: 'Realm', ParameterValue: config.variantName || 'Protected' },
			],
			Capabilities: ['CAPABILITY_IAM'],
			Tags: [
				{ Key: 'cpn:managed', Value: 'true' },
				{ Key: 'cpn:profile', Value: config.profileId },
			],
		}));

		return stackName;
	}

	async getPasswordAuthOutputs(stackName: string, profile: PublishingProfile): Promise<{ edgeFunctionVersionArn: string }> {
		const client = this.getCloudFormationClientForProfile(profile, 'us-east-1');
		const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
		const stack = response.Stacks?.[0];
		if (!stack) throw new Error(`Password auth stack ${stackName} not found`);

		const outputs = stack.Outputs || [];
		return {
			edgeFunctionVersionArn: outputs.find(o => o.OutputKey === 'EdgeFunctionVersionArn')?.OutputValue || '',
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

	/**
	 * Deploy the self-hosted comment backend (DynamoDB + stream re-export + write
	 * API with cookie authorizer). Deployed in the site region, after the full
	 * stack (it needs the site distribution/OAI id for the comment bucket's
	 * cross-stack read grant) and after the Cognito stack (it needs the pool's
	 * JWKS/issuer/client id for the authorizer). CAPABILITY_IAM for Lambda roles.
	 */
	async deployCommentStack(config: DeploymentConfig): Promise<string> {
		const stackName = this.getStackName(config.variantName, 'comment');
		const client = this.getCloudFormationClient(config, config.region);

		await client.send(new CreateStackCommand({
			StackName: stackName,
			TemplateBody: COMMENT_STACK_TEMPLATE,
			Parameters: [
				{ ParameterKey: 'VariantName', ParameterValue: config.variantName },
				{ ParameterKey: 'JwksUri', ParameterValue: config.commentJwksUri || '' },
				{ ParameterKey: 'TokenIssuer', ParameterValue: config.commentTokenIssuer || '' },
				{ ParameterKey: 'UserPoolClientId', ParameterValue: config.commentUserPoolClientId || '' },
				{ ParameterKey: 'OriginAccessMethod', ParameterValue: config.originAccessMethod },
				{ ParameterKey: 'SiteDistributionId', ParameterValue: config.siteDistributionId || '' },
				{ ParameterKey: 'SiteOriginAccessIdentityId', ParameterValue: config.siteOriginAccessIdentityId || '' },
			],
			Capabilities: ['CAPABILITY_IAM'],
			Tags: [
				{ Key: 'cpn:managed', Value: 'true' },
				{ Key: 'cpn:profile', Value: config.profileId },
			],
		}));

		return stackName;
	}

	async getCommentStackOutputs(stackName: string, profile: PublishingProfile, region?: string): Promise<CommentStackOutputs> {
		const client = this.getCloudFormationClientForProfile(profile, region);
		const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
		const stack = response.Stacks?.[0];
		if (!stack) throw new Error(`Comment stack ${stackName} not found`);

		const outputs = stack.Outputs || [];
		const get = (key: string) => outputs.find(o => o.OutputKey === key)?.OutputValue || '';

		return {
			bucketName: get('CommentBucketName'),
			bucketDomainName: get('CommentBucketDomainName'),
			apiDomain: get('CommentApiDomain'),
			tableName: get('CommentTableName'),
		};
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
			originAccessIdentityId: get('OriginAccessIdentityId') || undefined,
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

	/**
	 * List every ISSUED certificate in the account (us-east-1), paginated. Passes
	 * Includes.keyTypes so CloudFront-compatible ECDSA certs are returned too —
	 * ListCertificates otherwise defaults to RSA only. SAN summaries here may be
	 * truncated (see `hasAdditionalSans`); callers needing the full list must fall
	 * back to DescribeCertificate.
	 */
	async listIssuedCertificates(profile: PublishingProfile): Promise<CertSummaryLite[]> {
		const client = this.getAcmClient(profile);
		const summaries: CertSummaryLite[] = [];
		let nextToken: string | undefined;

		do {
			const response = await client.send(new ListCertificatesCommand({
				CertificateStatuses: ['ISSUED'],
				Includes: { keyTypes: CLOUDFRONT_KEY_TYPES as any },
				NextToken: nextToken,
			}));
			for (const cert of response.CertificateSummaryList || []) {
				if (!cert.CertificateArn) continue;
				summaries.push({
					arn: cert.CertificateArn,
					domainName: cert.DomainName || '',
					sans: cert.SubjectAlternativeNameSummaries || [],
					hasAdditionalSans: cert.HasAdditionalSubjectAlternativeNames || false,
					notAfter: cert.NotAfter ? cert.NotAfter.getTime() : undefined,
					inUse: cert.InUse || false,
				});
			}
			nextToken = response.NextToken;
		} while (nextToken);

		return summaries;
	}

	/**
	 * Find ISSUED certificates that cover the given domain — matched against the
	 * primary DomainName and all SANs, with ACM wildcard semantics. When a
	 * summary's SANs are truncated, or a wildcard/exact hit needs confirming,
	 * DescribeCertificate resolves the full SAN list (only when needed, to avoid a
	 * DescribeCertificate call per certificate). Results are sorted best-first:
	 * exact matches before wildcard, then latest expiry. A single DescribeCertificate
	 * failure skips that cert rather than failing the whole lookup.
	 */
	async findMatchingCertificates(domain: string, profile: PublishingProfile): Promise<CertificateMatch[]> {
		const summaries = await this.listIssuedCertificates(profile);
		const matches: CertificateMatch[] = [];

		for (const summary of summaries) {
			const summaryNames = [summary.domainName, ...summary.sans].filter(Boolean);
			let matchType = certCoversDomain(summaryNames, domain);
			let sans = summary.sans;

			// Resolve the full SAN list when the summary was truncated and we have
			// not already found a match in the visible names.
			if (!matchType && summary.hasAdditionalSans) {
				try {
					const full = await this.describeCertificateFullNames(summary.arn, profile);
					sans = full.sans;
					matchType = certCoversDomain([full.domainName, ...full.sans].filter(Boolean), domain);
				} catch {
					// Skip a cert we cannot describe rather than failing the lookup.
					continue;
				}
			}

			if (matchType) {
				matches.push({
					arn: summary.arn,
					domainName: summary.domainName,
					sans,
					matchType,
					notAfter: summary.notAfter,
					inUse: summary.inUse,
				});
			}
		}

		return matches.sort((a, b) => {
			if (a.matchType !== b.matchType) return a.matchType === 'exact' ? -1 : 1;
			return (b.notAfter || 0) - (a.notAfter || 0);
		});
	}

	/**
	 * Every ISSUED certificate in the account, each annotated with how (if at all)
	 * it covers the domain — backs the wizard's "show all certificates" fallback.
	 * Annotation uses the (possibly truncated) summary SANs; it is an advisory hint
	 * only, so no per-cert DescribeCertificate is issued here.
	 */
	async listIssuedCertificatesForDomain(domain: string, profile: PublishingProfile): Promise<CertificateMatch[]> {
		const summaries = await this.listIssuedCertificates(profile);
		return summaries.map(s => ({
			arn: s.arn,
			domainName: s.domainName,
			sans: s.sans,
			matchType: certCoversDomain([s.domainName, ...s.sans].filter(Boolean), domain) || undefined,
			notAfter: s.notAfter,
			inUse: s.inUse,
		}));
	}

	/**
	 * Validate a user-supplied certificate ARN for reuse: it must exist, be
	 * ISSUED, and cover the requested domain. Throws a descriptive Error otherwise.
	 */
	async describeCertificateForReuse(arn: string, domain: string, profile: PublishingProfile): Promise<CertificateMatch> {
		const client = this.getAcmClient(profile);
		const response = await client.send(new DescribeCertificateCommand({ CertificateArn: arn }));
		const cert = response.Certificate;
		if (!cert) throw new Error(`Certificate ${arn} not found.`);
		if (cert.Status !== 'ISSUED') {
			throw new Error(`Certificate is ${cert.Status || 'in an unknown state'}, not ISSUED. Only validated certificates can be reused.`);
		}

		const domainName = cert.DomainName || '';
		const sans = cert.SubjectAlternativeNames || [];
		const matchType = certCoversDomain([domainName, ...sans].filter(Boolean), domain);
		if (!matchType) {
			throw new Error(`This certificate (${domainName}) does not cover "${domain}".`);
		}

		return {
			arn,
			domainName,
			sans,
			matchType,
			notAfter: cert.NotAfter ? cert.NotAfter.getTime() : undefined,
			// DescribeCertificate reports usage as InUseBy (list of resource ARNs),
			// unlike the list summary's boolean InUse.
			inUse: (cert.InUseBy?.length || 0) > 0,
		};
	}

	/** DescribeCertificate helper returning just the primary name + full SAN list. */
	private async describeCertificateFullNames(arn: string, profile: PublishingProfile): Promise<{ domainName: string; sans: string[] }> {
		const client = this.getAcmClient(profile);
		const response = await client.send(new DescribeCertificateCommand({ CertificateArn: arn }));
		return {
			domainName: response.Certificate?.DomainName || '',
			sans: response.Certificate?.SubjectAlternativeNames || [],
		};
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

	getStackName(variantName: string, type: 'cert' | 'full' | 'cognito' | 'password' | 'comment'): string {
		const suffix = variantName || 'default';
		switch (type) {
			case 'cert': return `cpn-cert-${suffix}`;
			case 'cognito': return `cpn-cognito-${suffix}`;
			case 'password': return `cpn-password-${suffix}`;
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
