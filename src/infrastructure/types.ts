export type DeploymentStatus =
	| 'none'
	| 'cert-deploying'
	| 'cert-deployed'
	| 'waiting-dns'
	| 'cognito-deploying'
	| 'cognito-deployed'
	| 'deploying'
	| 'deployed'
	| 'failed'
	| 'destroying';

export type OriginAccessMethod = 'oac' | 'oai';

/**
 * Deployment bookkeeping for the built-in Cognito + Google auth sub-stack.
 *
 * Grouped into a single nested object (rather than flat fields) so the wizard's
 * dual-write — applyOutputsToProfile() builds infrastructureState as a fresh
 * literal with no spread, while updateInfraState() spreads — only has to carry
 * one field across both sites instead of a dozen.
 */
export interface CognitoAuthState {
	stackName: string;
	/** Pool deployed (identities available for comment writes). */
	enabled: boolean;
	/** Whole-site read gating: edge fn attached to the site's default behavior. */
	readGating: boolean;
	/** Pool issues identities for the comment write path. */
	commentIdentity: boolean;
	userPoolId: string;
	userPoolClientId: string;
	hostedUiDomain: string;
	jwksUri: string;
	issuer: string;
	/** Versioned ARN of the viewer-request Lambda@Edge fn (fed to AuthLambdaEdgeArn). */
	edgeFunctionVersionArn: string;
	/** API Gateway host backing the /auth/* callback origin on the site distribution. */
	callbackApiDomain: string;
	googleClientId?: string;
	authDomainPrefix?: string;
}

/** Raw outputs read from a deployed Cognito auth stack. */
export interface CognitoAuthOutputs {
	edgeFunctionVersionArn: string;
	userPoolId: string;
	userPoolClientId: string;
	hostedUiDomain: string;
	jwksUri: string;
	issuer: string;
	callbackApiDomain: string;
}

export interface InfrastructureState {
	certStackName?: string;
	fullStackName?: string;
	status: DeploymentStatus;
	customDomain?: string;
	useRoute53: boolean;
	hostedZoneId?: string;
	hostedZoneName?: string;
	certificateArn?: string;
	lastDeployTimestamp?: number;
	region?: string;
	variantName?: string;
	originAccessMethod: OriginAccessMethod;
	imported?: boolean;
	authLambdaEdgeArn?: string;
	cognitoAuth?: CognitoAuthState;
}

export interface DeploymentConfig {
	profileId: string;
	variantName: string;
	s3Prefix: string;
	customDomain: string;
	certificateArn?: string;
	useRoute53: boolean;
	hostedZoneId: string;
	hostedZoneName: string;
	region: string;
	awsProfile: string;
	originAccessMethod: OriginAccessMethod;
	authLambdaEdgeArn?: string;
	/** Built-in Cognito + Google auth toggles & inputs (transient; not all persisted). */
	cognitoAuthEnabled?: boolean;
	readGatingEnabled?: boolean;
	commentIdentityEnabled?: boolean;
	googleClientId?: string;
	/** Captured transiently in the wizard and passed as a NoEcho param; never persisted. */
	googleClientSecret?: string;
	authDomainPrefix?: string;
	/** OAuth redirect_uri allowed on the app client (phase-1 placeholder vs phase-2 real). */
	callbackUrl?: string;
	/** API Gateway host for the /auth/* callback origin (from the Cognito auth stack). */
	callbackApiDomainName?: string;
	/** Regional domain of the comment S3 bucket for the /comments/* origin (from the comment stack). */
	commentBucketDomainName?: string;
	/** API Gateway host for the /api/comments write origin (from the comment stack). */
	commentApiDomainName?: string;
}

export interface StackOutputs {
	bucketName: string;
	distributionDomainName: string;
	distributionId: string;
	siteUrl: string;
}

export interface DnsValidationRecord {
	name: string;
	value: string;
	type: 'CNAME';
}

export interface StackEvent {
	resourceType: string;
	logicalResourceId: string;
	status: string;
	reason?: string;
	timestamp: Date;
}

export interface HostedZoneInfo {
	id: string;
	name: string;
}
