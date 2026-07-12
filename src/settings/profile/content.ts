import { Setting } from 'obsidian';
import { ProfileContext } from '../context';
import { HomeNoteSuggestModal } from '../homeNoteSuggestModal';

/**
 * "Content" section: home page, site-wide search opt-in, wikilink obfuscation,
 * and excluded directories.
 */
export function renderContentSection(ctx: ProfileContext, containerEl: HTMLElement): void {
	const { app, plugin, profile, index } = ctx;

	new Setting(containerEl)
		.setName('Home Page')
		.setDesc('Path to the note that should serve as the home page')
		.addText(text => {
			text.setPlaceholder('path/to/home-page.md')
				.setValue(profile.homeNotePath || '')
				.onChange(async (value) => {
					plugin.settings.publishingProfiles[index].homeNotePath = value;
					await plugin.saveSettings();
				});
			text.inputEl.setAttribute('data-home-input', profile.id);
			return text;
		})
		.addButton(button => button
			.setButtonText('Browse')
			.onClick(async () => {
				const files = await plugin.publisher.getAllPublishableNotes(profile.id);
				new HomeNoteSuggestModal(app, files, (file) => {
					void (async () => {
						plugin.settings.publishingProfiles[index].homeNotePath = file.path;
						await plugin.saveSettings();
						const input = containerEl.querySelector(`[data-home-input="${profile.id}"]`) as HTMLInputElement | null;
						if (input) input.value = file.path;
					})();
				}).open();
			}));

	new Setting(containerEl)
		.setName('Include site-wide content search')
		.setDesc('Choose whether to upload central content index data set to enable search on your published notes')
		.addToggle(toggle => toggle
			.setValue(profile.publishContentIndex ?? false)
			.onChange(async (value) => {
				plugin.settings.publishingProfiles[index].publishContentIndex = value;
				await plugin.saveSettings();
			}));

	new Setting(containerEl)
		.setName('Obscure wikilinks in published Markdown')
		.setDesc('Replace note paths in wikilinks with UIDs in the published raw Markdown (e.g. [[Note]] → [[UID|Note]]) to keep note titles private. Rendered HTML and search are unaffected. Turn off if your own tooling consumes the raw Markdown and needs literal titles.')
		.addToggle(toggle => toggle
			.setValue(profile.obscureRawWikilinks ?? true)
			.onChange(async (value) => {
				plugin.settings.publishingProfiles[index].obscureRawWikilinks = value;
				await plugin.saveSettings();
			}));

	new Setting(containerEl)
		.setName('Excluded directories')
		.setDesc('One directory per line (e.g., private/)')
		.addTextArea(text => text
			.setValue(profile.excludedDirectories.join('\n'))
			.onChange(async (value) => {
				plugin.settings.publishingProfiles[index].excludedDirectories =
					value.split('\n').filter(line => line.trim() !== '');
				await plugin.saveSettings();
			}));
}
