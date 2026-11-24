/**
 * Node-side helpers for LIVE AWS end-to-end tests (sandbox account only).
 *
 * Everything shells out to the AWS CLI with the profile in
 * CPN_LIVE_AWS_PROFILE, so the tests check the real account state
 * independently of the plugin's own SDK clients.
 */

import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const LIVE_AWS_PROFILE = process.env.CPN_LIVE_AWS_PROFILE;
export const LIVE_REGION = 'us-east-1';

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const sha256File = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** Run `aws …` and parse its JSON output. */
export function aws(args: string[], opts: { json?: boolean; allowFail?: boolean } = {}): any {
	try {
		const out = execFileSync('aws', [...args, ...(opts.json === false ? [] : ['--output', 'json'])], {
			env: { ...process.env, AWS_PROFILE: LIVE_AWS_PROFILE, AWS_REGION: LIVE_REGION, AWS_PAGER: '' },
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
		});
		if (opts.json === false) return out;
		return out.trim() ? JSON.parse(out) : {};
	} catch (err: any) {
		if (opts.allowFail) return null;
		throw new Error(`aws ${args.slice(0, 3).join(' ')} failed: ${err.stderr || err.message}`);
	}
}

export function stackOutputs(stackName: string): Record<string, string> {
	const d = aws(['cloudformation', 'describe-stacks', '--stack-name', stackName]);
	const out: Record<string, string> = {};
	for (const o of d.Stacks[0].Outputs || []) out[o.OutputKey] = o.OutputValue;
	return out;
}

export function stackParams(stackName: string): Record<string, string> {
	const d = aws(['cloudformation', 'describe-stacks', '--stack-name', stackName]);
	const out: Record<string, string> = {};
	for (const p of d.Stacks[0].Parameters || []) out[p.ParameterKey] = p.ParameterValue;
	return out;
}

export function s3Keys(bucket: string, prefix = ''): string[] {
	const keys: string[] = [];
	let token: string | undefined;
	do {
		const d = aws(['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', prefix,
			...(token ? ['--continuation-token', token] : [])], { allowFail: true });
		for (const o of d?.Contents || []) keys.push(o.Key);
		token = d?.IsTruncated ? d.NextContinuationToken : undefined;
	} while (token);
	return keys;
}

export function s3Json(bucket: string, key: string): any {
	const tmp = path.join(os.tmpdir(), `cpn-live-${crypto.randomBytes(4).toString('hex')}.json`);
	aws(['s3api', 'get-object', '--bucket', bucket, '--key', key, tmp]);
	const v = JSON.parse(fs.readFileSync(tmp, 'utf8'));
	fs.unlinkSync(tmp);
	return v;
}

/** HeadObject, or null when the key has no current version. */
export function head(bucket: string, key: string): any {
	return aws(['s3api', 'head-object', '--bucket', bucket, '--key', key], { allowFail: true });
}

export async function waitInvalidations(distId: string): Promise<void> {
	for (let i = 0; i < 120; i++) {
		const list = aws(['cloudfront', 'list-invalidations', '--distribution-id', distId]).InvalidationList?.Items || [];
		if (!list.some((x: any) => x.Status !== 'Completed')) return;
		await sleep(10_000);
	}
	throw new Error(`invalidations on ${distId} still in progress`);
}

// ---------------------------------------------------------------------------
// Cognito users and tokens
// ---------------------------------------------------------------------------

export const LIVE_PASSWORD = 'Cpn-Live-Passw0rd!';

function describeClient(poolId: string, clientId: string): any {
	return aws(['cognito-idp', 'describe-user-pool-client', '--user-pool-id', poolId, '--client-id', clientId]).UserPoolClient;
}

/** Native users + admin auth on the stack's own client, keeping its token validity. */
export function enableNativeSignIn(poolId: string, clientId: string): void {
	const c = describeClient(poolId, clientId);
	const providers = Array.from(new Set([...(c.SupportedIdentityProviders || []), 'COGNITO']));
	const args = ['cognito-idp', 'update-user-pool-client', '--user-pool-id', poolId, '--client-id', clientId,
		'--explicit-auth-flows', 'ALLOW_ADMIN_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH',
		'--supported-identity-providers', ...providers,
		'--allowed-o-auth-flows', ...c.AllowedOAuthFlows, '--allowed-o-auth-scopes', ...c.AllowedOAuthScopes,
		'--allowed-o-auth-flows-user-pool-client', '--callback-urls', ...c.CallbackURLs, '--logout-urls', ...(c.LogoutURLs || c.CallbackURLs)];
	if (c.IdTokenValidity != null) args.push('--id-token-validity', String(c.IdTokenValidity));
	if (c.AccessTokenValidity != null) args.push('--access-token-validity', String(c.AccessTokenValidity));
	if (c.RefreshTokenValidity != null) args.push('--refresh-token-validity', String(c.RefreshTokenValidity));
	if (c.TokenValidityUnits) args.push('--token-validity-units', Object.entries(c.TokenValidityUnits).map(([k, v]) => `${k}=${v}`).join(','));
	aws(args);
}

export function ensureUser(poolId: string, email: string): void {
	aws(['cognito-idp', 'admin-create-user', '--user-pool-id', poolId, '--username', email, '--message-action', 'SUPPRESS',
		'--user-attributes', `Name=email,Value=${email}`, 'Name=email_verified,Value=true'], { allowFail: true });
	aws(['cognito-idp', 'admin-set-user-password', '--user-pool-id', poolId, '--username', email, '--password', LIVE_PASSWORD, '--permanent'], { json: false });
}

