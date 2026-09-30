import { Modal, Notice, Setting } from 'obsidian';
import type { ProfileContext } from '../context';
import type { AccessGroup } from '../../types';
import {
	ACCESS_GROUPS_KEY,
	canPublishGated,
	looksLikeEmail,
	normalizeGroupName,
	normalizeMembers,
} from '../../utils/access';
import { purgeRestrictedPartition } from '../../publish/awsUpload';
import { Logger, errorMessage } from '../../utils/logging';

/**
 * "Access groups" profile section: define the groups a note can list in its
 * `cpn-access-groups` frontmatter, and who (by email) may read each group's
 * notes. Membership is uploaded for the Cognito pre-token trigger on publish (or
 * via "Sync membership now") and takes effect at each reader's next sign-in.
 */
export function renderAccessGroupsSection(ctx: ProfileContext, containerEl: HTMLElement): void {
	const { plugin, profile } = ctx;

	containerEl.createEl('p', {
		cls: 'setting-item-description',
		text: `Gate individual notes to specific readers. Add a group here, then list it in a note's "${ACCESS_GROUPS_KEY}" frontmatter (a YAML list). `
			+ 'Notes without that property keep the site-wide read access. A gated note is published only to its groups: it is left out of search, chat, and public backlinks.',
	});

	// Can this profile publish gated notes at all?
	const check = canPublishGated(profile);
	const status = new Setting(containerEl).setName('Status');
	if (check.ok) {
		status.setDesc('Ready: gated notes publish to their groups and are enforced at the edge.');
	} else {
		status.setDesc(`Gated notes will not be published: ${check.reason}. Notes that list a group are removed from the site until this is resolved.`);
		status.descEl.addClass('mod-warning');
	}

	// Public site: opt in to the public-reads edge fn (per-request cost).
	const state = profile.infrastructureState;
	if ((state?.readGateMode ?? 'none') === 'none' && profile.publishMechanism === 'AWS') {
		const hasPool = !!state?.cognitoAuth?.stackName;
		const toggle = new Setting(containerEl)
			.setName('Gate notes on this public site')
			.setDesc((hasPool
				? 'Keep the site public, but let notes that list a group require Google sign-in and membership. '
				: 'Needs the Cognito sign-in pool: re-run the deployment wizard with "Gate individual notes with access groups" on. ')
				+ 'Attaches a small Lambda@Edge function to every request (about US$0.60 per million requests plus a small duration charge, '
				+ 'and a few milliseconds of latency). After turning this on, run Settings → Infrastructure → Deploy access-groups edge function. '
				+ 'Turning it off leaves the edge function in place, so published gated notes stay protected; they are removed from the site at the next publish.')
			.addToggle(t => t
				.setValue(!!profile.publicSiteAccessGroups)
				.setDisabled(!hasPool && !profile.publicSiteAccessGroups)
				.onChange(async (v) => {
					profile.publicSiteAccessGroups = v || undefined;
					await plugin.saveSettings();
					ctx.rerenderProfile();
				}));
		if (!hasPool) toggle.descEl.addClass('mod-warning');
	}

	// BYO read gate: the author vouches for their edge fn.
	if (profile.infrastructureState?.readGateMode === 'byo') {
		new Setting(containerEl)
			.setName('My edge function enforces access groups')
			.setDesc('Turn on only if your custom viewer-request function allows /restricted/<group>/* solely for viewers in <group>, '
				+ 'and answers GET /restricted/whoami with {"groups": [...]}. Otherwise gated notes would be readable by anyone your gate admits.')
			.addToggle(t => t
				.setValue(!!profile.byoEnforcesAccessGroups)
				.onChange(async (v) => {
					profile.byoEnforcesAccessGroups = v || undefined;
					await plugin.saveSettings();
					ctx.rerenderProfile();
				}));
	}

	const groups = profile.accessGroups ?? {};
	for (const name of Object.keys(groups).sort()) {
		renderGroup(ctx, containerEl, name, groups[name]);
	}

	new Setting(containerEl)
		.addButton(button => button
			.setButtonText('Add group')
			.onClick(async () => {
				const all = ensureGroups(ctx);
				let n = 1;
				let name = 'group';
				while (all[name] !== undefined) name = `group-${++n}`;
				all[name] = { members: [] };
				await plugin.saveSettings();
				ctx.rerenderProfile();
			}))
		.addButton(button => button
			.setButtonText('Sync membership now')
			.setTooltip('Upload the member lists to AWS (also happens on every publish)')
			.setDisabled(!profile.infrastructureState?.cognitoAuth?.accessGroupsKey)
			.onClick(async () => {
				button.setDisabled(true);
				try {
					await plugin.syncAccessGroups(profile, { force: true });
					new Notice('Access-group membership synced. Readers pick it up at their next sign-in (within about an hour).');
				} catch (err) {
					Logger.error('Access-group sync failed:', err);
					new Notice(`Sync failed: ${errorMessage(err)}`);
				} finally {
					button.setDisabled(false);
				}
			}));
}

