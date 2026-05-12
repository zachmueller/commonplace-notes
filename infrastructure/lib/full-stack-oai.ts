import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as route53 from 'aws-cdk-lib/aws-route53';
import { Construct } from 'constructs';

export class FullStackOai extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		// Parameters
		const variantName = new cdk.CfnParameter(this, 'VariantName', {
			type: 'String',
			default: '',
			description: 'Optional variant name for multi-instance deployments',
		});

		const s3Prefix = new cdk.CfnParameter(this, 'S3Prefix', {
			type: 'String',
			default: '',
			description: 'Optional path prefix within the S3 bucket',
		});

		const customDomain = new cdk.CfnParameter(this, 'CustomDomain', {
			type: 'String',
			default: '',
			description: 'Optional custom domain name (e.g., notes.example.com)',
		});

		const certificateArn = new cdk.CfnParameter(this, 'CertificateArn', {
			type: 'String',
			default: '',
			description: 'ARN of the ACM certificate (required if using custom domain)',
		});

		const useRoute53 = new cdk.CfnParameter(this, 'UseRoute53', {
			type: 'String',
			default: 'false',
			allowedValues: ['true', 'false'],
			description: 'Whether to create Route53 DNS records automatically',
		});

		const hostedZoneId = new cdk.CfnParameter(this, 'HostedZoneId', {
			type: 'String',
			default: '',
			description: 'Route53 Hosted Zone ID (required if UseRoute53=true)',
		});

		const hostedZoneName = new cdk.CfnParameter(this, 'HostedZoneName', {
			type: 'String',
			default: '',
			description: 'Route53 Hosted Zone Name (required if UseRoute53=true)',
		});

		// Conditions
		const hasVariantName = new cdk.CfnCondition(this, 'HasVariantName', {
			expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(variantName.valueAsString, '')),
		});

		const hasS3Prefix = new cdk.CfnCondition(this, 'HasS3Prefix', {
			expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(s3Prefix.valueAsString, '')),
		});

		const hasCustomDomain = new cdk.CfnCondition(this, 'HasCustomDomain', {
			expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(customDomain.valueAsString, '')),
		});

		const hasCertificate = new cdk.CfnCondition(this, 'HasCertificate', {
			expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(certificateArn.valueAsString, '')),
		});

		const shouldUseRoute53 = new cdk.CfnCondition(this, 'ShouldUseRoute53', {
			expression: cdk.Fn.conditionAnd(
				cdk.Fn.conditionEquals(useRoute53.valueAsString, 'true'),
				cdk.Fn.conditionNot(cdk.Fn.conditionEquals(hostedZoneId.valueAsString, '')),
			),
		});

		// S3 Bucket
		const bucketName = cdk.Fn.conditionIf(
			'HasVariantName',
			cdk.Fn.join('', ['published-notes-', cdk.Aws.ACCOUNT_ID, '-cpn-', variantName.valueAsString]),
			cdk.Fn.join('', ['published-notes-', cdk.Aws.ACCOUNT_ID, '-cpn']),
		).toString();

		const bucket = new s3.CfnBucket(this, 'PublishedNotesBucket', {
			bucketName,
			versioningConfiguration: { status: 'Enabled' },
			publicAccessBlockConfiguration: {
				blockPublicAcls: true,
				blockPublicPolicy: true,
				ignorePublicAcls: true,
				restrictPublicBuckets: true,
			},
		});
		bucket.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;
		bucket.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;

		// CloudFront Origin Access Identity
		const oai = new cloudfront.CfnCloudFrontOriginAccessIdentity(this, 'OAI', {
			cloudFrontOriginAccessIdentityConfig: {
				comment: cdk.Fn.sub('OAI for cpn-${AWS::StackName}'),
			},
		});

		// CloudFront Distribution
		const originPath = cdk.Fn.conditionIf('HasS3Prefix', `/${s3Prefix.valueAsString}`, '').toString();

		const distribution = new cloudfront.CfnDistribution(this, 'Distribution', {
			distributionConfig: {
				enabled: true,
				defaultRootObject: 'index.html',
				httpVersion: 'http2',
				priceClass: 'PriceClass_100',
				ipv6Enabled: true,
				aliases: cdk.Fn.conditionIf('HasCustomDomain', [customDomain.valueAsString], cdk.Aws.NO_VALUE) as any,
				viewerCertificate: cdk.Fn.conditionIf(
					'HasCertificate',
					{
						AcmCertificateArn: certificateArn.valueAsString,
						SslSupportMethod: 'sni-only',
						MinimumProtocolVersion: 'TLSv1.2_2021',
					},
					{ CloudFrontDefaultCertificate: true },
				) as any,
				defaultCacheBehavior: {
					targetOriginId: 'S3Origin',
					viewerProtocolPolicy: 'redirect-to-https',
					allowedMethods: ['GET', 'HEAD'],
					cachedMethods: ['GET', 'HEAD'],
					compress: true,
					cachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6', // CachingOptimized
					forwardedValues: undefined,
				},
				origins: [
					{
						id: 'S3Origin',
						domainName: cdk.Fn.getAtt('PublishedNotesBucket', 'RegionalDomainName').toString(),
						originPath,
						s3OriginConfig: {
							originAccessIdentity: cdk.Fn.sub('origin-access-identity/cloudfront/${OAI}'),
						},
					},
				],
			},
		});

		// S3 Bucket Policy (allow CloudFront OAI)
		new s3.CfnBucketPolicy(this, 'BucketPolicy', {
			bucket: bucket.ref,
			policyDocument: {
				Version: '2012-10-17',
				Statement: [
					{
						Effect: 'Allow',
						Principal: {
							AWS: cdk.Fn.sub(
								'arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity ${OAI}',
							),
						},
						Action: 's3:GetObject',
						Resource: `arn:aws:s3:::${bucket.ref}/*`,
					},
				],
			},
		});

		// Conditional Route53 Records
		const aRecord = new route53.CfnRecordSet(this, 'AliasRecordA', {
			hostedZoneId: hostedZoneId.valueAsString,
			name: customDomain.valueAsString,
			type: 'A',
			aliasTarget: {
				dnsName: cdk.Fn.getAtt('Distribution', 'DomainName').toString(),
				hostedZoneId: 'Z2FDTNDATAQYW2',
			},
		});
		(aRecord as cdk.CfnResource).cfnOptions.condition = this.node.tryFindChild('ShouldUseRoute53') as cdk.CfnCondition;

		const aaaaRecord = new route53.CfnRecordSet(this, 'AliasRecordAAAA', {
			hostedZoneId: hostedZoneId.valueAsString,
			name: customDomain.valueAsString,
			type: 'AAAA',
			aliasTarget: {
				dnsName: cdk.Fn.getAtt('Distribution', 'DomainName').toString(),
				hostedZoneId: 'Z2FDTNDATAQYW2',
			},
		});
		(aaaaRecord as cdk.CfnResource).cfnOptions.condition = this.node.tryFindChild('ShouldUseRoute53') as cdk.CfnCondition;

		// Outputs
		new cdk.CfnOutput(this, 'BucketName', {
			value: bucket.ref,
			description: 'Name of the S3 bucket',
		});

		new cdk.CfnOutput(this, 'DistributionDomainName', {
			value: cdk.Fn.getAtt('Distribution', 'DomainName').toString(),
			description: 'CloudFront distribution domain name',
		});

		new cdk.CfnOutput(this, 'DistributionID', {
			value: distribution.ref,
			description: 'CloudFront distribution ID',
		});

		new cdk.CfnOutput(this, 'SiteUrl', {
			value: cdk.Fn.conditionIf(
				'HasCustomDomain',
				customDomain.valueAsString,
				cdk.Fn.getAtt('Distribution', 'DomainName').toString(),
			).toString(),
			description: 'The URL of the published site',
		});
	}
}
