#!/usr/bin/env npx tsx
/**
 * Deploy-hook subsystem test.
 *
 * Exercises the REAL deploy-hook building blocks — the parse/validate path
 * (parseDeployHookFile), the sucrase compile path (compileDeployHook), the
 * example scaffold, and the same discover→compile→run logic DeployHookManager
 * uses — WITHOUT a running Obsidian instance (which the manager needs for its
 * vault + AwsSdkManager). Instead it replays that logic against `.md` strings,
 * so the parser, compiler, and scaffold sources are genuinely under test.
 *
 * Guards:
 *   1. Valid pre hook compiles + runs; receives context.outputs === null.
 *   2. Valid post hook compiles + runs; receives a non-null StackOutputs and a
 *      captured side effect fires.
 *   3. Invalid cpn-type / missing cpn-hook-name / no code fence → DeployHookError.
 *   4. Compile error (bad TS) → recorded + dropped; other hooks still run.
 *   5. A hook that THROWS at runtime is isolated — the runner continues
 *      (succeed-with-warning), and later hooks still run.
 *   6. A pre and a post hook sharing one cpn-hook-name both survive
 *      (phase-scoped de-dupe key).
 *   7. The bundled example scaffold parses + compiles cleanly.
 *
 * Run: npx tsx e2e/scripts/test-deploy-hooks.ts
 */

// tsx's experimental ESM loader transpiles each file independently and can fail
// to detect named exports across barrel files. Use namespace imports for local
// modules and read members off the namespace object (see test-parser-pipeline.ts).
import * as hookFileModule from '../../src/infrastructure/hooks/hookFile';
import * as compilerModule from '../../src/infrastructure/hooks/compiler';
import * as scaffoldsModule from '../../src/infrastructure/hooks/scaffolds/index';
import type {
	CompiledDeployHookFn,
	DeployHookAws,
	DeployHookContext,
	DeployHookDefinition,
	DeployHookError,
	DeployHookPhase,
	DeployHookUtils,
} from '../../src/infrastructure/hooks/types';
import type { StackOutputs } from '../../src/infrastructure/types';

// tsx wraps CJS-transpiled module exports under `.default`; unwrap first.
const unwrap = (m: any) => m?.default ?? m;
const parseDeployHookFile = unwrap(hookFileModule).parseDeployHookFile;
const isDeployHookError = unwrap(hookFileModule).isDeployHookError;
const compileDeployHook = unwrap(compilerModule).compileDeployHook;
const BUILTIN_DEPLOY_HOOK_SCAFFOLDS = unwrap(scaffoldsModule).BUILTIN_DEPLOY_HOOK_SCAFFOLDS;

// ---------------------------------------------------------------------------
// Mock injected context — the compiled hook only needs the object shape.
// ---------------------------------------------------------------------------

const FAKE_OUTPUTS: StackOutputs = {
	bucketName: 'bucket',
	distributionDomainName: 'd123.cloudfront.net',
	distributionId: 'DIST123',
	siteUrl: 'https://example.com',
};

const utils: DeployHookUtils = { logger: console as any };

// A mock `aws` handle — a bag of no-op factories; hooks that call them get a
// harmless stub. Enough to satisfy the injected shape for these tests.
const aws: DeployHookAws = {
	cloudFront: () => ({}) as any,
	s3: () => ({}) as any,
	s3ForRegion: () => ({}) as any,
	sts: () => ({}) as any,
	dynamoDB: () => ({}) as any,
	lambda: () => ({}) as any,
	iam: () => ({}) as any,
	bedrockAgent: () => ({}) as any,
	credentials: (async () => ({ accessKeyId: 'x', secretAccessKey: 'y' })) as any,
	sdk: { cloudfront: {} as any, s3: {} as any, sts: {} as any, lambda: {} as any, iam: {} as any },
};

// ---------------------------------------------------------------------------
// Replay of the manager's discover→compile→run against raw `.md` strings.
// ---------------------------------------------------------------------------

/** Parse many `.md` strings, mimicking DeployHookManager's phase-scoped de-dupe. */
function discover(files: { path: string; content: string }[]): {
	definitions: DeployHookDefinition[];
	errors: DeployHookError[];
} {
	const byKey = new Map<string, DeployHookDefinition>();
	const errors: DeployHookError[] = [];
	for (const f of files) {
		// Manual frontmatter extraction is trivial for our fixtures — just parse
		// through parseDeployHookFile with a hand-built frontmatter object.
		const frontmatter = extractFrontmatter(f.content);
		const result = parseDeployHookFile(f.content, frontmatter, f.path, 'profile');
		if (isDeployHookError(result)) {
			errors.push(result);
		} else {
			byKey.set(`${result.phase}::${result.name}`, result);
		}
	}
	return { definitions: Array.from(byKey.values()), errors };
}