function renderGroup(ctx: ProfileContext, containerEl: HTMLElement, name: string, group: AccessGroup): void {
	const { plugin } = ctx;
	const box = containerEl.createDiv({ cls: 'cpn-access-group' });
	let currentName = name;

	new Setting(box)
		.setName('Group name')
		.setDesc(`Lowercase letters, digits, and hyphens. Notes reference it in "${ACCESS_GROUPS_KEY}". Renaming does not update notes: notes still listing the old name stop publishing.`)
		.addText(text => {
			text.setPlaceholder('e.g. family').setValue(currentName);
			// Commit on blur/Enter, not per keystroke: a partial name would
			// briefly un-define the group.
			text.inputEl.addEventListener('change', () => {
				void (async () => {
					const next = normalizeGroupName(text.getValue());
					const all = ensureGroups(ctx);
					if (!next || (next !== currentName && all[next] !== undefined)) {
						new Notice(next ? `A group named "${next}" already exists.` : 'Invalid group name.');
						text.setValue(currentName);
						return;
					}
					if (next === currentName) {
						text.setValue(next);
						return;
					}
					all[next] = all[currentName];
					delete all[currentName];
					currentName = next;
					await plugin.saveSettings();
					ctx.rerenderProfile();
				})();
			});
		})
		.addButton(button => button
			.setButtonText('Remove')
			.setWarning()
			.onClick(async () => {
				const confirmed = await confirmRemove(ctx, currentName);
				if (!confirmed) return;
				delete ensureGroups(ctx)[currentName];
				if (Object.keys(ensureGroups(ctx)).length === 0) delete ctx.profile.accessGroups;
				await plugin.saveSettings();
				// Delete the group's published copies; notes still listing the
				// group are unpublished at their next publish (fail closed).
				if (ctx.profile.publishMechanism === 'AWS' && ctx.profile.awsSettings?.bucketName) {
					try {
						const n = await purgeRestrictedPartition(plugin, ctx.profile.id, currentName);
						new Notice(`Removed group "${currentName}" (${n} published object(s) deleted).`);
					} catch (err) {
						Logger.error(`Could not purge restricted/${currentName}/:`, err);
						new Notice(`Group removed, but its published files could not be deleted: ${errorMessage(err)}`);
					}
				}
				try {
					await plugin.syncAccessGroups(ctx.profile);
				} catch (err) {
					Logger.warn('Access-group sync after removal failed:', err);
				}
				ctx.rerenderProfile();
			}));

	new Setting(box)
		.setName('Description')
		.addText(text => text
			.setPlaceholder('Optional note to self')
			.setValue(group.description ?? '')
			.onChange(async (value) => {
				const g = ensureGroups(ctx)[currentName];
				if (!g) return;
				if (value.trim()) g.description = value.trim();
				else delete g.description;
				await plugin.saveSettings();
			}));

	const members = new Setting(box)
		.setName('Members')
		.setDesc('One email per line: the Google account email each reader signs in with. Changes apply at their next sign-in.');
	const warn = box.createDiv({ cls: 'setting-item-description mod-warning' });
	const showWarnings = (list: string[]) => {
		const bad = list.filter(m => !looksLikeEmail(m));
		warn.setText(bad.length ? `Not an email address: ${bad.join(', ')}` : '');
	};
	showWarnings(group.members || []);
	members.addTextArea(text => {
		text.setPlaceholder('alice@example.com\nbob@example.com')
			.setValue((group.members || []).join('\n'))
			.onChange(async (value) => {
				const g = ensureGroups(ctx)[currentName];
				if (!g) return;
				g.members = normalizeMembers(value.split(/[\n,]/));
				showWarnings(g.members);
				await plugin.saveSettings();
			});
		text.inputEl.rows = 4;
	});
}

function ensureGroups(ctx: ProfileContext): Record<string, AccessGroup> {
	if (!ctx.profile.accessGroups) ctx.profile.accessGroups = {};
	return ctx.profile.accessGroups;
}

function confirmRemove(ctx: ProfileContext, name: string): Promise<boolean> {
	return new Promise(resolve => {
		const modal = new Modal(ctx.app);
		let settled = false;
		const finish = (v: boolean) => {
			if (settled) return;
			settled = true;
			resolve(v);
			modal.close();
		};
		modal.onOpen = () => {
			modal.titleEl.setText(`Remove access group "${name}"?`);
			modal.contentEl.createEl('p', {
				text: 'This deletes the group\'s published copies from the site. Notes that still list this group stop publishing until you edit them. This cannot be undone.',
			});
			new Setting(modal.contentEl)
				.addButton(b => b.setButtonText('Cancel').onClick(() => finish(false)))
				.addButton(b => b.setButtonText('Remove').setWarning().onClick(() => finish(true)));
		};
		modal.onClose = () => finish(false);
		modal.open();
	});
}
