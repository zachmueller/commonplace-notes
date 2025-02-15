import * as path from 'path';
import { execAsync } from '../utils/shell';
import CommonplaceNotesPublisherPlugin from '../main';

export async function pushLocalJsonsToS3(plugin: CommonplaceNotesPublisherPlugin) {
	// swap out with plugin.manifest.dir
	const basePath = (plugin.app.vault.adapter as any).basePath;
	const localJsonDirectory = path.join(basePath, '.obsidian', 'plugins', 'commonplace-notes-publisher', 'notes');
	const sourcePathEscaped = `"${path.resolve(localJsonDirectory)}"`;
	console.log(sourcePathEscaped);

	const s3Path = `s3://${plugin.settings.bucketName}/notes/`;
	const options = {
		cwd: (plugin.app.vault.adapter as any).basePath
	};

	try {
		const command = `aws s3 cp ${sourcePathEscaped} ${s3Path} --recursive --profile ${this.settings.awsProfile}`;
		console.log('Executing command:', command);

		const { stdout, stderr } = await execAsync(command, options);
		console.log('Output:', stdout);
		if (stderr) console.error('Errors:', stderr);
	} catch (error) {
		console.error('Error executing AWS command:', error);
	}
}