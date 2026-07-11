import { Setting } from 'obsidian';
import { SiteCustomization, NamedStyle, ThemeColors } from '../../types';
import { pushSiteAssetsToS3, createCloudFrontInvalidation } from '../../publish/awsUpload';
import { ProfileContext } from '../context';

/**
 * "Site Customization" section (AWS profiles): push assets, site title, font,
 * panel width, header links, theme color overrides (in a <details>), and
 * per-note named styles.
 */
export function renderSiteCustomizationSection(ctx: ProfileContext, containerEl: HTMLElement): void {
	const { plugin, profile, index } = ctx;
	const custom = profile.siteCustomization ?? {
		siteTitle: '',
		headerLinks: [],
		panelWidth: 600,
		fontFamily: '',
		themeOverrides: {},
	};

	new Setting(containerEl)
		.setName('Push site assets')
		.setDesc('Upload index.html, styles, scripts, and config to S3 without re-publishing notes')
		.addButton(button => button
			.setButtonText('Push site assets')
			.onClick(async () => {
				button.setDisabled(true);
				button.setButtonText('Pushing...');
				const success = await pushSiteAssetsToS3(plugin, profile.id);
				if (success) {
					await createCloudFrontInvalidation(plugin, profile.id);
				}
				button.setDisabled(false);
				button.setButtonText('Push site assets');
			}));

	new Setting(containerEl)
		.setName('Site title')
		.setDesc('Displayed in the browser tab')
		.addText(text => text
			.setPlaceholder('Notes')
			.setValue(custom.siteTitle)
			.onChange(async (value) => {
				ensureSiteCustomization(ctx).siteTitle = value;
				await plugin.saveSettings();
			}));

	new Setting(containerEl)
		.setName('Font family')
		.setDesc('CSS font-family value for the site body')
		.addText(text => text
			.setPlaceholder('"Helvetica Neue", Arial, sans-serif')
			.setValue(custom.fontFamily)
			.onChange(async (value) => {
				ensureSiteCustomization(ctx).fontFamily = value;
				await plugin.saveSettings();
			}));

	new Setting(containerEl)
		.setName('Panel width')
		.setDesc('Width of note panels in pixels')
		.addText(text => text
			.setPlaceholder('600')
			.setValue(custom.panelWidth ? String(custom.panelWidth) : '')
			.onChange(async (value) => {
				const num = parseInt(value, 10);
				if (!isNaN(num) && num > 0) {
					ensureSiteCustomization(ctx).panelWidth = num;
					await plugin.saveSettings();
				}
			}));

	// Header links
	const linksContainer = containerEl.createDiv({ cls: 'cpn-header-links-container' });
	new Setting(linksContainer)
		.setName('Header links')
		.setDesc('Additional navigation links in the site header');

	for (let i = 0; i < custom.headerLinks.length; i++) {
		const link = custom.headerLinks[i];
		new Setting(linksContainer)
			.addText(text => text
				.setPlaceholder('Label')
				.setValue(link.label)
				.onChange(async (value) => {
					ensureSiteCustomization(ctx).headerLinks[i].label = value;
					await plugin.saveSettings();
				}))
			.addText(text => text
				.setPlaceholder('URL')
				.setValue(link.url)
				.onChange(async (value) => {
					ensureSiteCustomization(ctx).headerLinks[i].url = value;
					await plugin.saveSettings();
				}))
			.addButton(button => button
				.setButtonText('Remove')
				.onClick(async () => {
					ensureSiteCustomization(ctx).headerLinks.splice(i, 1);
					await plugin.saveSettings();
					ctx.rerenderProfile();
				}));
	}

	new Setting(linksContainer)
		.addButton(button => button
			.setButtonText('Add link')
			.onClick(async () => {
				ensureSiteCustomization(ctx).headerLinks.push({ label: '', url: '' });
				await plugin.saveSettings();
				ctx.rerenderProfile();
			}));

	// Theme overrides
	const themeContainer = containerEl.createDiv({ cls: 'cpn-theme-overrides-container' });
	const themeDetails = themeContainer.createEl('details');
	themeDetails.createEl('summary', { text: 'Theme color overrides' });

	const lightSection = themeDetails.createDiv();
	new Setting(lightSection).setName('Light mode').setHeading();
	displayThemeColorInputs(ctx, lightSection, 'light', custom.themeOverrides.light ?? {},
		() => ensureSiteCustomization(ctx).themeOverrides);

	const darkSection = themeDetails.createDiv();
	new Setting(darkSection).setName('Dark mode').setHeading();
	displayThemeColorInputs(ctx, darkSection, 'dark', custom.themeOverrides.dark ?? {},
		() => ensureSiteCustomization(ctx).themeOverrides);

	// Named styles (per-note; referenced by the `cpn-style` frontmatter value)
	displayNamedStylesSettings(ctx, containerEl, custom);
}

