import { Notice, SettingDefinitionItem, SettingDefinitionPage } from 'obsidian';
import { confirmDestructive } from '../../utils/confirm';
import type { DefinitionContext } from '../context';
import type { AccessGroup, PublishingProfile } from '../../types';
import {
	ACCESS_GROUPS_KEY,
	canPublishGated,
	looksLikeEmail,
	normalizeGroupName,
	normalizeMembers,
} from '../../utils/access';
import { purgeRestrictedPartition } from '../../publish/awsUpload';
import { busyMessage, withProfileLock } from '../../utils/publishLock';
import { Logger, errorMessage } from '../../utils/logging';
import { hintRow } from '../tabs/shared';

function ensureGroups(profile: PublishingProfile): Record<string, AccessGroup> {
	if (!profile.accessGroups) profile.accessGroups = {};
	return profile.accessGroups;
}

async function confirmRemove(ctx: DefinitionContext, name: string): Promise<boolean> {
	const { confirmed } = await confirmDestructive(ctx.app, {
		title: `Remove access group "${name}"?`,
		body: 'This deletes the group\'s published copies from the site. Notes that still list this group stop publishing until you edit them. This cannot be undone.',
		confirmText: 'Remove',
	});
	return confirmed;
}

/** Remove a group, purge its published copies, and re-sync membership. */
async function removeGroup(ctx: DefinitionContext, profile: PublishingProfile, name: string): Promise<void> {
	const { plugin } = ctx;
	delete ensureGroups(profile)[name];
	if (Object.keys(ensureGroups(profile)).length === 0) delete profile.accessGroups;
	await ctx.save();
	// Delete the group's published copies; notes still listing the group are
	// unpublished at their next publish (fail closed).
	if (profile.publishMechanism === 'AWS' && profile.awsSettings?.bucketName) {
		try {
			const purge = await withProfileLock(profile.id, "removing a group's notes", () =>
				purgeRestrictedPartition(plugin, profile.id, name));
			if (purge.ran) {
				new Notice(`Removed group "${name}" (${purge.result} published object(s) deleted).`);
			} else {
				new Notice(`Group removed, but its published files weren't deleted: ${busyMessage(profile.name, purge.heldBy)} Its notes are unpublished at their next publish.`, 10000);
			}
		} catch (err) {
			Logger.error(`Could not purge restricted/${name}/:`, err);
			new Notice(`Group removed, but its published files could not be deleted: ${errorMessage(err)}`);
		}
	}
	try {
		await plugin.syncAccessGroups(profile);
	} catch (err) {
		Logger.warn('Access-group sync after removal failed:', err);
	}
}

/** One group's page: name (commits on change), description, members, remove. */
function groupPage(ctx: DefinitionContext, profile: PublishingProfile, groupName: string, pageName: string): SettingDefinitionPage {
	const group = () => profile.accessGroups?.[groupName];
	return {
		type: 'page',
		name: pageName,
		desc: group()?.description,
		displayValue: () => {
			const n = group()?.members?.length ?? 0;
			return `${n} member${n === 1 ? '' : 's'}`;
		},
		items: [
			{
				name: 'Group name',
				desc: `Lowercase letters, digits, and hyphens. Notes reference it in "${ACCESS_GROUPS_KEY}". Renaming does not update notes: notes still listing the old name stop publishing.`,
				aliases: ['rename', ACCESS_GROUPS_KEY],
				render: setting => {
					setting.addText(text => {
						text.setPlaceholder('e.g. family').setValue(groupName);
						// Commit on blur/Enter, not per keystroke: a partial name
						// would briefly un-define the group.
						text.inputEl.addEventListener('change', () => {
							void (async () => {
								const next = normalizeGroupName(text.getValue());
								const all = ensureGroups(profile);
								if (!next || (next !== groupName && all[next] !== undefined)) {
									new Notice(next ? `A group named "${next}" already exists.` : 'Invalid group name.');
									text.setValue(groupName);
									return;
								}
								if (next === groupName) {
									text.setValue(next);
									return;
								}
								all[next] = all[groupName];
								delete all[groupName];
								await ctx.save();
								ctx.refresh();
							})();
						});
					});
				},
			},
			{
				name: 'Description',
				desc: 'Optional note to self',
				aliases: ['note'],
				control: { type: 'text', key: ctx.profileKey(profile, ['accessGroups', groupName, 'description']), placeholder: 'Optional note to self' },
			},
			{
				name: 'Members',
				desc: 'One email per line: the Google account email each reader signs in with. Changes apply at their next sign-in.',
				aliases: ['emails', 'readers', 'people'],
				render: setting => {
					const warn = setting.infoEl.createDiv({ cls: 'setting-item-description mod-warning' });
					const showWarnings = (list: string[]) => {
						const bad = list.filter(m => !looksLikeEmail(m));
						warn.setText(bad.length ? `Not an email address: ${bad.join(', ')}` : '');
					};
					showWarnings(group()?.members ?? []);
					setting.addTextArea(text => {
						text.setPlaceholder('alice@example.com\nbob@example.com')
							.setValue((group()?.members ?? []).join('\n'))
							.onChange(value => {
								const g = group();
								if (!g) return;
								const members = normalizeMembers(value.split(/[\n,]/));
								ctx.write(ctx.profileKey(profile, ['accessGroups', groupName, 'members']), members);
								showWarnings(members);
							});
						text.inputEl.rows = 4;
					});
				},
			},
			{
				name: 'Remove group',
				desc: 'Deletes the group\'s published copies from the site. Notes that still list it stop publishing until you edit them.',
				aliases: ['delete group'],
				render: setting => {
					setting.addButton(button => button
						.setButtonText('Remove')
						.setDestructive()
						.onClick(async () => {
							if (!await confirmRemove(ctx, groupName)) return;
							await removeGroup(ctx, profile, groupName);
							ctx.refresh();
						}));
				},
			},
		],
	};
}

