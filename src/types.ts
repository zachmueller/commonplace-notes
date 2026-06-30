import { TFile } from 'obsidian';
import { InfrastructureState, ReadGateMode } from './infrastructure/types';

export interface CommonplaceNotesSettings {
    publishingProfiles: PublishingProfile[];
	debugMode?: boolean;
	uidLength?: number;
	urlScheme?: 'current' | 'original';
	urlStackWindowSeconds?: number;
	/** Vault folder for CPN extension files. Parser stages live in `<dir>/parsers/`. Default `cpn`. */
	cpnDirectory?: string;
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
	/** Replace wikilink note-paths with UIDs in the published raw Markdown (e.g. `[[Note]]` → `[[UID|Note]]`) to scrub titles. Default true. */
	obscureRawWikilinks?: boolean;
    publishMechanism: 'AWS' | 'Local';
    awsSettings?: AWSProfileSettings;
    localSettings?: LocalProfileSettings;
	infrastructureState?: InfrastructureState;
	indicator: PublishingIndicator;
	siteCustomization?: SiteCustomization;
	/** Persisted read-gate intent (mode + low-sensitivity password hash for redeploys). */
	readGate?: ReadGateProfile;
	/** Author intent for built-in Cognito + Google auth (persisted; secret is never stored). */
	cognitoAuth?: CognitoAuthProfile;
	/** Self-hosted commenting toggle for this (public) site. */
	commenting?: CommentingProfile;
}

/**
 * Persisted read-gate intent, re-shown when the wizard reopens. The password
 * hash (sha256, never the plaintext) is stored so an update-stack redeploy can
 * run without re-entry; documented as low-sensitivity (a shared read password).
 */
export interface ReadGateProfile {
	mode: ReadGateMode;
	passwordHash?: string;
}

/** Persisted author intent for self-hosted commenting. Requires cognitoAuth.commentIdentity. */
export interface CommentingProfile {
	enabled: boolean;
}

/**
 * Persisted author intent for built-in Cognito + Google auth on a public site.
 * Distinct from the deployment bookkeeping in InfrastructureState.cognitoAuth —
 * this is what the author configured, re-shown when the wizard reopens. The
 * Google client secret is deliberately absent: it is captured transiently in
 * the wizard and passed as a NoEcho CloudFormation parameter, never stored.
 *
 * Whole-site read gating is no longer here — it is the `cognito` value of
 * PublishingProfile.readGate.mode (an independent axis from comment identity).
 */
export interface CognitoAuthProfile {
	enabled: boolean;
	/** Provision identities for the comment write path. */
	commentIdentity: boolean;
	googleClientId?: string;
	authDomainPrefix?: string;
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

export interface HeaderLink {
	label: string;
	url: string;
}

export interface ThemeColors {
	bgPrimary?: string;
	bgSecondary?: string;
	textPrimary?: string;
	linkColor?: string;
	borderColor?: string;
}

export interface ThemeOverrides {
	light?: ThemeColors;
	dark?: ThemeColors;
}

export interface SiteCustomization {
	siteTitle: string;
	headerLinks: HeaderLink[];
	panelWidth: number;
	fontFamily: string;
	themeOverrides: ThemeOverrides;
}