/**
 * Per-profile "Named styles" editor. Each entry maps a style name (the value
 * a note puts in `cpn-style`) to scoped light/dark color overrides + an
 * optional font. Overrides layer on top of the global theme on the published
 * site; a note naming an undefined style falls back to default styling.
 */
function displayNamedStylesSettings(ctx: ProfileContext, containerEl: HTMLElement, custom: SiteCustomization): void {
	const { plugin } = ctx;
	const stylesContainer = containerEl.createDiv({ cls: 'cpn-named-styles-container' });
	const stylesDetails = stylesContainer.createEl('details');
	stylesDetails.createEl('summary', { text: 'Named styles (per-note)' });
	stylesDetails.createEl('p', {
		text: 'Define styles a note can select via the "cpn-style" frontmatter property. Overrides layer on top of the site theme; unknown names fall back to default styling.',
		cls: 'setting-item-description',
	});

	const namedStyles = custom.namedStyles ?? {};
	const names = Object.keys(namedStyles);

	for (const name of names) {
		const style = namedStyles[name];
		const styleSection = stylesDetails.createDiv({ cls: 'cpn-named-style' });

		// Style name (rekeys the record on change). `currentName` tracks the
		// live key so color/font/remove handlers keep targeting this entry
		// even after a rename, without a full re-render on every keystroke.
		let currentName = name;
		new Setting(styleSection)
			.setName('Style name')
			.setDesc('Used as the cpn-style value')
			.addText(text => text
				.setPlaceholder('e.g. ai')
				.setValue(currentName)
				.onChange(async (value) => {
					const next = value.trim();
					const styles = ensureNamedStyles(ctx);
					// Ignore empty or colliding names (can't be referenced / would clobber).
					if (!next || (next !== currentName && styles[next] !== undefined)) {
						return;
					}
					const existing = styles[currentName] ?? {};
					delete styles[currentName];
					styles[next] = existing;
					currentName = next;
					await plugin.saveSettings();
				}))
			.addButton(button => button
				.setButtonText('Remove')
				.setWarning()
				.onClick(async () => {
					delete ensureNamedStyles(ctx)[currentName];
					await plugin.saveSettings();
					ctx.rerenderProfile();
				}));

		new Setting(styleSection)
			.setName('Font family')
			.setDesc('Optional CSS font-family for notes using this style')
			.addText(text => text
				.setPlaceholder('inherit')
				.setValue(style.fontFamily ?? '')
				.onChange(async (value) => {
					const target = ensureNamedStyle(ctx, currentName);
					const trimmed = value.trim();
					if (trimmed) {
						target.fontFamily = trimmed;
					} else {
						delete target.fontFamily;
					}
					await plugin.saveSettings();
				}));

		const lightSection = styleSection.createDiv();
		new Setting(lightSection).setName('Light mode').setHeading();
		displayThemeColorInputs(ctx, lightSection, 'light', style.light ?? {},
			() => ensureNamedStyle(ctx, currentName));

		const darkSection = styleSection.createDiv();
		new Setting(darkSection).setName('Dark mode').setHeading();
		displayThemeColorInputs(ctx, darkSection, 'dark', style.dark ?? {},
			() => ensureNamedStyle(ctx, currentName));

		// Arbitrary custom CSS, auto-scoped to this style group on the site
		// (wrapped in `.cpn-style-<name> { … }` via native CSS nesting). Stored
		// raw to preserve author formatting; whitespace-only clears it (matching
		// the font-family delete-on-empty pattern, so an otherwise-empty style
		// still drops from config.json).
		new Setting(styleSection)
			.setName('Custom CSS')
			.setDesc('Applies only to notes with this cpn-style. Reference theme tokens (e.g. var(--text-primary)) so colors follow light/dark. Put top-level @keyframes/@font-face in the global extra-css slot instead.')
			.addTextArea(text => text
				.setPlaceholder('.my-class { color: var(--link-color); }')
				.setValue(style.css ?? '')
				.onChange(async (value) => {
					const target = ensureNamedStyle(ctx, currentName);
					if (value.trim()) {
						target.css = value;
					} else {
						delete target.css;
					}
					await plugin.saveSettings();
				}));
	}

	new Setting(stylesDetails)
		.addButton(button => button
			.setButtonText('Add style')
			.onClick(async () => {
				const styles = ensureNamedStyles(ctx);
				// Mint a unique placeholder key so the new row is editable immediately.
				let n = 1;
				let name = 'style';
				while (styles[name] !== undefined) {
					name = `style-${++n}`;
				}
				styles[name] = {};
				await plugin.saveSettings();
				ctx.rerenderProfile();
			}));
}

