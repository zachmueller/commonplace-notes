import { PublishingProfile, HeaderLink, SiteCustomization } from '../types';
import { SITE_INDEX_TEMPLATE, SITE_STYLES_CSS, SITE_APP_JS, FLEXSEARCH_MIN_JS, VENDOR_JS } from './siteAssets';

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

export function renderIndexHtml(profile: PublishingProfile, homeNoteUid?: string): string {
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

	return html;
}

export function renderStylesCss(profile: PublishingProfile): string {
	const custom = getCustomization(profile);
	const panelWidth = custom.panelWidth || DEFAULT_PANEL_WIDTH;

	let css = SITE_STYLES_CSS;
	css = css.replace(/flex: 0 0 600px/g, `flex: 0 0 ${panelWidth}px`);
	css = css.replace(/width: 600px/g, `width: ${panelWidth}px`);
	return css;
}

export function renderAppJs(): string {
	return SITE_APP_JS;
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

	const hasLightOverrides = custom.themeOverrides.light && Object.values(custom.themeOverrides.light).some(v => v);
	const hasDarkOverrides = custom.themeOverrides.dark && Object.values(custom.themeOverrides.dark).some(v => v);

	if (hasLightOverrides || hasDarkOverrides) {
		const theme: Record<string, Record<string, string>> = {};

		if (hasLightOverrides && custom.themeOverrides.light) {
			theme.light = {};
			const light = custom.themeOverrides.light;
			if (light.bgPrimary) theme.light['bg-primary'] = light.bgPrimary;
			if (light.bgSecondary) theme.light['bg-secondary'] = light.bgSecondary;
			if (light.textPrimary) theme.light['text-primary'] = light.textPrimary;
			if (light.linkColor) theme.light['link-color'] = light.linkColor;
			if (light.borderColor) theme.light['border-color'] = light.borderColor;
		}

		if (hasDarkOverrides && custom.themeOverrides.dark) {
			theme.dark = {};
			const dark = custom.themeOverrides.dark;
			if (dark.bgPrimary) theme.dark['bg-primary'] = dark.bgPrimary;
			if (dark.bgSecondary) theme.dark['bg-secondary'] = dark.bgSecondary;
			if (dark.textPrimary) theme.dark['text-primary'] = dark.textPrimary;
			if (dark.linkColor) theme.dark['link-color'] = dark.linkColor;
			if (dark.borderColor) theme.dark['border-color'] = dark.borderColor;
		}

		config.theme = theme;
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
