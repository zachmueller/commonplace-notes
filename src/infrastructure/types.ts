export type DeploymentStatus =
	| 'none'
	| 'cert-deploying'
	| 'cert-deployed'
	| 'waiting-dns'
	| 'deploying'
	| 'deployed'
	| 'failed'
	| 'destroying';

export type OriginAccessMethod = 'oac' | 'oai';

export interface InfrastructureState {
	certStackName?: string;
	fullStackName?: string;
	status: DeploymentStatus;
	customDomain?: string;
	useRoute53: boolean;
	certificateArn?: string;
	lastDeployTimestamp?: number;
	region?: string;
	variantName?: string;
	originAccessMethod: OriginAccessMethod;
	imported?: boolean;
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
