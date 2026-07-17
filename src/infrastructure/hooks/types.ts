/**
 * Type definitions for the user-extensible deploy-hook subsystem.
 *
 * Users author deploy hooks as `.md` files under
 * `{cpnDirectory}/profiles/{profileId}/hooks/`. Each hook's code fence runs
 * around the full-stack deploy with a CPN-supplied `aws` handle, a runtime
 * `context`, and a `utils` bag in scope (no `import` statements — vault `.md`
 * never passes through esbuild, so it has no module resolver). This mirrors the
 * parser subsystem's extension model; see `src/utils/parser/types.ts`.
 *
 * Because a hook cannot `import` an SDK client constructor OR a Command class,
 * the `aws` handle injects both the curated per-service clients AND the raw
 * `@aws-sdk/client-*` namespaces (`aws.sdk`) — the single approved channel,
 * exactly as `ParserLibs` injects modules. Adding a key is a plugin-code change,
 * by design.
 */

import type { S3Client } from '@aws-sdk/client-s3';
import type { STSClient } from '@aws-sdk/client-sts';
import type { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { LambdaClient } from '@aws-sdk/client-lambda';
import type { IAMClient } from '@aws-sdk/client-iam';
import type { BedrockAgentClient } from '@aws-sdk/client-bedrock-agent';
import type { AwsCredentialIdentityProvider } from '@smithy/types';
import type { StackOutputs } from '../types';

/** Which deploy phase a hook fires in. Derived from `cpn-type`. */
export type DeployHookPhase = 'pre' | 'post';

/** Where a discovered hook came from. `'global'` is reserved for a future tier. */
export type DeployHookSource = 'profile' | 'global';

interface DeployHookContextBase {
	/** Named AWS profile the deploy ran under (`profile.awsSettings.awsProfile`). */
	awsProfile: string;
	/** Effective deploy region (`profile.awsSettings.region`). */
	region: string;
}

/**
 * Pre-deploy context. On a greenfield deploy the full stack does not exist yet,
 * so `outputs` may be `null`. A pre hook that needs outputs must guard on it.
 */
export interface PreDeployHookContext extends DeployHookContextBase {
	phase: 'pre';
	outputs: StackOutputs | null;
}

/**
 * Post-deploy context. Fires once after the whole deploy sequence has reached a
 * terminal success state, so `outputs` is always resolved.
 */
export interface PostDeployHookContext extends DeployHookContextBase {
	phase: 'post';
	outputs: StackOutputs;
}

export type DeployHookContext = PreDeployHookContext | PostDeployHookContext;

/**
 * The injected AWS handle. Curated clients are PRE-BOUND to the deploy's profile
 * (borrowed from the plugin's `AwsSdkManager`, so `invalidateClients()` clears
 * them too). `credentials` + `sdk` are the escape hatch for arbitrary clients:
 * a vault `.md` hook can neither `import` a client constructor nor a Command
 * class, so both are injected here.
 */
export interface DeployHookAws {
	cloudFront(): CloudFrontClient;
	s3(): S3Client;
	s3ForRegion(region: string): S3Client;
	sts(): STSClient;
	dynamoDB(): DynamoDBDocumentClient;
	lambda(region?: string): LambdaClient;
	iam(region?: string): IAMClient;
	bedrockAgent(): BedrockAgentClient;

	/** Raw env→ini→SSO credential provider, for constructing arbitrary clients. */
	credentials: AwsCredentialIdentityProvider;

	/**
	 * SDK command/class namespaces — hooks can't `import`. Adding a key is a
	 * plugin-code change, by design (same philosophy as `ParserLibs`).
	 */
	sdk: {
		cloudfront: typeof import('@aws-sdk/client-cloudfront');
		s3: typeof import('@aws-sdk/client-s3');
		sts: typeof import('@aws-sdk/client-sts');
		lambda: typeof import('@aws-sdk/client-lambda');
		iam: typeof import('@aws-sdk/client-iam');
	};
}

/** Small read-only helper bag injected as the `utils` argument. */
export interface DeployHookUtils {
	/** Scoped logger — `utils.logger.info(...)`, `.error(...)`, etc. */
	logger: typeof import('../../utils/logging').Logger;
}

/**
 * A hook's compiled code fence. Runs for side effects; the return value is
 * ignored (like a routing `code` action). Always async — `new AsyncFunction`
 * returns a Promise even when the body has no `await`, so callers must await.
 */
export type CompiledDeployHookFn = (
	aws: DeployHookAws,
	context: DeployHookContext,
	utils: DeployHookUtils,
) => Promise<unknown>;

/** A discovered hook, post-parse and (maybe) post-compile. */
export interface DeployHookDefinition {
	/** `cpn-hook-name` — unique key within a phase. */
	name: string;
	/** Derived from `cpn-type` (`pre-deploy-hook`/`post-deploy-hook`). */
	phase: DeployHookPhase;
	/** `cpn-description`, if any. */
	description?: string;
	/** Vault-relative file path, or a synthetic `(example scaffold: name)` tag. */
	filePath: string;
	/** Filename component — tiebreaker for ordering (no order field in v1). */
	filename: string;
	source: DeployHookSource;
	/** Raw TS/JS from the code fence. */
	rawCode: string;
	/** Populated by the compile step; null until then. */
	compiledFn: CompiledDeployHookFn | null;
}

/** A non-fatal problem encountered while loading a hook. */
export interface DeployHookError {
	filePath: string;
	message: string;
}

/**
 * An example hook's metadata + full scaffold `.md` content. Export-only: unlike
 * the parser scaffolds, this is NEVER parsed into a running in-memory fallback —
 * it exists solely to materialize a starter note the user then edits.
 */
export interface BuiltinDeployHookScaffold {
	name: string;
	phase: DeployHookPhase;
	description: string;
	/** Complete `.md` file content (frontmatter + one TS code fence). */
	scaffoldContent: string;
}
