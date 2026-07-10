import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import tsParser from '@typescript-eslint/parser';
import obsidianmd from 'eslint-plugin-obsidianmd';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Focused config for the Obsidian community-plugin review gate. It enables only
// the `obsidianmd` rules that back the review's Error/Warning findings — not the
// full `obsidianmd.configs.recommended`, which pulls in type-checked
// @typescript-eslint / security / import rules that require type-info wiring and
// would bury the review-relevant findings in unrelated noise. Scoped to src/;
// e2e/ and infrastructure/ lint is tracked as a separate follow-up.
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
		},
		rules: {
			// Error blockers from the review:
			'obsidianmd/no-unsupported-api': 'error',
			'obsidianmd/settings-tab/no-manual-html-headings': 'error',
			'obsidianmd/no-static-styles-assignment': 'error',
			// src/ warning sweep folded into this pass:
			'obsidianmd/prefer-window-timers': 'warn',
		},
	},
];