function ensureNamedStyles(ctx: ProfileContext): Record<string, NamedStyle> {
	const custom = ensureSiteCustomization(ctx);
	if (!custom.namedStyles) {
		custom.namedStyles = {};
	}
	return custom.namedStyles;
}

function ensureNamedStyle(ctx: ProfileContext, name: string): NamedStyle {
	const styles = ensureNamedStyles(ctx);
	if (!styles[name]) {
		styles[name] = {};
	}
	return styles[name];
}

/**
 * Render the five light/dark color inputs for a theme-colors target. Shared
 * by the global site theme (`themeOverrides`) and per-note named styles — both
 * expose a `{ light?; dark? }` container, supplied lazily via `ensureTarget`
 * so each onChange mutates the current object (which may be created on demand).
 */
function displayThemeColorInputs(
	ctx: ProfileContext,
	containerEl: HTMLElement,
	mode: 'light' | 'dark',
	colors: ThemeColors,
	ensureTarget: () => { light?: ThemeColors; dark?: ThemeColors }
): void {
	const { plugin } = ctx;
	const defaults: Record<'light' | 'dark', Record<string, string>> = {
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

	const fields: { name: string; key: keyof ThemeColors }[] = [
		{ name: 'Background (primary)', key: 'bgPrimary' },
		{ name: 'Background (secondary)', key: 'bgSecondary' },
		{ name: 'Text color', key: 'textPrimary' },
		{ name: 'Link color', key: 'linkColor' },
		{ name: 'Border color', key: 'borderColor' },
	];

	for (const field of fields) {
		const defaultColor = defaults[mode][field.key];
		new Setting(containerEl)
			.setName(field.name)
			.addText(text => {
				text.inputEl.type = 'color';
				text.inputEl.addClass('cpn-color-input');
				text.setValue(colors[field.key] || defaultColor)
					.onChange(async (value) => {
						const target = ensureTarget();
						if (!target[mode]) {
							target[mode] = {};
						}
						target[mode]![field.key] = value;
						await plugin.saveSettings();
					});
				return text;
			})
			.addButton(button => button
				.setButtonText('Reset')
				.onClick(async () => {
					const target = ensureTarget();
					if (target[mode]) {
						delete target[mode]![field.key];
					}
					await plugin.saveSettings();
					const colorInput = button.buttonEl.parentElement?.querySelector('input[type="color"]') as HTMLInputElement | null;
					if (colorInput) {
						colorInput.value = defaultColor;
					}
				}));
	}
}

function ensureSiteCustomization(ctx: ProfileContext): SiteCustomization {
	const profile = ctx.plugin.settings.publishingProfiles[ctx.index];
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
