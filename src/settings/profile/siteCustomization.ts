import { Notice, SettingDefinition, SettingDefinitionGroup, SettingDefinitionItem, SettingDefinitionPage } from 'obsidian';
import { NamedStyle, PublishingProfile, SiteCustomization, ThemeColors } from '../../types';
import { pushSiteAssetsToS3, createCloudFrontInvalidation } from '../../publish/awsUpload';
import { DefinitionContext } from '../context';
import { hintRow } from '../tabs/shared';

export type ThemeMode = 'light' | 'dark';

/** The site theme's built-in colors; an override equal to these is dropped. */
export const THEME_DEFAULTS: Record<ThemeMode, Required<ThemeColors>> = {
	light: {
		bgPrimary: '#ffffff',
		bgSecondary: '#f6f8fa',
		textPrimary: '#24292e',
		linkColor: '#0366d6',
		borderColor: '#dddddd',
	},
	dark: {
		bgPrimary: '#0d1117',
		bgSecondary: '#161b22',
		textPrimary: '#e6edf3',
		linkColor: '#58a6ff',
		borderColor: '#30363d',
	},
};

const THEME_FIELDS: { name: string; key: keyof ThemeColors }[] = [
	{ name: 'Background (primary)', key: 'bgPrimary' },
	{ name: 'Background (secondary)', key: 'bgSecondary' },
	{ name: 'Text color', key: 'textPrimary' },
	{ name: 'Link color', key: 'linkColor' },
	{ name: 'Border color', key: 'borderColor' },
];

/** Give a profile its `siteCustomization` object (with defaults) if it lacks one. */
export function ensureSiteCustomization(profile: PublishingProfile): SiteCustomization {
	if (!profile.siteCustomization) {
		profile.siteCustomization = {
			siteTitle: '',
			headerLinks: [],
			panelWidth: 600,
			fontFamily: '',
			themeOverrides: {},
		};
	}
	return profile.siteCustomization;
}

function ensureNamedStyles(profile: PublishingProfile): Record<string, NamedStyle> {
	const custom = ensureSiteCustomization(profile);
	if (!custom.namedStyles) custom.namedStyles = {};
	return custom.namedStyles;
}

/**
 * Light and Dark groups of color controls under `basePath` (a `{ light?; dark? }`
 * object). Each control's default is the theme color, so Obsidian's built-in
 * "Restore default" resets it, and the theme codec drops a value equal to the
 * default (as the old Reset button deleted it).
 */
function themeColorGroups(ctx: DefinitionContext, profile: PublishingProfile, basePath: string[], aliases: string[]): SettingDefinitionGroup[] {
	return (['light', 'dark'] as const).map(mode => ({
		type: 'group',
		heading: mode === 'light' ? 'Light mode' : 'Dark mode',
		items: THEME_FIELDS.map(field => ({
			name: field.name,
			aliases: [...aliases, mode, 'colour', 'theme'],
			control: {
				type: 'color',
				key: ctx.profileKey(profile, [...basePath, mode, field.key]),
				defaultValue: THEME_DEFAULTS[mode][field.key],
			},
		})),
	}));
}

