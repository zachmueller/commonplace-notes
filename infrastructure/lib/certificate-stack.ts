import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export class CertificateStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		const customDomain = new cdk.CfnParameter(this, 'CustomDomain', {
			type: 'String',
			description: 'The custom domain name for the certificate (e.g., notes.example.com)',
		});

		const certificate = new acm.CfnCertificate(this, 'Certificate', {
			domainName: customDomain.valueAsString,
			validationMethod: 'DNS',
		});

		new cdk.CfnOutput(this, 'CertificateArn', {
			value: certificate.ref,
			description: 'ARN of the ACM certificate',
		});
	}
}
