import type { SettingDefinitionGroup, TFile } from 'obsidian';
import { PublishingProfile } from '../../types';
import { DefinitionContext } from '../context';

/**
 * "Content" group: home page, site-wide search opt-in, wikilink and
 * attachment-name obfuscation, and excluded directories. The Attachments (Beta)
 * group follows it (attachments.ts).
 */
export function contentGroup(ctx: DefinitionContext, profile: PublishingProfile): SettingDefinitionGroup {
	const { app, plugin } = ctx;
	const key = (path: string) => ctx.profileKey(profile, path);

	return {
		type: 'group',
		heading: 'Content',
		items: [
			{
				name: 'Home Page',
				desc: 'The note that serves as the home page. Only notes this profile publishes can be chosen.',
				aliases: ['index', 'landing page', 'start page'],
				control: {
					type: 'file',
					key: key('homeNotePath'),
					placeholder: 'path/to/home-page.md',
					// Synchronous pre-filter; publish contexts (frontmatter) are
					// checked asynchronously in validate.
					filter: (file: TFile) => file.extension === 'md' && !plugin.publisher.isFileExcluded(file, profile),
					validate: async (path: string) => {
						if (!path) return;
						const file = app.vault.getFileByPath(path);
						if (!file) return 'No note at that path.';
						if (file.extension !== 'md') return 'Choose a Markdown note.';
						if (plugin.publisher.isFileExcluded(file, profile)) return 'That note is in an excluded directory.';
						const contexts = await plugin.publisher.getPublishContextsForFile(file);
						if (!contexts.includes(profile.id)) {
							return `This profile doesn't publish that note. Add "${profile.id}" to its cpn-publish-contexts.`;
						}
					},
				},
			},
			{
				name: 'Include site-wide content search',
				desc: 'Choose whether to upload central content index data set to enable search on your published notes',
				aliases: ['search index', 'content index'],
				control: { type: 'toggle', key: key('publishContentIndex'), defaultValue: false },
			},
			{
				name: 'Obscure wikilinks in published Markdown',
				desc: 'Replace note paths in wikilinks with UIDs in the published raw Markdown (e.g. [[Note]] → [[UID|Note]]) to keep note titles private. Rendered HTML and search are unaffected. Turn off if your own tooling consumes the raw Markdown and needs literal titles.',
				aliases: ['privacy', 'hide titles', 'raw markdown'],
				control: { type: 'toggle', key: key('obscureRawWikilinks'), defaultValue: true },
			},
			{
				name: 'Obscure attachment names in published Markdown',
				desc: 'Replace links to images, audio and other files in the published raw Markdown with the file\'s content hash, or null when the file isn\'t published (e.g. ![[Media/song.mp3]] → ![[3fa9….mp3]]), so folder paths stay private. As with note titles, the rendered note still shows a file\'s name unless the link has an alias. Rendered HTML and search are unaffected.',
				aliases: ['privacy', 'hide paths', 'raw markdown'],
				control: { type: 'toggle', key: key('obscureRawAttachments'), defaultValue: true },
			},
			{
				name: 'Excluded directories',
				desc: 'One folder per line, from the vault root. private/ excludes only the top-level private folder. Use * for any folder name and **/ for any depth, e.g. **/private/ excludes every folder named private.',
				aliases: ['ignore', 'folders', 'exclude', 'private'],
				control: { type: 'textarea', key: key('excludedDirectories') },
			},
		],
	};
}