/** A real id token (the pre-token trigger adds cognito:groups from the membership file). */
export function idToken(poolId: string, clientId: string, email: string): string {
	const secret = describeClient(poolId, clientId).ClientSecret as string;
	const secretHash = crypto.createHmac('sha256', secret).update(email + clientId).digest('base64');
	const d = aws(['cognito-idp', 'admin-initiate-auth', '--user-pool-id', poolId, '--client-id', clientId,
		'--auth-flow', 'ADMIN_USER_PASSWORD_AUTH', '--auth-parameters', `USERNAME=${email},PASSWORD=${LIVE_PASSWORD},SECRET_HASH=${secretHash}`]);
	return d.AuthenticationResult.IdToken;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export function ffmpeg(args: string[]): void {
	execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}
export const mp3 = (out: string, freq: number, seconds: number, title = 'Cpn') =>
	ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`, '-c:a', 'libmp3lame', '-b:a', '64k',
		'-metadata', `title=${title}`, '-id3v2_version', '3', out]);
export const png = (out: string, color: string) =>
	ffmpeg(['-f', 'lavfi', '-i', `color=c=${color}:s=64x48`, '-frames:v', '1', out]);

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const newUid = () => Array.from(crypto.randomBytes(10), b => CROCKFORD[b % 32]).join('');

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export function emptyVersionedBucket(bucket: string): void {
	aws(['s3', 'rm', `s3://${bucket}`, '--recursive', '--quiet'], { json: false, allowFail: true });
	const uploads = aws(['s3api', 'list-multipart-uploads', '--bucket', bucket], { allowFail: true })?.Uploads || [];
	for (const u of uploads) {
		aws(['s3api', 'abort-multipart-upload', '--bucket', bucket, '--key', u.Key, '--upload-id', u.UploadId], { json: false, allowFail: true });
	}
	for (let round = 0; round < 50; round++) {
		const versions = aws(['s3api', 'list-object-versions', '--bucket', bucket], { allowFail: true });
		const objs = [...(versions?.Versions || []), ...(versions?.DeleteMarkers || [])].map((v: any) => ({ Key: v.Key, VersionId: v.VersionId }));
		if (objs.length === 0) break;
		for (let i = 0; i < objs.length; i += 500) {
			aws(['s3api', 'delete-objects', '--bucket', bucket, '--delete', JSON.stringify({ Objects: objs.slice(i, i + 500), Quiet: true })], { allowFail: true });
		}
	}
}

export function deleteStack(stack?: string): void {
	if (!stack || !aws(['cloudformation', 'describe-stacks', '--stack-name', stack], { allowFail: true })) return;
	console.log(`Deleting ${stack}...`);
	aws(['cloudformation', 'delete-stack', '--stack-name', stack], { json: false });
	aws(['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', stack], { json: false, allowFail: true });
	const after = aws(['cloudformation', 'describe-stacks', '--stack-name', stack], { allowFail: true });
	if (after?.Stacks?.[0]?.StackStatus === 'DELETE_FAILED') {
		const res = aws(['cloudformation', 'list-stack-resources', '--stack-name', stack]);
		const stuck = (res.StackResourceSummaries || []).filter((r: any) => r.ResourceStatus !== 'DELETE_COMPLETE').map((r: any) => r.LogicalResourceId);
		console.log(`  ${stack} DELETE_FAILED; retaining ${stuck.join(', ')}`);
		aws(['cloudformation', 'delete-stack', '--stack-name', stack, '--retain-resources', ...stuck], { json: false });
		aws(['cloudformation', 'wait', 'stack-delete-complete', '--stack-name', stack], { json: false, allowFail: true });
	}
}

/**
 * Delete Lambda functions and IAM roles whose names contain `variant`.
 * Returns the functions that couldn't be deleted yet (Lambda@Edge replicas).
 */
export function deleteVariantFunctionsAndRoles(variant: string): string[] {
	const leftovers: string[] = [];
	for (const f of aws(['lambda', 'list-functions'], { allowFail: true })?.Functions || []) {
		if (!String(f.FunctionName).includes(variant)) continue;
		if (aws(['lambda', 'delete-function', '--function-name', f.FunctionName], { json: false, allowFail: true }) === null) leftovers.push(f.FunctionName);
		else console.log(`Deleted function ${f.FunctionName}`);
	}
	for (const r of aws(['iam', 'list-roles'], { allowFail: true })?.Roles || []) {
		if (!String(r.RoleName).includes(variant)) continue;
		for (const p of aws(['iam', 'list-attached-role-policies', '--role-name', r.RoleName], { allowFail: true })?.AttachedPolicies || []) {
			aws(['iam', 'detach-role-policy', '--role-name', r.RoleName, '--policy-arn', p.PolicyArn], { json: false, allowFail: true });
		}
		for (const n of aws(['iam', 'list-role-policies', '--role-name', r.RoleName], { allowFail: true })?.PolicyNames || []) {
			aws(['iam', 'delete-role-policy', '--role-name', r.RoleName, '--policy-name', n], { json: false, allowFail: true });
		}
		if (aws(['iam', 'delete-role', '--role-name', r.RoleName], { json: false, allowFail: true }) !== null) console.log(`Deleted role ${r.RoleName}`);
	}
	return leftovers;
}
