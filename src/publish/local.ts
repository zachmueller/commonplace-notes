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

		// Verify directories exist
		if (!plugin.app.vault.adapter.exists(stagedNotesDir)) {
			throw new Error(`Staged notes directory does not exist: ${stagedNotesDir}`);
		}

		// Combine all notes into a single JSON object
		const combinedNotes = await combineNotesData(plugin, profileId, stagedNotesDir);

		const { success, error } = await NoticeManager.showProgress(
			`Writing combined notes to local file`,
			plugin.app.vault.adapter.write(combinedNotesPath, JSON.stringify(combinedNotes)),
			`Successfully wrote combined notes to ${combinedNotesPath}`,
			`Failed to write local file, check console for details`
		);

		if (!success) {
			throw error;
		}

		Logger.info(`Successfully published ${Object.keys(combinedNotes).length} notes to ${combinedNotesPath}`);
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