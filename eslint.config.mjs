import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import obsidianmd from 'eslint-plugin-obsidianmd';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Focused config for the Obsidian community-plugin review gate. It enables the
// `obsidianmd` rules that back the review's Error/Warning findings plus the
// type-checked @typescript-eslint no-explicit-any / no-unsafe-* / floating-promise
// family — now that src/ has been swept clean of `any` — so that shipped-bundle
// debt can't regrow. It does NOT pull in the full `obsidianmd.configs.recommended`,
// which adds security / import rules that would bury the review-relevant findings
// in unrelated noise. Scoped to src/; the e2e/ and infrastructure/ typing sweep
// (still carrying `any`) is tracked as a separate follow-up and stays ignored here.
export default [
	{
		ignores: ['e2e/**', 'infrastructure/**', 'main.js', 'node_modules/**', 'src/publish/siteAssets.ts'],
	},
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			parser: tsParser,
			sourceType: 'module',
			parserOptions: {
				// `obsidianmd/no-unsupported-api` needs type information.
				project: './tsconfig.json',
				tsconfigRootDir: __dirname,
			},
		},
		plugins: {
			obsidianmd,
			'@typescript-eslint': tsPlugin,
		},
		rules: {
			// Error blockers from the review:
			'obsidianmd/no-unsupported-api': 'error',
			'obsidianmd/settings-tab/no-manual-html-headings': 'error',
			'obsidianmd/no-static-styles-assignment': 'error',
			// src/ warning sweep folded into this pass:
			'obsidianmd/prefer-window-timers': 'warn',
			// Review finding: async callbacks passed where a void return is
			// expected. Enabled for src/ (the e2e/ + infrastructure/ trees stay a
			// separate tracked follow-up and remain ignored above).
			'@typescript-eslint/no-misused-promises': 'error',
			// Review finding: the no-explicit-any / no-unsafe-* / floating-promise
			// family. src/ has been swept clean of `any`, so these now hold the
			// shipped bundle to that bar going forward.
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-unsafe-assignment': 'error',
			'@typescript-eslint/no-unsafe-member-access': 'error',
			'@typescript-eslint/no-unsafe-call': 'error',
			'@typescript-eslint/no-unsafe-return': 'error',
			'@typescript-eslint/no-unsafe-argument': 'error',
		},
	},
];