/** Header links: a reorderable list of label + URL rows. */
function headerLinksList(ctx: DefinitionContext, profile: PublishingProfile): SettingDefinitionItem {
	const links = () => ensureSiteCustomization(profile).headerLinks;
	const persist = async () => {
		await ctx.save();
		ctx.refresh();
	};
	return {
		type: 'list',
		heading: 'Header links',
		emptyState: 'No header links. Additional navigation links appear in the site header.',
		visible: () => profile.publishMechanism === 'AWS',
		addItem: {
			name: 'Add link',
			action: () => {
				links().push({ label: '', url: '' });
				void persist();
			},
		},
		onDelete: index => {
			links().splice(index, 1);
			void persist();
		},
		onReorder: (from, to) => {
			const list = links();
			const [moved] = list.splice(from, 1);
			if (moved) list.splice(to, 0, moved);
			void persist();
		},
		items: (profile.siteCustomization?.headerLinks ?? []).map((link, i): SettingDefinition => ({
			name: link.label || 'Untitled link',
			desc: link.url,
			aliases: ['header link', 'navigation', 'menu'],
			render: setting => {
				setting.setName('').setDesc('');
				setting.addText(text => text
					.setPlaceholder('Label')
					.setValue(link.label)
					.onChange(value => ctx.write(ctx.profileKey(profile, ['siteCustomization', 'headerLinks', String(i), 'label']), value)));
				setting.addText(text => text
					.setPlaceholder('URL')
					.setValue(link.url)
					.onChange(value => ctx.write(ctx.profileKey(profile, ['siteCustomization', 'headerLinks', String(i), 'url']), value)));
			},
		})),
	};
}

/** One named style's page: name, font, custom CSS, colors, remove. */
function namedStylePage(ctx: DefinitionContext, profile: PublishingProfile, styleName: string, pageName: string): SettingDefinitionPage {
	const base = ['siteCustomization', 'namedStyles', styleName];
	return {
		type: 'page',
		name: pageName,
		desc: 'Used as the cpn-style value',
		items: [
			{
				type: 'group',
				items: [
					{
						name: 'Style name',
						desc: 'The cpn-style value notes use to select this style. Applied when you leave the field.',
						aliases: ['cpn-style', 'rename'],
						render: setting => {
							setting.addText(text => {
								text.setPlaceholder('e.g. ai').setValue(styleName);
								// Commit on change (blur / Enter), not per keystroke: the
								// name is the record key.
								text.inputEl.addEventListener('change', () => {
									const next = text.getValue().trim();
									const styles = ensureNamedStyles(profile);
									if (next === styleName) return;
									if (!next || styles[next] !== undefined) {
										new Notice(!next ? 'A style needs a name.' : `A style named "${next}" already exists.`);
										text.setValue(styleName);
										return;
									}
									styles[next] = styles[styleName] ?? {};
									delete styles[styleName];
									void ctx.save().then(() => ctx.refresh());
								});
							});
						},
					},
					{
						name: 'Font family',
						desc: 'Optional CSS font-family for notes using this style',
						aliases: ['font', 'typeface'],
						control: { type: 'text', key: ctx.profileKey(profile, [...base, 'fontFamily']), placeholder: 'inherit' },
					},
					// Arbitrary custom CSS, auto-scoped to this style group on the
					// site (wrapped in `.cpn-style-<name> { … }` via native CSS
					// nesting). Stored raw; whitespace-only clears it.
					{
						name: 'Custom CSS',
						desc: 'Applies only to notes with this cpn-style. Reference theme tokens (e.g. var(--text-primary)) so colors follow light/dark. Put top-level @keyframes/@font-face in the global extra-css slot instead.',
						aliases: ['css', 'stylesheet'],
						control: { type: 'textarea', key: ctx.profileKey(profile, [...base, 'css']), placeholder: '.my-class { color: var(--link-color); }' },
					},
				],
			},
			...themeColorGroups(ctx, profile, base, ['named style']),
			{
				type: 'group',
				items: [{
					name: 'Remove style',
					desc: 'Notes that still name this style fall back to default styling.',
					aliases: ['delete style'],
					render: setting => {
						setting.addButton(btn => btn
							.setButtonText('Remove')
							.setDestructive()
							.onClick(async () => {
								delete ensureNamedStyles(profile)[styleName];
								await ctx.save();
								ctx.refresh();
							}));
					},
				}],
			},
		],
	};
}

/**
 * Named styles sub-page: per-note styles (selected by the `cpn-style`
 * frontmatter value), each its own page. Overrides layer on top of the site
 * theme; a note naming an undefined style falls back to default styling.
 */
