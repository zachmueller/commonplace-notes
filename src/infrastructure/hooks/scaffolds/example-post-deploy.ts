/**
 * The example deploy hook a user can materialize into their profile's hooks
 * directory. A documented no-op: it demonstrates the injected `context`, `aws`,
 * and `utils` shapes and includes a commented-out CloudFront reconcile so an
 * account-specific post-deploy hook (e.g. re-asserting distribution config that
 * the plugin's template reconcile would otherwise wipe) has a copy-paste start.
 *
 * Materialize it, rename `cpn-hook-name`, and replace the body. Deploy hooks run
 * for side effects; the return value is ignored. A throwing hook is surfaced
 * loudly but does NOT fail the deploy (succeed-with-warning).
 */

import { scaffold } from './_scaffold-helper';

export const EXAMPLE_POST_DEPLOY = scaffold({
	name: 'example-post-deploy',
	phase: 'post',
	description: 'Documented no-op template — copy, rename, and edit for a real post-deploy hook.',
	doc: `# Example post-deploy hook

This hook runs once, after the full-stack deploy has fully settled (the final
reconciled CloudFront distribution). Use it to re-apply configuration the
plugin's template does not own — the hook is your durable, drift-proof channel.

Injected in scope (no \`import\` needed — the vault sandbox has no module resolver):

- \`context\` — \`{ phase: 'pre' | 'post', outputs, awsProfile, region }\`. On a
  post hook \`context.outputs\` is the resolved \`StackOutputs\`
  (\`distributionId\`, \`bucketName\`, \`distributionDomainName\`, \`siteUrl\`, …).
  On a pre hook \`context.outputs\` may be \`null\` (greenfield deploy).
- \`aws\` — curated clients (\`aws.cloudFront()\`, \`aws.s3()\`, …), the raw
  \`aws.credentials\` provider, and \`aws.sdk\` (the \`@aws-sdk/client-*\`
  namespaces, so you can build Command objects you can't \`import\`).
- \`utils\` — \`{ logger }\`.

Idempotency is YOUR responsibility: get → merge-if-absent → update-only-if-changed.`,
	code: `// No-op by default — safe to leave installed. Replace with your logic.
utils.logger.info('[example-post-deploy] ran', {
  phase: context.phase,
  distributionId: context.outputs?.distributionId ?? null,
  region: context.region,
});

// A pre hook may see no outputs yet — guard before using them.
if (context.phase === 'pre' && !context.outputs) return;

// --- Example: idempotently re-assert CloudFront distribution config ---
// const cf = aws.cloudFront();
// const { GetDistributionConfigCommand, UpdateDistributionCommand } = aws.sdk.cloudfront;
// const distId = context.outputs.distributionId;
//
// const current = await cf.send(new GetDistributionConfigCommand({ Id: distId }));
// const etag = current.ETag;
// const config = current.DistributionConfig;
//
// let changed = false;
// // ...merge your account-specific config into \`config\` only if absent,
// //    setting \`changed = true\` when you mutate it...
//
// if (changed) {
//   await cf.send(new UpdateDistributionCommand({ Id: distId, IfMatch: etag, DistributionConfig: config }));
//   utils.logger.info('[example-post-deploy] distribution updated', { distId });
// }`,
});
