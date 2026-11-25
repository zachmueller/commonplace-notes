import type { SettingDefinitionGroup } from 'obsidian';
import { PublishingProfile } from '../../types';
import { DefinitionContext } from '../context';
import {
	DEFAULT_ALLOWED_EXTENSIONS,
	MAX_FILE_SIZE_MB,
	MIN_FILE_SIZE_MB,
	formatExtensionList,
	type AttachmentMode,
} from '../../utils/attachments';
import { hintRow } from '../tabs/shared';

const MODE_LABELS: Record<AttachmentMode, string> = {
	off: 'Off',
	embeds: 'Embeds (![[file]])',
	embedsAndLinks: 'Embeds and links ([[file]])',
};

/**
 * "Attachments (Beta)" group (attachment spec P2 §2): which links publish
 * files, the extension allow-list and the size cap. Disabled on Local
 * profiles. Reads and writes go through the attachments.* codecs, which fill
 * in defaults.
 */
export function attachmentsGroup(ctx: DefinitionContext, profile: PublishingProfile): SettingDefinitionGroup {
	const key = (path: string) => ctx.profileKey(profile, path);
	const isLocal = () => profile.publishMechanism === 'Local';

	return {
		type: 'group',
		heading: 'Attachments (Beta)',
		cls: 'cpn-attachments-group',
		items: [
			hintRow('Beta: attachment publishing is new and may change. Publish the images, audio, video and other files your notes link to. '
				+ 'Each file is readable by exactly the readers who can read a note that references it. Attachments publish on AWS profiles only.'),
			{
				name: 'Publish attachments',
				desc: 'Changing this gives affected notes a new revision on their next publish. Narrowing it or turning it off leaves files in the bucket while older revisions still reference them.',
				aliases: ['images', 'media', 'files', 'embeds'],
				control: { type: 'dropdown', key: key('attachments.mode'), options: MODE_LABELS, disabled: isLocal },
			},
			{
				name: 'Show PDFs inline',
				desc: 'PDF embeds (![[file.pdf]]) show in the note in the browser\'s PDF viewer, with a link to open them in a new tab. Plain links still open in a new tab. Phone browsers may only show the link. Run "Publish all notes" after changing this.',
				aliases: ['pdf', 'embed'],
				control: { type: 'toggle', key: key('attachments.inlinePdfs'), disabled: isLocal },
			},
			{
				name: 'Allowed extensions',
				desc: `Space- or comma-separated. * allows every file. HTML, JavaScript and other active files download instead of opening. Default: ${formatExtensionList(DEFAULT_ALLOWED_EXTENSIONS)}.`,
				aliases: ['file types', 'allow list'],
				control: { type: 'textarea', key: key('attachments.allowedExtensions'), disabled: isLocal },
			},
			{
				name: 'Maximum file size (MB)',
				desc: `Larger files are skipped with a notice. ${MIN_FILE_SIZE_MB}–${MAX_FILE_SIZE_MB}.`,
				aliases: ['size limit', 'megabytes'],
				control: {
					type: 'number',
					key: key('attachments.maxFileSizeMB'),
					min: MIN_FILE_SIZE_MB,
					max: MAX_FILE_SIZE_MB,
					step: 1,
					disabled: isLocal,
				},
			},
		],
	};
}