function namedStylesPage(ctx: DefinitionContext, profile: PublishingProfile): SettingDefinitionPage {
	const scope = `styles:${ctx.refs.refFor(profile)}`;
	const styles = profile.siteCustomization?.namedStyles ?? {};
	const named = ctx.names.resolve(scope, Object.entries(styles).map(([name, style]) => ({ ref: ctx.refs.refFor(style), name })));
	const keyOf = new Map(Object.entries(styles).map(([name, style]) => [ctx.refs.refFor(style), name]));
	const pages = named.map(({ ref, name }) => namedStylePage(ctx, profile, keyOf.get(ref)!, name));
	const tombstones: SettingDefinitionPage[] = ctx.names.removed(scope).map(({ name }) => ({
		type: 'page', name, visible: false,
		items: [{ name: 'Style removed', desc: 'This style was removed. Go back to Named styles.' }],
	}));
	return {
		type: 'page',
		name: 'Named styles',
		desc: 'Per-note styles a note selects with the cpn-style frontmatter property.',
		visible: () => profile.publishMechanism === 'AWS',
		items: [
			hintRow('Define styles a note can select via the "cpn-style" frontmatter property. Overrides layer on top of the site theme; unknown names fall back to default styling.'),
			{
				type: 'list',
				heading: 'Styles',
				emptyState: 'No named styles yet.',
				addItem: {
					name: 'Add style',
					action: () => {
						const all = ensureNamedStyles(profile);
						// Mint a unique placeholder key so the new entry is editable immediately.
						let n = 1;
						let name = 'style';
						while (all[name] !== undefined) name = `style-${++n}`;
						all[name] = {};
						void ctx.save().then(() => ctx.refresh());
					},
				},
				items: [...pages, ...tombstones],
			},
		],
	};
}

/**
 * "Site Customization" (AWS profiles): push assets, site title, font, panel
 * width and header links on the profile page; theme color overrides and
 * named styles as sub-pages.
 */
export function siteCustomizationItems(ctx: DefinitionContext, profile: PublishingProfile): SettingDefinitionItem[] {
	const { plugin } = ctx;
	const key = (path: string) => ctx.profileKey(profile, `siteCustomization.${path}`);
	const isAws = () => profile.publishMechanism === 'AWS';
	return [
		{
			type: 'group',
			heading: 'Site Customization',
			visible: isAws,
			items: [
				{
					name: 'Push site assets',
					desc: 'Upload index.html, styles, scripts, and config to S3 without re-publishing notes',
					aliases: ['upload', 'deploy site', 'config.json'],
					render: setting => {
						setting.addButton(button => button
							.setButtonText('Push site assets')
							.onClick(async () => {
								button.setDisabled(true);
								button.setButtonText('Pushing...');
								const success = await pushSiteAssetsToS3(plugin, profile.id);
								if (success) await createCloudFrontInvalidation(plugin, profile.id);
								button.setDisabled(false);
								button.setButtonText('Push site assets');
							}));
					},
				},
				{
					name: 'Site title',
					desc: 'Displayed in the browser tab',
					aliases: ['title', 'name'],
					control: { type: 'text', key: key('siteTitle'), placeholder: 'Notes' },
				},
				{
					name: 'Font family',
					desc: 'CSS font-family value for the site body',
					aliases: ['font', 'typeface'],
					control: { type: 'text', key: key('fontFamily'), placeholder: '"Helvetica Neue", Arial, sans-serif' },
				},
				{
					name: 'Panel width',
					desc: 'Width of note panels in pixels',
					aliases: ['width', 'layout'],
					control: { type: 'number', key: key('panelWidth'), defaultValue: 600, min: 1, step: 1, placeholder: '600' },
				},
				{
					type: 'page',
					name: 'Theme color overrides',
					desc: 'Site colors for light and dark mode.',
					items: themeColorGroups(ctx, profile, ['siteCustomization', 'themeOverrides'], ['theme override']),
				},
				namedStylesPage(ctx, profile),
			],
		},
		headerLinksList(ctx, profile),
	];
}
