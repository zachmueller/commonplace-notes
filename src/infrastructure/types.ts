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
	| 'chat-deploying'
	| 'chat-deployed'
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

/** Deployment bookkeeping for the LLM chat stack (Bedrock KB over the corpus). */
export interface ChatState {
	stackName: string;
	enabled: boolean;
	/** Chat Lambda Function URL host (backs the /api/chat CloudFront origin). */
	functionUrlDomainName: string;
	knowledgeBaseId: string;
	dataSourceId: string;
	/** Ingestion trigger: 'auto' fires on publish, 'manual' via button/command. */
	sync: 'auto' | 'manual';
	/** Bedrock model/inference-profile ARN used for generation. */
	modelArn: string;
	/** Shared secret injected as the /api/chat origin header (also baked into the handler). */
	originSecret: string;
}

/** Raw outputs read from a deployed chat stack. */
export interface ChatStackOutputs {
	functionUrlDomainName: string;
	knowledgeBaseId: string;
	dataSourceId: string;
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
	chat?: ChatState;
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
	/** Deploy the LLM chat backend (Bedrock KB over the published corpus). */
	chatEnabled?: boolean;
	/** KB ingestion trigger. Default 'auto' (StartIngestionJob on publish). */
	chatSync?: 'auto' | 'manual';
	/** Bedrock model/inference-profile ARN for generation (default Claude Sonnet 5). */
	chatModelArn?: string;
	/** Vector store backing the KB (default S3 Vectors; OpenSearch is an upgrade path). */
	chatVectorStore?: 's3vectors' | 'opensearch';
	/** Site bucket name, passed to the chat stack so its KB data source can read kb/. */
	siteBucketName?: string;
	/** Chat Lambda Function URL host, threaded into the site distribution's /api/chat origin. */
	chatFunctionUrlDomainName?: string;
	/** Shared secret for the /api/chat origin header (generated at deploy time). */
	chatOriginSecret?: string;
}

export interface StackOutputs {
	bucketName: string;
	distributionDomainName: string;
	distributionId: string;
	siteUrl: string;
	/** Present only on OAI distributions; needed to grant the comment bucket. */
	originAccessIdentityId?: string;
}

/**
 * The role a discovered CloudFormation stack plays in a deployment, matched to
 * an InfrastructureState slot: full→fullStackName, cert→certStackName,
 * cognito→cognitoAuth, password→passwordAuth, comment→comment. `unknown` is a
 * cpn-* (or cpn:managed-tagged) stack whose Outputs match no known role — the
 * import UI leaves it unchecked with a manual role-override dropdown.
 */
export type StackRole = 'full' | 'cert' | 'cognito' | 'password' | 'comment' | 'chat' | 'unknown';

/**
 * A CloudFormation stack found by scanning an account/region during import.
 * Populated from a single DescribeStacks call (no StackName) — carrying the raw
 * Outputs AND Parameters so role detection and state reconstruction need no
 * second round trip. `parameters` supplies values that are never emitted as
 * outputs (the full stack's AuthLambdaEdgeArn/CustomDomain/UseRoute53/HostedZone*,
 * the cognito stack's GoogleClientId/AuthDomainPrefix).
 */
export interface DiscoveredStack {
	stackName: string;
	region: string;
	/** Raw CloudFormation StackStatus. */
	status: string;
	/** True when status is a *_COMPLETE terminal state — only these are importable. */
	healthy: boolean;
	/** True when tagged cpn:managed=true (this plugin deployed it). */
	managed: boolean;
	/** Value of the cpn:profile tag, if present (groups stacks by originating profile). */
	profileTag?: string;
	outputs: Record<string, string>;
	parameters: Record<string, string>;
	/** Auto-detected from output-key signatures, with the cpn- name prefix as fallback. */
	role: StackRole;
	/** Variant suffix parsed from the name and validated via getStackName(); undefined if the name is non-conventional. */
	variantSuffix?: string;
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
