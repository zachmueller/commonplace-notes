export type DeploymentStatus =
	| 'none'
	| 'cert-deploying'
	| 'cert-deployed'
	| 'waiting-dns'
	| 'cognito-deploying'
	| 'cognito-deployed'
	| 'password-deploying'
	| 'password-deployed'
	| 'deploying'
	| 'deployed'
	| 'comment-deploying'
	| 'comment-deployed'
	| 'failed'
	| 'destroying';

export type OriginAccessMethod = 'oac' | 'oai';

/**
 * How read access to the published site is gated. A single interchangeable axis
 * — whatever the mode, it produces (or omits) the versioned viewer-request
 * Lambda@Edge ARN fed into the full-stack `AuthLambdaEdgeArn` parameter.
 *   none     — fully public reads
 *   cognito  — whole-site login via the Cognito edge fn
 *   password — HTTP Basic Auth via the password edge fn
 *   byo      — bring-your-own viewer-request Lambda ARN
 * Independent of comment identity (the Cognito pool can be provisioned for
 * comment writes regardless of the read-gate mode — e.g. password reads +
 * Cognito comments).
 */
export type ReadGateMode = 'none' | 'cognito' | 'password' | 'byo';

/** Deployment bookkeeping for the built-in password read-gate sub-stack. */
export interface PasswordAuthState {
	stackName: string;
	edgeFunctionVersionArn: string;
	/** sha256 hex of the shared password (low-sensitivity; lets redeploys skip re-entry). */
	passwordHash?: string;
}

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

/** Deployment bookkeeping for the self-hosted comment stack. */
export interface CommentState {
	stackName: string;
	enabled: boolean;
	bucketName: string;
	bucketDomainName: string;
	apiDomain: string;
	tableName: string;
}

/** Raw outputs read from a deployed comment stack. */
export interface CommentStackOutputs {
	bucketName: string;
	bucketDomainName: string;
	apiDomain: string;
	tableName: string;
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
	/** True when certificateArn refers to a pre-existing cert we reused (not a cpn-cert-* stack we own). */
	certificateReused?: boolean;
	lastDeployTimestamp?: number;
	region?: string;
	variantName?: string;
	originAccessMethod: OriginAccessMethod;
	imported?: boolean;
	authLambdaEdgeArn?: string;
	/** Which read-gate is active (drives which sub-stack supplies authLambdaEdgeArn). */
	readGateMode?: ReadGateMode;
	cognitoAuth?: CognitoAuthState;
	passwordAuth?: PasswordAuthState;
	comment?: CommentState;
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
	/** Read-gate mode (transient wizard selection). */
	readGateMode?: ReadGateMode;
	/** Plaintext password (transient; hashed before deploy, never persisted/transmitted). */
	passwordValue?: string;
	/** sha256 hex of the password, passed as the NoEcho PasswordHash param. */
	passwordHash?: string;
	/** Built-in Cognito + Google auth toggles & inputs (transient; not all persisted). */
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
	/** Deploy the self-hosted comment backend (requires commentIdentityEnabled). */
	commentingEnabled?: boolean;
	/** Comment-stack inputs sourced from the Cognito auth outputs. */
	commentJwksUri?: string;
	commentTokenIssuer?: string;
	commentUserPoolClientId?: string;
	/** Site distribution id / OAI id for the comment bucket's cross-stack read grant. */
	siteDistributionId?: string;
	siteOriginAccessIdentityId?: string;
}

export interface StackOutputs {
	bucketName: string;
	distributionDomainName: string;
	distributionId: string;
	siteUrl: string;
	/** Present only on OAI distributions; needed to grant the comment bucket. */
	originAccessIdentityId?: string;
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

/**
 * An existing ISSUED ACM certificate offered for reuse in the wizard, annotated
 * with how it covers the requested custom domain. `matchType` is undefined for
 * certs surfaced by the "show all" fallback that do not cover the domain.
 */
export interface CertificateMatch {
	arn: string;
	/** The certificate's primary DomainName. */
	domainName: string;
	/** Full list of Subject Alternative Names (after any truncation fallback). */
	sans: string[];
	/** How this cert covers the requested domain (undefined = does not cover it). */
	matchType?: 'exact' | 'wildcard';
	/** Expiry as epoch ms (Date objects are avoided so this survives persistence). */
	notAfter?: number;
	/** Whether the certificate is currently associated with any AWS resource. */
	inUse: boolean;
}
