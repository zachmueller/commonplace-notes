import { Notice } from 'obsidian';
import * as path from 'path';
import { execAsync } from '../utils/shell';
import CommonplaceNotesPublisherPlugin from '../main';

export async function pushLocalJsonsToS3(plugin: CommonplaceNotesPublisherPlugin) {
	const basePath = (plugin.app.vault.adapter as any).basePath;
	const localJsonDirectory = path.join(basePath, '.obsidian', 'plugins', 'commonplace-notes-publisher', 'notes');
	const sourcePathEscaped = `"${path.resolve(localJsonDirectory)}"`;

	const s3Path = `s3://${plugin.settings.bucketName}/notes/`;
	const options = {
		cwd: (plugin.app.vault.adapter as any).basePath
	};

	try {
		new Notice('Uploading notes from local to S3...');
		const command = `aws s3 cp ${sourcePathEscaped} ${s3Path} --recursive --profile ${plugin.settings.awsProfile}`;
		console.log('Executing command:', command);

		const { stdout, stderr } = await execAsync(command, options);
		new Notice('Successfully uploaded notes to S3!');
		console.log('Output:', stdout);
		if (stderr) console.error('Errors:', stderr);
	} catch (error) {
		console.error('Error executing AWS command:', error);
	}
}