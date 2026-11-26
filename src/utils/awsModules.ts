/**
 * Lazy AWS SDK module loaders: the only place in src/ that imports AWS SDK
 * packages as values (enforced by `no-restricted-imports` in eslint.config.mjs).
 *
 * Evaluating the SDK costs ~40–55 ms at every Obsidian start if it is imported
 * statically. Dynamic `import()` defers that to the first AWS action of the
 * session. esbuild still bundles everything into main.js, but in lazy wrappers
 * that only run on first use. Elsewhere, use `import type` for SDK types and
 * get values from these loaders:
 *
 *     const { PutObjectCommand } = await awsSdk.s3();
 *
 * Each loader memoizes its module. `.loaded()` returns it synchronously once it
 * has loaded, for code that has to stay synchronous after an explicit preload
 * (the deploy-hook `aws` handle); `.peek()` returns it or undefined without
 * loading (e.g. `instanceof` checks on errors). `npm run test:aws-lazy` checks that nothing
 * evaluates an AWS module at load.
 */

export interface LazyModule<T> {
	/** Load (once) and return the module. */
	(): Promise<T>;
	/** The module if it has already loaded; throws otherwise. */
	loaded(): T;
	/** The module if it has already loaded, else undefined (never loads it). */
	peek(): T | undefined;
}

function lazyModule<T>(name: string, load: () => Promise<T>): LazyModule<T> {
	let module: T | undefined;
	let pending: Promise<T> | undefined;
	const get = (): Promise<T> => {
		if (module) return Promise.resolve(module);
		pending ??= load().then(
			(m) => (module = m),
			(err: unknown) => {
				// Let a later call retry rather than caching the failure.
				pending = undefined;
				throw err;
			},
		);
		return pending;
	};
	return Object.assign(get, {
		loaded(): T {
			if (!module) throw new Error(`AWS SDK module ${name} is not loaded yet; await it first.`);
			return module;
		},
		peek(): T | undefined {
			return module;
		},
	});
}

export const awsSdk = {
	s3: lazyModule('@aws-sdk/client-s3', () => import('@aws-sdk/client-s3')),
	sts: lazyModule('@aws-sdk/client-sts', () => import('@aws-sdk/client-sts')),
	cloudFront: lazyModule('@aws-sdk/client-cloudfront', () => import('@aws-sdk/client-cloudfront')),
	dynamoDB: lazyModule('@aws-sdk/client-dynamodb', () => import('@aws-sdk/client-dynamodb')),
	dynamoDBDocument: lazyModule('@aws-sdk/lib-dynamodb', () => import('@aws-sdk/lib-dynamodb')),
	lambda: lazyModule('@aws-sdk/client-lambda', () => import('@aws-sdk/client-lambda')),
	iam: lazyModule('@aws-sdk/client-iam', () => import('@aws-sdk/client-iam')),
	bedrockAgent: lazyModule('@aws-sdk/client-bedrock-agent', () => import('@aws-sdk/client-bedrock-agent')),
	cloudFormation: lazyModule('@aws-sdk/client-cloudformation', () => import('@aws-sdk/client-cloudformation')),
	acm: lazyModule('@aws-sdk/client-acm', () => import('@aws-sdk/client-acm')),
	route53: lazyModule('@aws-sdk/client-route-53', () => import('@aws-sdk/client-route-53')),
	ssoOidc: lazyModule('@aws-sdk/client-sso-oidc', () => import('@aws-sdk/client-sso-oidc')),
	credentialProviders: lazyModule('@aws-sdk/credential-providers', () => import('@aws-sdk/credential-providers')),
	sharedIniFileLoader: lazyModule('@smithy/shared-ini-file-loader', () => import('@smithy/shared-ini-file-loader')),
};