/**
 * "Access groups" sub-page: define the groups a note can list in its
 * `cpn-access-groups` frontmatter, and who (by email) may read each group's
 * notes. Membership is uploaded for the Cognito pre-token trigger on publish
 * (or via "Sync membership now") and takes effect at each reader's next
 * sign-in. Groups are pages in a list; the list has no one-key delete, since
 * removing a group purges published files (it's on each group's page).
 */
export function accessGroupsPage(ctx: DefinitionContext, profile: PublishingProfile): SettingDefinitionPage {
	const { plugin } = ctx;
	const scope = `groups:${ctx.refs.refFor(profile)}`;
	const groups = profile.accessGroups ?? {};
	const sortedNames = Object.keys(groups).sort();
	const named = ctx.names.resolve(scope, sortedNames.map(name => ({ ref: ctx.refs.refFor(groups[name]), name })));
	const keyOf = new Map(sortedNames.map(name => [ctx.refs.refFor(groups[name]), name]));
	const pages = named.map(({ ref, name }) => groupPage(ctx, profile, keyOf.get(ref)!, name));
	const tombstones: SettingDefinitionPage[] = ctx.names.removed(scope).map(({ name }) => ({
		type: 'page', name, visible: false,
		items: [{ name: 'Group removed', desc: 'This group was removed. Go back to Access groups.' }],
	}));
	const state = () => profile.infrastructureState;
	const hasPool = () => !!state()?.cognitoAuth?.stackName;

	const items: SettingDefinitionItem[] = [
		hintRow(`Gate individual notes to specific readers. Add a group here, then list it in a note's "${ACCESS_GROUPS_KEY}" frontmatter (a YAML list). `
			+ 'Notes without that property keep the site-wide read access. A gated note is published only to its groups: it is left out of search, chat, and public backlinks.'),
		{
			name: 'Status',
			desc: 'Whether this profile can publish gated notes.',
			aliases: ['gated notes', 'access'],
			render: setting => {
				const check = canPublishGated(profile);
				if (check.ok) {
					setting.setDesc('Ready: gated notes publish to their groups and are enforced at the edge.');
				} else {
					setting.setDesc(`Gated notes will not be published: ${check.reason}. Notes that list a group are removed from the site until this is resolved.`);
					setting.descEl.addClass('mod-warning');
				}
			},
		},
		// Public site: opt in to the public-reads edge fn (per-request cost).
		{
			name: 'Gate notes on this public site',
			aliases: ['public site', 'edge function', 'sign-in'],
			visible: () => (state()?.readGateMode ?? 'none') === 'none' && profile.publishMechanism === 'AWS',
			render: setting => {
				setting.setDesc((hasPool()
					? 'Keep the site public, but let notes that list a group require Google sign-in and membership. '
					: 'Needs the Cognito sign-in pool: re-run the deployment wizard with "Gate individual notes with access groups" on. ')
					+ 'Attaches a small Lambda@Edge function to every request (about US$0.60 per million requests plus a small duration charge, '
					+ 'and a few milliseconds of latency). After turning this on, run Settings → Infrastructure → Deploy access-groups edge function. '
					+ 'Turning it off leaves the edge function in place, so published gated notes stay protected; they are removed from the site at the next publish.');
				if (!hasPool()) setting.descEl.addClass('mod-warning');
				setting.addToggle(t => t
					.setValue(!!profile.publicSiteAccessGroups)
					.setDisabled(!hasPool() && !profile.publicSiteAccessGroups)
					.onChange(async v => {
						profile.publicSiteAccessGroups = v || undefined;
						await ctx.save();
						ctx.refresh();
					}));
			},
		},
		// BYO read gate: the author vouches for their edge fn.
		{
			name: 'My edge function enforces access groups',
			desc: 'Turn on only if your custom viewer-request function allows /restricted/<group>/* solely for viewers in <group>, '
				+ 'and answers GET /restricted/whoami with {"groups": [...]}. Otherwise gated notes would be readable by anyone your gate admits.',
			aliases: ['BYO', 'custom edge function'],
			visible: () => state()?.readGateMode === 'byo',
			render: setting => {
				setting.addToggle(t => t
					.setValue(!!profile.byoEnforcesAccessGroups)
					.onChange(async v => {
						profile.byoEnforcesAccessGroups = v || undefined;
						await ctx.save();
						ctx.refresh();
					}));
			},
		},
		{
			type: 'list',
			heading: 'Groups',
			emptyState: 'No access groups yet.',
			addItem: {
				name: 'Add group',
				action: () => {
					const all = ensureGroups(profile);
					let n = 1;
					let name = 'group';
					while (all[name] !== undefined) name = `group-${++n}`;
					all[name] = { members: [] };
					void ctx.save().then(() => ctx.refresh());
				},
			},
			items: [...pages, ...tombstones],
		},
		{
			name: 'Sync membership now',
			desc: 'Upload the member lists to AWS (also happens on every publish). Readers pick changes up at their next sign-in.',
			aliases: ['upload members', 'sync'],
			render: setting => {
				setting.addButton(button => button
					.setButtonText('Sync')
					.setDisabled(!state()?.cognitoAuth?.accessGroupsKey)
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
			},
		},
	];

	return {
		type: 'page',
		name: 'Access groups',
		desc: 'Who can read gated notes.',
		items,
	};
}
