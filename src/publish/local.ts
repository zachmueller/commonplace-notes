import { TFile } from 'obsidian';
import * as path from 'path';
import CommonplaceNotesPlugin from '../main';
import { Logger } from '../utils/logging';
import { NoticeManager } from '../utils/notice';

export async function publishLocalNotes(
	plugin: CommonplaceNotesPlugin,
	profileId: string
): Promise<boolean> {
	try {
		const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);

		if (!profile) {
			throw new Error('No publishing profile provided');
		}

		if (profile.publishMechanism !== 'Local') {		// || !profile.localSettings) {
			throw new Error('Selected profile is not configured for local publishing');
		}

		// TODO::extract this directory setup into the main plugin class for standard access pattern::
		const stagedNotesDir = plugin.profileManager.getStagedNotesDir(profileId);
		const combinedNotesPath = plugin.profileManager.getCombinedLocalNotesPath(profileId);
		const htmlOutputPath = plugin.profileManager.getPublishedHtmlPath(profileId);

		// Verify directories exist
		if (!plugin.app.vault.adapter.exists(stagedNotesDir)) {
			throw new Error(`Staged notes directory does not exist: ${stagedNotesDir}`);
		}

		// Combine all notes into a single JSON object
		const combinedNotes = await combineNotesData(plugin, profileId, stagedNotesDir);

		// Write combined JSON
		const { success: jsonSuccess, error: jsonError } = await NoticeManager.showProgress(
			`Writing combined notes to local file`,
			plugin.app.vault.adapter.write(combinedNotesPath, JSON.stringify(combinedNotes)),
			`Successfully wrote combined notes to ${combinedNotesPath}`,
			`Failed to write local file, check console for details`
		);

		if (!jsonSuccess) {
			throw jsonError;
		}

		// Process template and write HTML
		const { success: htmlSuccess, error: htmlError } = await NoticeManager.showProgress(
			`Generating HTML from template`,
			(async () => {
				const processedHtml = await processTemplate(plugin, profileId, combinedNotes);
				await plugin.app.vault.adapter.write(htmlOutputPath, processedHtml);
			})(),
			`Successfully generated HTML at ${htmlOutputPath}`,
			`Failed to generate HTML, check console for details`
		);

		if (!htmlSuccess) {
			throw htmlError;
		}

		Logger.info(`Successfully published ${Object.keys(combinedNotes).length} notes to ${combinedNotesPath} and ${htmlOutputPath}`);
		return true;

	} catch (error) {
		Logger.error('Error in local publishing:', error);
		NoticeManager.showNotice(`Local publishing failed: ${error.message}`);
		return false;
	}
}

async function combineNotesData(
	plugin: CommonplaceNotesPlugin,
	profileId: string,
	stagedNotesDir: string
) {
	const combinedNotes: Record<string, any> = {};

	// Read all staged note files
	const stagedFiles = await plugin.app.vault.adapter.list(stagedNotesDir);

	for (const file of stagedFiles.files) {
		if (file.endsWith('.json') && path.basename(file) !== 'index.json') {
			try {
				const content = await plugin.app.vault.adapter.read(file);
				const noteData = JSON.parse(content);

				// Use UID as the key for the combined object
				if (noteData.uid) {
					combinedNotes[noteData.uid] = noteData;
				}
			} catch (error) {
				Logger.warn(`Failed to read staged file ${file}:`, error);
			}
		}
	}

	return combinedNotes;
}

async function processTemplate(
	plugin: CommonplaceNotesPlugin,
	profileId: string,
	combinedNotes: Record<string, any>
): Promise<string> {
	// Read the template file
	const templatePath = plugin.profileManager.getLocalTemplateHtmlPath();

	if (!await plugin.app.vault.adapter.exists(templatePath)) {
		throw new Error(`Template file not found at ${templatePath}`);
	}

	let template = await plugin.app.vault.adapter.read(templatePath);

	// Get profile and home note UID
	const profile = plugin.settings.publishingProfiles.find(p => p.id === profileId);
	let defaultUid = '';

	if (profile?.homeNotePath) {
		const homeFile = plugin.app.vault.getAbstractFileByPath(profile.homeNotePath);
		if (homeFile instanceof TFile) {
			defaultUid = plugin.frontmatterManager.getNoteUID(homeFile) || '';
		}
	}

	// Load mapping data
	await plugin.mappingManager.loadProfileMappings(profileId);
	const mappingDir = plugin.profileManager.getMappingDir(profileId);

	let slugToUid = {};
	let uidToHash = {};

	try {
		const slugToUidContent = await plugin.app.vault.adapter.read(`${mappingDir}/slug-to-uid.json`);
		slugToUid = JSON.parse(slugToUidContent);
	} catch (e) {
		Logger.warn('Could not load slug-to-uid mapping:', e);
	}

	try {
		const uidToHashContent = await plugin.app.vault.adapter.read(`${mappingDir}/uid-to-hash.json`);
		uidToHash = JSON.parse(uidToHashContent);
	} catch (e) {
		Logger.warn('Could not load uid-to-hash mapping:', e);
	}

	// Replace placeholders
	template = template.replace('{{DEFAULT_UID}}', defaultUid);
	template = template.replace('{{NOTES_JSON}}', JSON.stringify(combinedNotes));
	template = template.replace('{{SLUG_TO_UID}}', JSON.stringify(slugToUid));
	template = template.replace('{{UID_TO_HASH}}', JSON.stringify(uidToHash));

	return template;
}