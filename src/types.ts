import { TFile } from 'obsidian';
import { InfrastructureState, ReadGateMode } from './infrastructure/types';

/** Comments panel view mode: the site-wide recency feed vs. the active note's thread. */
export type CommentsPanelMode = 'recent' | 'active-note';

export interface CommonplaceNotesSettings {
    publishingProfiles: PublishingProfile[];
	debugMode?: boolean;
	uidLength?: number;
	urlScheme?: 'current' | 'original';
	urlStackWindowSeconds?: number;
	/** Vault folder for CPN extension files. Parser stages live in `<dir>/parsers/`. Default `cpn`. */
	cpnDirectory?: string;
	/** Comments panel view mode; persisted across restarts. Default 'recent'. */
	commentsPanelMode?: CommentsPanelMode;
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
	/** Comments pulled from the recency GSI per Recent Comments panel refresh. Default 25. */
	commentsFeedLimit?: number;
	/** Epoch ms of the last successful Recent Comments panel refresh (8h-staleness check). */
	commentsLastRefreshed?: number;
	/**
	 * Lambda@Edge resources orphaned by a force-clean (retained so a stuck stack
	 * could reach DELETE_COMPLETE). They can't be deleted until CloudFront finishes
	 * removing their edge replicas (hours), so they are parked here for a deferred,
	 * retry-until-success cleanup. Lives on the profile — not infrastructureState —
	 * because a successful teardown resets infrastructureState, and this must outlive
	 * that reset. See CommonplaceNotesPlugin.cleanupOrphanedEdgeResources.
	 */
	pendingEdgeCleanup?: OrphanedEdgeResource[];
}

/**
 * A Lambda@Edge function (and its execution role) left behind by force-clean,
 * awaiting deletion once CloudFront removes its replicas. `functionName` /
 * `roleName` are cleared as each is successfully deleted; the entry is dropped
 * once both are gone.
 */
export interface OrphanedEdgeResource {
	/** Stack the resource was orphaned from (for display/traceability). */
	stackName: string;
	/** Region the resource lives in (Lambda@Edge is always us-east-1). */
	region: string;
	/** Physical name of the orphaned Lambda function; cleared once deleted. */
	functionName?: string;
	/** Physical name of the orphaned IAM execution role; cleared once deleted. */
	roleName?: string;
	/** Epoch ms the resource was orphaned (so the UI can show how long ago). */
	orphanedAt: number;
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
	/**
	 * Full path to the `aws` binary (e.g. `/opt/homebrew/bin/aws`). Used as a
	 * fallback to run `aws sso login` when SDK-native renewal can't refresh an
	 * expired SSO session (e.g. a profile without a modern `sso_session` block).
	 */
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

/**
 * A per-note style referenced by the `cpn-style` frontmatter value. Reuses the
 * global theme's light/dark color shape and adds an optional theme-independent
 * font override. Overrides layer on top of the profile-wide theme — a style
 * only declares the variables it wants to change; everything else inherits.
 */
export interface NamedStyle {
	light?: ThemeColors;
	dark?: ThemeColors;
	fontFamily?: string;
}

export interface SiteCustomization {
	siteTitle: string;
	headerLinks: HeaderLink[];
	panelWidth: number;
	fontFamily: string;
	themeOverrides: ThemeOverrides;
	/** Named per-note styles, keyed by the `cpn-style` value. Optional ⇒ no migration. */
	namedStyles?: Record<string, NamedStyle>;
}