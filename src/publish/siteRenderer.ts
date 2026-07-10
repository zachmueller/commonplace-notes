import { PublishingProfile, HeaderLink, SiteCustomization, ThemeColors } from '../types';
import { SITE_INDEX_TEMPLATE, SITE_STYLES_CSS, SITE_APP_JS, FLEXSEARCH_MIN_JS, VENDOR_JS } from './siteAssets';
import { applyIndexHtmlSlots, applyStylesCssSlots } from './assetCustomizations/parse';
import type { AssetCustomization } from './assetCustomizations/types';

const DEFAULT_SITE_TITLE = 'Notes';
const DEFAULT_PANEL_WIDTH = 600;
const DEFAULT_FONT_FAMILY = '"Helvetica Neue", Arial, sans-serif';

function getCustomization(profile: PublishingProfile): SiteCustomization {
	return profile.siteCustomization ?? {
		siteTitle: DEFAULT_SITE_TITLE,
		headerLinks: [],
		panelWidth: DEFAULT_PANEL_WIDTH,
		fontFamily: DEFAULT_FONT_FAMILY,
		themeOverrides: {},
	};
}

function renderHeaderLinksHtml(headerLinks: HeaderLink[], homeNoteUid?: string): string {
	const homeHref = homeNoteUid ? `#/u${homeNoteUid}` : '#/pindex';
	const homeLink = `<a href="${homeHref}" class="home-link">Home</a>`;
	if (headerLinks.length === 0) return homeLink;

	const customLinks = headerLinks.map(link => {
		const escaped = link.label.replace(/</g, '&lt;').replace(/>/g, '&gt;');
		const href = link.url.replace(/"/g, '&quot;');
		const isExternal = link.url.startsWith('http://') || link.url.startsWith('https://');
		const target = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
		return `<a href="${href}"${target}>${escaped}</a>`;
	}).join('\n\t\t\t');

	return `${homeLink}\n\t\t\t${customLinks}`;
}

export function renderIndexHtml(
	profile: PublishingProfile,
	homeNoteUid?: string,
	customizations: AssetCustomization[] = [],
): string {
	const custom = getCustomization(profile);

	let html = SITE_INDEX_TEMPLATE;
	html = html.replace('{{SITE_TITLE}}', custom.siteTitle || DEFAULT_SITE_TITLE);
	html = html.replace('{{HEADER_LINKS_HTML}}', renderHeaderLinksHtml(custom.headerLinks, homeNoteUid));

	if (homeNoteUid) {
		html = html.replace('{{HOME_NOTE_UID_SCRIPT}}',
			`<script>window.__CPN_HOME_UID__ = "${homeNoteUid}";</script>`);
	} else {
		html = html.replace('{{HOME_NOTE_UID_SCRIPT}}', '');
	}

	// Per-profile snippet injection (route 2). Runs after the structured
	// substitutions above; empty/absent slots no-op (see applyIndexHtmlSlots).
	html = applyIndexHtmlSlots(html, customizations);

	return html;
}

export function renderStylesCss(
	profile: PublishingProfile,
	customizations: AssetCustomization[] = [],
): string {
	const custom = getCustomization(profile);
	const panelWidth = custom.panelWidth || DEFAULT_PANEL_WIDTH;

	let css = SITE_STYLES_CSS;
	css = css.replace(/flex: 0 0 600px/g, `flex: 0 0 ${panelWidth}px`);
	css = css.replace(/width: 600px/g, `width: ${panelWidth}px`);
	css = applyStylesCssSlots(css, customizations);
	return css;
}

export function renderAppJs(): string {
	return SITE_APP_JS;
}

/**
 * Serialize a set of theme colors into a kebab-case CSS-variable map, emitting
 * only the keys that are actually set (mirrors the per-key guards the global
 * theme has always used). The `--` prefix is added at runtime, not here.
 */
function emitThemeVars(colors: ThemeColors | undefined): Record<string, string> {
	const vars: Record<string, string> = {};
	if (!colors) return vars;
	if (colors.bgPrimary) vars['bg-primary'] = colors.bgPrimary;
	if (colors.bgSecondary) vars['bg-secondary'] = colors.bgSecondary;
	if (colors.textPrimary) vars['text-primary'] = colors.textPrimary;
	if (colors.linkColor) vars['link-color'] = colors.linkColor;
	if (colors.borderColor) vars['border-color'] = colors.borderColor;
	return vars;
}

export function renderConfigJson(profile: PublishingProfile, homeNoteUid?: string): string {
	const custom = getCustomization(profile);

	const config: Record<string, unknown> = { version: 1 };

	if (homeNoteUid) {
		config.homeNoteUid = homeNoteUid;
	}

	if (custom.fontFamily && custom.fontFamily !== DEFAULT_FONT_FAMILY) {
		config.fontFamily = custom.fontFamily;
	}

	const light = emitThemeVars(custom.themeOverrides.light);
	const dark = emitThemeVars(custom.themeOverrides.dark);

	if (Object.keys(light).length || Object.keys(dark).length) {
		const theme: Record<string, Record<string, string>> = {};
		if (Object.keys(light).length) theme.light = light;
		if (Object.keys(dark).length) theme.dark = dark;
		config.theme = theme;
	}

	// Per-note named styles (referenced by the note's `cpn-style`). Each entry
	// carries only the light/dark vars + optional font it wants to override;
	// unset properties inherit the global theme client-side. Absent name ⇒
	// silent fallback. Emit only styles that actually declare something.
	if (custom.namedStyles && Object.keys(custom.namedStyles).length) {
		const styles: Record<string, Record<string, unknown>> = {};
		for (const [name, style] of Object.entries(custom.namedStyles)) {
			const styleLight = emitThemeVars(style.light);
			const styleDark = emitThemeVars(style.dark);
			const entry: Record<string, unknown> = {};
			if (Object.keys(styleLight).length) entry.light = styleLight;
			if (Object.keys(styleDark).length) entry.dark = styleDark;
			if (style.fontFamily) entry.font = style.fontFamily;
			if (Object.keys(entry).length) styles[name] = entry;
		}
		if (Object.keys(styles).length) config.styles = styles;
	}

	// Commenting + built-in auth (consumed by the comment client via
	// window.__CPN_CONFIG__). Only emitted when commenting is enabled and the
	// Cognito auth stack has been deployed (its outputs supply the login URL).
	const auth = profile.infrastructureState?.cognitoAuth;
	if (profile.commenting?.enabled && auth?.commentIdentity) {
		config.commentsEnabled = true;
		config.commentReadPath = '/comments/';
		config.commentWritePath = '/api/comments';
		config.commentMePath = '/api/me';
		if (auth.hostedUiDomain && auth.userPoolClientId && profile.baseUrl) {
			const redirectUri = profile.baseUrl.replace(/\/+$/, '') + '/auth/callback';
			const params = new URLSearchParams({
				client_id: auth.userPoolClientId,
				response_type: 'code',
				scope: 'openid email profile',
				identity_provider: 'Google',
				redirect_uri: redirectUri,
			});
			config.authLoginUrl = `${auth.hostedUiDomain}/oauth2/authorize?${params.toString()}`;
			// True when the whole site (and thus comment reads) requires login —
			// i.e. the Cognito edge fn gates reads. Password/BYO/public reads do not.
			config.readGating = profile.infrastructureState?.readGateMode === 'cognito';
		}
	}

	return JSON.stringify(config, null, '\t');
}

export function getFlexSearchJs(): string {
	return FLEXSEARCH_MIN_JS;
}

export function renderVendorJs(): string {
	return VENDOR_JS;
}