/** Minimal YAML-ish frontmatter parse for the fixtures (key: value lines). */
function extractFrontmatter(content: string): Record<string, unknown> {
	const fm: Record<string, unknown> = {};
	const m = /^---\n([\s\S]*?)\n---/.exec(content);
	if (!m) return fm;
	for (const line of m[1].split('\n')) {
		const idx = line.indexOf(':');
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		let val = line.slice(idx + 1).trim();
		if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
		fm[key] = val;
	}
	return fm;
}

/** Compile + run the matching-phase hooks, isolating per-hook throws. */
async function run(
	files: { path: string; content: string }[],
	phase: DeployHookPhase,
	outputs: StackOutputs | null,
): Promise<{ ran: string[]; loadErrors: DeployHookError[]; runtimeErrors: string[] }> {
	const { definitions, errors } = discover(files);
	const loadErrors = [...errors];
	const compiled: DeployHookDefinition[] = [];
	for (const def of definitions) {
		const result = compileDeployHook(def.rawCode);
		if ('error' in result) {
			loadErrors.push({ filePath: def.filePath, message: result.error });
			continue;
		}
		def.compiledFn = result.fn as CompiledDeployHookFn;
		compiled.push(def);
	}
	compiled.sort((a, b) => a.filename.localeCompare(b.filename));

	const ran: string[] = [];
	const runtimeErrors: string[] = [];
	const context: DeployHookContext =
		phase === 'pre'
			? { phase: 'pre', outputs, awsProfile: 'p', region: 'us-east-1' }
			: { phase: 'post', outputs: outputs as StackOutputs, awsProfile: 'p', region: 'us-east-1' };

	for (const hook of compiled.filter((h) => h.phase === phase)) {
		if (!hook.compiledFn) continue;
		try {
			await hook.compiledFn(aws, context, utils);
			ran.push(hook.name);
		} catch (e) {
			runtimeErrors.push(`${hook.name}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	return { ran, loadErrors, runtimeErrors };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function hookMd(opts: { type: string; name?: string; body: string }): string {
	const nameLine = opts.name === undefined ? '' : `cpn-hook-name: ${opts.name}\n`;
	return `---\ncpn-type: ${opts.type}\n${nameLine}---\n\n\`\`\`ts\n${opts.body}\n\`\`\`\n`;
}

// A side-effect sink the hook bodies push into (they can't close over locals, so
// they write onto globalThis, which the runner reads).
(globalThis as any).__hookLog = [] as string[];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

let failures = 0;
function check(name: string, errs: string[]) {
	if (errs.length === 0) {
		console.log(`PASS  ${name}`);
	} else {
		failures++;
		console.log(`FAIL  ${name}`);
		for (const e of errs) console.log(`        - ${e}`);
	}
}

async function main() {
	// 1. Valid pre hook — compiles + runs; sees outputs === null.
	{
		(globalThis as any).__hookLog = [];
		const files = [{
			path: 'p/hooks/pre.md',
			content: hookMd({
				type: 'pre-deploy-hook',
				name: 'my-pre',
				body: `(globalThis).__hookLog.push('pre:' + (context.outputs === null ? 'null' : 'set'));`,
			}),
		}];
		const { ran, loadErrors, runtimeErrors } = await run(files, 'pre', null);
		const errs: string[] = [];
		if (loadErrors.length) errs.push(`unexpected load errors: ${JSON.stringify(loadErrors)}`);
		if (runtimeErrors.length) errs.push(`unexpected runtime errors: ${JSON.stringify(runtimeErrors)}`);
		if (!ran.includes('my-pre')) errs.push('pre hook did not run');
		const log = (globalThis as any).__hookLog as string[];
		if (!log.includes('pre:null')) errs.push(`pre hook saw non-null outputs: ${JSON.stringify(log)}`);
		check('valid pre hook runs with null outputs', errs);
	}

	// 2. Valid post hook — compiles + runs; sees non-null outputs; side effect fires.
	{
		(globalThis as any).__hookLog = [];
		const files = [{
			path: 'p/hooks/post.md',
			content: hookMd({
				type: 'post-deploy-hook',
				name: 'my-post',
				body: `(globalThis).__hookLog.push('post:' + context.outputs.distributionId);`,
			}),
		}];
		const { ran, loadErrors, runtimeErrors } = await run(files, 'post', FAKE_OUTPUTS);
		const errs: string[] = [];
		if (loadErrors.length) errs.push(`unexpected load errors: ${JSON.stringify(loadErrors)}`);
		if (runtimeErrors.length) errs.push(`unexpected runtime errors: ${JSON.stringify(runtimeErrors)}`);
		if (!ran.includes('my-post')) errs.push('post hook did not run');
		const log = (globalThis as any).__hookLog as string[];
		if (!log.includes('post:DIST123')) errs.push(`post hook side effect missing: ${JSON.stringify(log)}`);
		check('valid post hook runs with resolved outputs', errs);
	}

	// 3. Validation errors → DeployHookError, hook not discovered.
	{
		const cases: { label: string; content: string }[] = [
			{ label: 'invalid cpn-type', content: hookMd({ type: 'parser', name: 'x', body: 'return;' }) },
			{ label: 'missing cpn-hook-name', content: hookMd({ type: 'post-deploy-hook', body: 'return;' }) },
			{ label: 'no code fence', content: `---\ncpn-type: post-deploy-hook\ncpn-hook-name: x\n---\n\nno fence here\n` },
		];
		for (const c of cases) {
			const { definitions, errors } = discover([{ path: `p/hooks/${c.label}.md`, content: c.content }]);
			const errs: string[] = [];
			if (definitions.length !== 0) errs.push('should not have produced a definition');
			if (errors.length !== 1) errs.push(`expected exactly 1 error, got ${errors.length}`);
			check(`validation error · ${c.label}`, errs);
		}
	}

	// 4. Compile error → dropped + recorded; a sibling valid hook still runs.
	{
		(globalThis as any).__hookLog = [];
		const files = [
			{ path: 'p/hooks/a-broken.md', content: hookMd({ type: 'post-deploy-hook', name: 'broken', body: 'this is not valid ((( typescript' }) },
			{ path: 'p/hooks/b-ok.md', content: hookMd({ type: 'post-deploy-hook', name: 'ok', body: `(globalThis).__hookLog.push('ok ran');` }) },
		];
		const { ran, loadErrors } = await run(files, 'post', FAKE_OUTPUTS);
		const errs: string[] = [];
		if (loadErrors.length !== 1) errs.push(`expected exactly 1 compile error, got ${loadErrors.length}`);
		if (ran.includes('broken')) errs.push('broken hook should not have run');
		if (!ran.includes('ok')) errs.push('valid sibling hook should still run');
		check('compile error dropped; sibling still runs', errs);
	}

	// 5. Runtime throw is isolated — later hooks still run (succeed-with-warning).
	{
		(globalThis as any).__hookLog = [];
		const files = [
			{ path: 'p/hooks/a-throws.md', content: hookMd({ type: 'post-deploy-hook', name: 'throws', body: `throw new Error('boom');` }) },
			{ path: 'p/hooks/b-after.md', content: hookMd({ type: 'post-deploy-hook', name: 'after', body: `(globalThis).__hookLog.push('after ran');` }) },
		];
		const { ran, runtimeErrors } = await run(files, 'post', FAKE_OUTPUTS);
		const errs: string[] = [];
		if (runtimeErrors.length !== 1) errs.push(`expected exactly 1 runtime error, got ${runtimeErrors.length}`);
		if (ran.includes('throws')) errs.push('throwing hook should not count as ran');
		if (!ran.includes('after')) errs.push('hook after a throw should still run');
		check('runtime throw isolated; later hooks run', errs);
	}

	// 6. Pre + post sharing one cpn-hook-name both survive.
	{
		const files = [
			{ path: 'p/hooks/shared-pre.md', content: hookMd({ type: 'pre-deploy-hook', name: 'shared', body: 'return;' }) },
			{ path: 'p/hooks/shared-post.md', content: hookMd({ type: 'post-deploy-hook', name: 'shared', body: 'return;' }) },
		];
		const { definitions } = discover(files);
		const errs: string[] = [];
		if (definitions.length !== 2) errs.push(`expected 2 definitions, got ${definitions.length}`);
		const phases = definitions.map((d) => d.phase).sort();
		if (phases.join(',') !== 'post,pre') errs.push(`expected both phases, got ${phases.join(',')}`);
		check('pre + post sharing a name both survive', errs);
	}

	// 7. The bundled example scaffold parses + compiles cleanly.
	{
		const errs: string[] = [];
		for (const [name, s] of BUILTIN_DEPLOY_HOOK_SCAFFOLDS as Map<string, any>) {
			const fm = extractFrontmatter(s.scaffoldContent);
			const parsed = parseDeployHookFile(s.scaffoldContent, fm, `(example: ${name})`, 'profile');
			if (isDeployHookError(parsed)) {
				errs.push(`${name}: parse failed — ${parsed.message}`);
				continue;
			}
			const compiled = compileDeployHook(parsed.rawCode);
			if ('error' in compiled) errs.push(`${name}: compile failed — ${compiled.error}`);
		}
		check('example scaffold parses + compiles', errs);
	}

	console.log('');
	if (failures > 0) {
		console.log(`${failures} check(s) failed.`);
		process.exit(1);
	}
	console.log('All deploy-hook checks passed.');
	process.exit(0);
}

void main();
