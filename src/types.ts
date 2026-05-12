import { TFile } from 'obsidian';
import { InfrastructureState } from './infrastructure/types';

export interface CommonplaceNotesSettings {
    publishingProfiles: PublishingProfile[];
	debugMode?: boolean;
	uidLength?: number;
	urlScheme?: 'current' | 'original';
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
    publishMechanism: 'AWS' | 'Local';
    awsSettings?: AWSProfileSettings;
    localSettings?: LocalProfileSettings;
	infrastructureState?: InfrastructureState;
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
	credentialMode: 'sdk' | 'custom-command';
    credentialRefreshCommands: string;
	/** @deprecated No longer used — SDK runs natively. Will be removed in a future version. */
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