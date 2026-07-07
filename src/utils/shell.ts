import { exec, ExecOptions } from 'child_process';
import { promisify } from 'util';
import { dirname } from 'path';

export const execAsync = promisify(exec);

/**
 * Common locations for CLI tools (e.g. the `aws` binary) that are missing from
 * the PATH inherited by GUI-launched Electron apps. On macOS a double-clicked
 * app does not source the user's shell profile, so Homebrew's `/opt/homebrew/bin`
 * and `/usr/local/bin` are absent and bare commands like `aws` fail with
 * "command not found".
 */
const COMMON_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

/**
 * Run a shell command with a PATH augmented to include common CLI-tool
 * locations, plus the directory of an explicitly-configured binary when given.
 * Use this for anything that shells out to `aws` (custom refresh commands, the
 * SSO-login CLI fallback) so it works from a GUI-launched Obsidian.
 *
 * `binaryPath`, when provided, is the full path to a binary the caller intends
 * to run (e.g. the user's configured `aws` path); its directory is prepended so
 * both `<binaryPath>` and a bare `aws` resolve.
 */
export function execWithAwsEnv(command: string, binaryPath?: string, options: ExecOptions = {}) {
	const dirs = [...COMMON_BIN_DIRS];
	if (binaryPath && binaryPath.trim().length > 0) {
		dirs.unshift(dirname(binaryPath));
	}

	const existingPath = process.env.PATH || '';
	const augmentedPath = [...dirs, existingPath].filter(Boolean).join(':');

	return execAsync(command, {
		...options,
		env: { ...process.env, ...options.env, PATH: augmentedPath },
	});
}
