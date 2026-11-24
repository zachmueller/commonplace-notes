import { Notice, Setting } from 'obsidian';
import type { ProfileContext } from '../context';
import {
	DEFAULT_ALLOWED_EXTENSIONS,
	MAX_FILE_SIZE_MB,
	MIN_FILE_SIZE_MB,
	formatExtensionList,
	parseExtensionList,
	resolveAttachmentSettings,
	type AttachmentMode,
	type AttachmentSettings,
} from '../../utils/attachments';

const MODE_LABELS: Record<AttachmentMode, string> = {
	off: 'Off',
	embeds: 'Embeds (![[file]])',
	embedsAndLinks: 'Embeds and links ([[file]])',
};

/**
 * "Attachments (Beta)" group inside the Content section (attachment spec
 * P2 §2): which links publish files, the extension allow-list and the size
 * cap. Disabled on Local profiles.
 */
export function renderAttachmentsGroup(ctx: ProfileContext, containerEl: HTMLElement): void {
	const { plugin, index } = ctx;
	const profile = plugin.settings.publishingProfiles[index];
	const isLocal = profile.publishMechanism === 'Local';
	const current = (): AttachmentSettings => resolveAttachmentSettings(plugin.settings.publishingProfiles[index].attachments);
	const update = async (patch: Partial<AttachmentSettings>) => {
		const p = plugin.settings.publishingProfiles[index];
		p.attachments = { ...current(), ...patch };
		await plugin.saveSettings();
	};

	const heading = new Setting(containerEl).setName('Attachments (Beta)').setHeading();
	heading.setDesc(
		'Beta: attachment publishing is new and may change. Publish the images, audio, video and other files your notes link to. '
		+ 'Each file is readable by exactly the readers who can read a note that references it.'
		+ (isLocal ? ' Attachments publish on AWS profiles only.' : ''),
	);
	containerEl.setAttribute('data-cpn-attachments', profile.id);

	new Setting(containerEl)
		.setName('Publish attachments')
		.setDesc('Changing this gives affected notes a new revision on their next publish. Narrowing it or turning it off leaves files in the bucket while older revisions still reference them.')
		.addDropdown(dropdown => {
			for (const [value, label] of Object.entries(MODE_LABELS)) dropdown.addOption(value, label);
			dropdown.setValue(current().mode)
				.setDisabled(isLocal)
				.onChange(async (value) => {
					const before = current().mode;
					const mode = value as AttachmentMode;
					await update({ mode });
					if (before === 'off' && mode !== 'off') {
						new Notice('Attachments are on. Run "Publish all notes" once so existing notes pick up their attachments.', 12000);
					}
				});
		});

	new Setting(containerEl)
		.setName('Show PDFs inline')
		.setDesc('PDF embeds (![[file.pdf]]) show in the note in the browser\'s PDF viewer, with a link to open them in a new tab. Plain links still open in a new tab. Phone browsers may only show the link. Run "Publish all notes" after changing this.')
		.addToggle(toggle => {
			toggle.setValue(current().inlinePdfs)
				.setDisabled(isLocal)
				.onChange(async (inlinePdfs) => {
					await update({ inlinePdfs });
					new Notice('Run "Publish all notes" so published notes pick up the change.', 12000);
				});
		});

	new Setting(containerEl)
		.setName('Allowed extensions')
		.setDesc(`Space- or comma-separated. * allows every file. HTML, JavaScript and other active files download instead of opening. Default: ${formatExtensionList(DEFAULT_ALLOWED_EXTENSIONS)}.`)
		.addTextArea(text => {
			text.setValue(formatExtensionList(current().allowedExtensions))
				.setDisabled(isLocal)
				.onChange(async (value) => {
					await update({ allowedExtensions: parseExtensionList(value) });
				});
			text.inputEl.rows = 3;
		});

	new Setting(containerEl)
		.setName('Maximum file size (MB)')
		.setDesc(`Larger files are skipped with a notice. ${MIN_FILE_SIZE_MB}–${MAX_FILE_SIZE_MB}.`)
		.addText(text => {
			text.inputEl.type = 'number';
			text.inputEl.min = String(MIN_FILE_SIZE_MB);
			text.inputEl.max = String(MAX_FILE_SIZE_MB);
			text.setValue(String(current().maxFileSizeMB))
				.setDisabled(isLocal)
				.onChange(async (value) => {
					const n = Number(value);
					if (!Number.isFinite(n) || n < MIN_FILE_SIZE_MB || n > MAX_FILE_SIZE_MB) return;
					await update({ maxFileSizeMB: Math.round(n) });
				});
		});
}
