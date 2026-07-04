import {
	CloudFormationClient,
	CreateStackCommand,
	UpdateStackCommand,
	DeleteStackCommand,
	DescribeStacksCommand,
	DescribeStackEventsCommand,
	ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import {
	ListObjectVersionsCommand,
	DeleteObjectsCommand,
	DeleteBucketCommand,
} from '@aws-sdk/client-s3';
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
import { Logger } from '../utils/logging';

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

	/**
	 * Stack statuses a fresh CreateStack cannot overwrite — a leftover from a prior
	 * failed create/rollback or an unfinished delete. CloudFormation rejects
	 * CreateStack against these with AlreadyExistsException, so a redeploy after a
	 * partial teardown must delete them first.
	 */
	private static readonly UNUSABLE_LEFTOVER_STATUSES = new Set([
		'ROLLBACK_COMPLETE',
		'ROLLBACK_FAILED',
		'CREATE_FAILED',
		'DELETE_FAILED',
		'REVIEW_IN_PROGRESS',
	]);

	/**
	 * Before a CreateStack, clear a same-named leftover stack that would otherwise
	 * collide. Only stacks in an unusable leftover state (see
	 * UNUSABLE_LEFTOVER_STATUSES) are force-deleted; a healthy live stack
	 * (CREATE_COMPLETE/UPDATE_COMPLETE) is left untouched so CreateStack still
	 * surfaces AlreadyExistsException rather than silently clobbering a real
	 * deployment.
	 */
	private async recoverFailedStackBeforeCreate(client: CloudFormationClient, stackName: string): Promise<void> {
		let status: string | undefined;
		try {
			const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
			status = response.Stacks?.[0]?.StackStatus;
		} catch (err: any) {
			if (/does not exist/i.test(String(err?.message || err))) return; // No leftover — normal create.
			throw err;
		}

		if (status === 'DELETE_COMPLETE') return; // Name is free.
		if (status && CloudFormationManager.UNUSABLE_LEFTOVER_STATUSES.has(status)) {
			await this.forceDeleteStackByClient(client, stackName);
		}
	}

	async deployCertificateStack(config: DeploymentConfig): Promise<string> {
		const stackName = this.getStackName(config.variantName, 'cert');
		const client = this.getCloudFormationClient(config, 'us-east-1');
		await this.recoverFailedStackBeforeCreate(client, stackName);

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
		await this.recoverFailedStackBeforeCreate(client, stackName);

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
		await this.recoverFailedStackBeforeCreate(client, stackName);

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
	 * Every full-stack template parameter key. Used to build a targeted update
	 * that changes only a named subset and inherits the rest via UsePreviousValue.
	 */
	private static readonly FULL_STACK_PARAM_KEYS = [
		'VariantName', 'S3Prefix', 'CustomDomain', 'CertificateArn', 'UseRoute53',
		'HostedZoneId', 'HostedZoneName', 'AuthLambdaEdgeArn',
		'CallbackApiDomainName', 'CommentBucketDomainName', 'CommentApiDomainName',
	] as const;

	/**
	 * Build UpdateStack parameters that change only the keys present in
	 * `overrides` and keep every other key at its currently-deployed value
	 * (UsePreviousValue). This is critical for partial updates: the site
	 * distribution's /auth/*, /comments/* and /api/comments origins+behaviors are
	 * pruned when their domain parameters resolve to '', so an update that only
	 * means to change the auth ARN must NOT re-pass those domains as empty (which
	 * `buildFullStackParameters` would, from a partial config) or it silently tears
	 * those routes off a working site. ParameterValue and UsePreviousValue are
	 * mutually exclusive per key.
	 */
	private buildFullStackUpdateParameters(overrides: Partial<Record<string, string>>) {
		return CloudFormationManager.FULL_STACK_PARAM_KEYS.map((key) =>
			key in overrides
				? { ParameterKey: key, ParameterValue: overrides[key] }
				: { ParameterKey: key, UsePreviousValue: true },
		);
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
		await this.recoverFailedStackBeforeCreate(client, stackName);

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
		await this.recoverFailedStackBeforeCreate(client, stackName);
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

	/**
	 * Targeted update that changes ONLY the viewer-request auth Lambda@Edge ARN and
	 * leaves every other full-stack parameter at its deployed value. Use this
	 * instead of updateFullStack() when the caller only knows the ARN (e.g. the
	 * Settings "Update Auth Lambda@Edge" modal): a full parameter rebuild from a
	 * partial config would blank CallbackApiDomainName/CommentBucketDomainName/
	 * CommentApiDomainName and prune the /auth/*, /comments/*, /api/comments routes
	 * off a working site. Pass '' to remove read-gating.
	 */
	async updateFullStackAuthLambda(
		stackName: string,
		originAccessMethod: DeploymentConfig['originAccessMethod'],
		authLambdaEdgeArn: string,
		profile: PublishingProfile,
		region?: string,
	): Promise<string> {
		const client = this.getCloudFormationClientForProfile(profile, region);
		const template = originAccessMethod === 'oac'
			? FULL_STACK_OAC_TEMPLATE
			: FULL_STACK_OAI_TEMPLATE;

		await client.send(new UpdateStackCommand({
			StackName: stackName,
			TemplateBody: template,
			Parameters: this.buildFullStackUpdateParameters({ AuthLambdaEdgeArn: authLambdaEdgeArn }),
			Capabilities: ['CAPABILITY_IAM'],
			Tags: [
				{ Key: 'cpn:managed', Value: 'true' },
				{ Key: 'cpn:profile', Value: profile.id },
			],
		}));

		return stackName;
	}

	/**
	 * Delete a stack. `retainResources` (logical resource IDs) lets CloudFormation
	 * skip resources it can't delete — e.g. a Lambda@Edge function whose replicas
	 * CloudFront removes asynchronously, or a non-empty retained S3 bucket — so a
	 * DELETE_FAILED stack can be forced to DELETE_COMPLETE. RetainResources is only
	 * honored when re-issued against a stack already in DELETE_FAILED.
	 */
	async deleteStack(
		stackName: string,
		profile: PublishingProfile,
		region?: string,
		retainResources?: string[],
	): Promise<void> {
		const client = this.getCloudFormationClientForProfile(profile, region);
		await client.send(new DeleteStackCommand({
			StackName: stackName,
			...(retainResources && retainResources.length ? { RetainResources: retainResources } : {}),
		}));
	}

	async getStackStatus(stackName: string, profile: PublishingProfile, region?: string): Promise<string> {
		const client = this.getCloudFormationClientForProfile(profile, region);
		const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
		const stack = response.Stacks?.[0];
		if (!stack) throw new Error(`Stack ${stackName} not found`);
		return stack.StackStatus!;
	}

	/**
	 * Like getStackStatus but returns null when the stack does not exist (rather
	 * than throwing), so callers can branch on "is there a leftover here?" without
	 * a try/catch. A stack in DELETE_COMPLETE is treated as gone (returns null) —
	 * CloudFormation keeps deleted stacks queryable by name for a while.
	 */
	async getStackStatusSafe(stackName: string, profile: PublishingProfile, region?: string): Promise<string | null> {
		try {
			const status = await this.getStackStatus(stackName, profile, region);
			return status === 'DELETE_COMPLETE' ? null : status;
		} catch (err: any) {
			const message = String(err?.message || err);
			if (/does not exist/i.test(message) || /not found/i.test(message)) return null;
			throw err;
		}
	}

	/**
	 * List a stack's resources (paginated), projecting the fields teardown needs:
	 * logical/physical IDs, type, and current status. Used to find DELETE_FAILED
	 * logical IDs to retain when forcing a stuck stack's deletion.
	 */
	private async listStackResourcesByClient(
		client: CloudFormationClient,
		stackName: string,
	): Promise<Array<{ logicalId: string; physicalId?: string; resourceType?: string; resourceStatus?: string }>> {
		const resources: Array<{ logicalId: string; physicalId?: string; resourceType?: string; resourceStatus?: string }> = [];
		let nextToken: string | undefined;

		do {
			const response = await client.send(new ListStackResourcesCommand({
				StackName: stackName,
				NextToken: nextToken,
			}));
			for (const summary of response.StackResourceSummaries || []) {
				resources.push({
					logicalId: summary.LogicalResourceId!,
					physicalId: summary.PhysicalResourceId,
					resourceType: summary.ResourceType,
					resourceStatus: summary.ResourceStatus,
				});
			}
			nextToken = response.NextToken;
		} while (nextToken);

		return resources;
	}

	/**
	 * Empty a (versioned) S3 bucket: page through every object version AND
	 * delete-marker and batch-delete them (<=1000/request). Versioned buckets are
	 * only truly empty — and thus deletable — once versions and markers are gone,
	 * so ListObjectsV2 alone is insufficient. Tolerates a missing bucket.
	 */
	async emptyBucket(bucketName: string, profile: PublishingProfile): Promise<void> {
		const client = this.plugin.awsSdkManager.getS3Client(profile);
		let keyMarker: string | undefined;
		let versionIdMarker: string | undefined;

		try {
			do {
				const listed = await client.send(new ListObjectVersionsCommand({
					Bucket: bucketName,
					KeyMarker: keyMarker,
					VersionIdMarker: versionIdMarker,
				}));

				const objects = [
					...(listed.Versions || []),
					...(listed.DeleteMarkers || []),
				]
					.filter(o => o.Key)
					.map(o => ({ Key: o.Key!, VersionId: o.VersionId }));

				for (let i = 0; i < objects.length; i += 1000) {
					const batch = objects.slice(i, i + 1000);
					if (batch.length === 0) continue;
					const response = await client.send(new DeleteObjectsCommand({
						Bucket: bucketName,
						Delete: { Objects: batch, Quiet: true },
					}));
					// Surface per-object failures rather than silently advancing the
					// markers and declaring the bucket empty (mirrors awsUpload.ts).
					if (response.Errors && response.Errors.length > 0) {
						for (const e of response.Errors) {
							Logger.error(`Failed to delete ${e.Key}: ${e.Code} - ${e.Message}`);
						}
						throw new Error(`Failed to empty bucket ${bucketName}: ${response.Errors.length} object(s) could not be deleted`);
					}
				}

				keyMarker = listed.NextKeyMarker;
				versionIdMarker = listed.NextVersionIdMarker;
			} while (keyMarker || versionIdMarker);
		} catch (err: any) {
			const code = err?.name || err?.Code;
			if (code === 'NoSuchBucket') return; // Already gone — nothing to empty.
			throw err;
		}
	}

	/**
	 * Empty then delete an S3 bucket. Used to remove the RETAINed, fixed-name
	 * published-content and comment buckets that survive a normal stack delete and
	 * would otherwise collide with a redeploy. Tolerates a missing bucket.
	 */
	async deleteBucket(bucketName: string, profile: PublishingProfile): Promise<void> {
		await this.emptyBucket(bucketName, profile);
		const client = this.plugin.awsSdkManager.getS3Client(profile);
		try {
			await client.send(new DeleteBucketCommand({ Bucket: bucketName }));
		} catch (err: any) {
			const code = err?.name || err?.Code;
			if (code === 'NoSuchBucket') return; // Already gone.
			throw err;
		}
	}

	/**
	 * Delete a stack and wait for it to be fully gone, forcing past a stuck delete.
	 * First attempts a normal delete; if the stack lands in DELETE_FAILED, it lists
	 * the DELETE_FAILED resources and re-issues the delete with those logical IDs in
	 * RetainResources (orphaning e.g. a still-replicating Lambda@Edge fn), then polls
	 * to completion. Returns the final status ('DELETE_COMPLETE' when the stack is
	 * gone, or the terminal status if it still could not be removed).
	 */
	async forceDeleteStack(
		stackName: string,
		profile: PublishingProfile,
		region: string | undefined,
		onEvent?: (event: StackEvent) => void,
	): Promise<string> {
		const client = this.getCloudFormationClientForProfile(profile, region);
		return this.forceDeleteStackByClient(client, stackName, onEvent);
	}

	/** Client-based core of forceDeleteStack, shared with the deploy-path recovery
	 * guard (which holds a config-scoped client). */
	private async forceDeleteStackByClient(
		client: CloudFormationClient,
		stackName: string,
		onEvent?: (event: StackEvent) => void,
	): Promise<string> {
		const pollGone = async (): Promise<string> => {
			try {
				return await this.pollStackUntilCompleteByClient(client, stackName, onEvent);
			} catch (err: any) {
				if (/does not exist/i.test(String(err?.message || err))) return 'DELETE_COMPLETE';
				throw err;
			}
		};

		await client.send(new DeleteStackCommand({ StackName: stackName }));
		let status = await pollGone();
		if (status !== 'DELETE_FAILED') return status;

		// Stuck: retain the resources that failed to delete and try once more.
		const resources = await this.listStackResourcesByClient(client, stackName);
		const retain = resources
			.filter(r => r.resourceStatus === 'DELETE_FAILED')
			.map(r => r.logicalId);

		// Nothing to retain means a second identical delete would just fail the same
		// way (the blocker is stack-level, not a specific resource) — don't burn
		// another poll cycle; report the DELETE_FAILED so the caller can advise a retry.
		if (retain.length === 0) return status;

		await client.send(new DeleteStackCommand({
			StackName: stackName,
			RetainResources: retain,
		}));
		status = await pollGone();
		return status;
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
		return this.pollStackUntilCompleteByClient(client, stackName, onEvent);
	}

	/** Client-based core of pollStackUntilComplete, shared by profile- and
	 * config-scoped callers (the deploy path holds a config-scoped client). */
	private async pollStackUntilCompleteByClient(
		client: CloudFormationClient,
		stackName: string,
		onEvent?: (event: StackEvent) => void,
	): Promise<string> {
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

				onEvent?.({
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
