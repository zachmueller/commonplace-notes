#!/usr/bin/env npx tsx
/**
 * Test Vault Setup Script
 *
 * Creates or reconfigures a test vault for E2E testing.
 * Symlinks the plugin build output into the vault so Obsidian loads it.
 *
 * Because this plugin outputs main.js to the project root (not a build/ dir),
 * and the test vault lives inside the project at e2e/test-vault/, we cannot
 * symlink the entire project root (that would create a recursive loop).
 * Instead, we create the plugin directory and symlink individual files.
 *
 * Usage:
 *   npx tsx e2e/scripts/setup-vault.ts                    # Use default path
 *   npx tsx e2e/scripts/setup-vault.ts --vault /my/vault  # Use custom path
 *   npx tsx e2e/scripts/setup-vault.ts --clean             # Remove and recreate
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);

function getArg(name: string, defaultVal: string): string {
	const idx = args.indexOf(`--${name}`);
	if (idx !== -1 && args[idx + 1]) return args[idx + 1];
	return defaultVal;
}

function hasFlag(name: string): boolean {
	return args.includes(`--${name}`);
}

const VAULT_PATH = getArg("vault", path.resolve(__dirname, "..", "test-vault"));
const CLEAN = hasFlag("clean");
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// Read plugin ID from manifest
const manifestPath = path.join(PROJECT_ROOT, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const PLUGIN_ID: string = manifest.id;

console.log("=== Commonplace Notes E2E Vault Setup ===");
console.log(`Vault path:   ${VAULT_PATH}`);
console.log(`Plugin ID:    ${PLUGIN_ID}`);
console.log(`Project root: ${PROJECT_ROOT}`);
console.log(`Clean:        ${CLEAN}`);

// Clean if requested
if (CLEAN && fs.existsSync(VAULT_PATH)) {
	console.log("\nCleaning existing vault...");
	fs.rmSync(VAULT_PATH, { recursive: true, force: true });
}

// Create vault directory structure
const obsidianDir = path.join(VAULT_PATH, ".obsidian");
const pluginsDir = path.join(obsidianDir, "plugins");
const pluginDir = path.join(pluginsDir, PLUGIN_ID);

console.log("\nCreating vault structure...");
fs.mkdirSync(pluginsDir, { recursive: true });

// Write minimal Obsidian config
const configs: Record<string, unknown> = {
	"app.json": {
		alwaysUpdateLinks: true,
		newFileLocation: "current",
		attachmentFolderPath: "./",
		restrictMode: false,
	},
	"appearance.json": {
		baseFontSize: 16,
	},
	"core-plugins.json": {
		"file-explorer": true,
		"global-search": true,
		"command-palette": true,
		"markdown-importer": false,
		"zk-prefixer": false,
		"random-note": false,
		"outline": true,
		"word-count": true,
		"slides": false,
		"audio-recorder": false,
		"workspaces": false,
		"file-recovery": true,
		"page-preview": true,
	},
	"community-plugins.json": [PLUGIN_ID],
};

for (const [filename, content] of Object.entries(configs)) {
	const filePath = path.join(obsidianDir, filename);
	if (!fs.existsSync(filePath)) {
		fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
		console.log(`  Created: ${filename}`);
	} else {
		if (filename === "community-plugins.json") {
			const existing: string[] = JSON.parse(fs.readFileSync(filePath, "utf8"));
			if (!existing.includes(PLUGIN_ID)) {
				existing.push(PLUGIN_ID);
				fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
				console.log(`  Updated: ${filename} (added ${PLUGIN_ID})`);
			} else {
				console.log(`  Exists:  ${filename} (already has ${PLUGIN_ID})`);
			}
		} else {
			console.log(`  Exists:  ${filename}`);
		}
	}
}

// Set up plugin directory with individual file symlinks.
// We can't symlink the project root because that would create a recursive loop
// (test-vault is inside the project). Instead, symlink just the output files.
console.log("\nSetting up plugin file symlinks...");
fs.mkdirSync(pluginDir, { recursive: true });

const pluginFiles = ["main.js", "manifest.json", "styles.css"];
for (const file of pluginFiles) {
	const src = path.join(PROJECT_ROOT, file);
	const dest = path.join(pluginDir, file);

	if (!fs.existsSync(src)) {
		console.log(`  Skip:    ${file} (not found in project root)`);
		continue;
	}

	// Remove existing symlink/file
	try {
		if (fs.existsSync(dest) || fs.lstatSync(dest).isSymbolicLink()) {
			fs.unlinkSync(dest);
		}
	} catch {
		// File doesn't exist — fine
	}

	fs.symlinkSync(src, dest);
	console.log(`  Symlink: ${file} -> ${src}`);
}

// Enable debug mode in plugin settings for test observability
const pluginDataPath = path.join(pluginDir, "data.json");
const existingData: Record<string, unknown> = fs.existsSync(pluginDataPath)
	? JSON.parse(fs.readFileSync(pluginDataPath, "utf8"))
	: {};
existingData["debugMode"] = true;
fs.writeFileSync(pluginDataPath, JSON.stringify(existingData, null, 2));
console.log(`\nConfigured plugin data.json with debugMode: true for E2E testing.`);

// Create a sample note in the vault
const sampleNote = path.join(VAULT_PATH, "Test Note.md");
if (!fs.existsSync(sampleNote)) {
	fs.writeFileSync(
		sampleNote,
		`# Test Note

This is a test vault for E2E testing of the Commonplace Notes plugin.

Created automatically by the setup script.
`
	);
	console.log(`  Created sample note: Test Note.md`);
}

// Verify the setup
console.log("\n=== Verification ===");
const checks = [
	{ label: "Vault directory", path: VAULT_PATH },
	{ label: ".obsidian directory", path: obsidianDir },
	{ label: "plugins directory", path: pluginsDir },
	{ label: "Plugin directory", path: pluginDir },
	{ label: "community-plugins.json", path: path.join(obsidianDir, "community-plugins.json") },
];

let allGood = true;
for (const check of checks) {
	const exists = fs.existsSync(check.path);
	console.log(`  ${exists ? "OK" : "MISSING"} ${check.label}: ${check.path}`);
	if (!exists) allGood = false;
}

// Check that main.js exists (plugin must be built)
const mainJsPath = path.join(PROJECT_ROOT, "main.js");
if (fs.existsSync(mainJsPath)) {
	console.log(`  OK main.js exists (plugin is built)`);
} else {
	console.log(`  MISSING main.js — run 'npm run build' first!`);
	allGood = false;
}

if (allGood) {
	console.log("\nVault setup complete! Ready for E2E testing.");
} else {
	console.log("\nSetup partially complete — check warnings above.");
}

console.log(`\nTo run E2E tests:  npm run e2e:run`);
console.log(`To use this vault:  npm run e2e:run -- --vault ${VAULT_PATH}`);
