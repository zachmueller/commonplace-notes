import { TFile } from 'obsidian';

export interface CommonplaceNotesSettings {
    publishingProfiles: PublishingProfile[];
	debugMode?: boolean;
}

export interface PublishingProfile {
    name: string;
    id: string;
    lastFullPublishTimestamp: number;
    excludedDirectories: string[];
    baseUrl: string;
	homeNotePath: string;
    isPublic: boolean;
	publishContentIndex: boolean;
    publishMechanism: 'AWS CLI' | 'Local';
    awsSettings?: AWSProfileSettings;
    localSettings?: LocalProfileSettings;
	indicator: PublishingIndicator;
}

export interface AWSProfileSettings {
    awsAccountId: string;
    awsProfile: string;
    region: string;
    bucketName: string;
	s3Prefix?: string;
    cloudFrontInvalidationScheme: 'individual' | 'connected' | 'sinceLast' | 'all' | 'manual';
	cloudFrontDistributionId?: string;
    credentialRefreshCommands: string;
	awsCliPath?: string;
}

export interface LocalProfileSettings {
    // TBD: Add local publishing settings when implemented
    outputPath: string;
}

export type CloudFrontInvalidationScheme = 'individual' | 'connected' | 'sinceLast' | 'all' | 'manual';

export interface NoteConnection {
    file: TFile;
    isBacklink: boolean;
    isOutgoingLink: boolean;
    uid: string;
    slug: string;
    title: string;
}

export interface BulkPublishContextMapping {
	directory: string;
	contexts: string[];
	action: 'add' | 'remove';
}

export interface BulkPublishContextConfig {
	include: BulkPublishContextMapping[];
	exclude: string[];
	previewPath: string;
}

export interface PublishContextChange {
	filePath: string;
	currentContexts: string[];
	proposedContexts: string[];
	action: string;
	includePattern: string;
	excludePattern: string;
}

export type IndicatorStyle = 'color' | 'emoji';

export interface PublishingIndicator {
	style: IndicatorStyle;
	color?: string;
	emoji?: string;
}