import { PublishingProfile, HeaderLink, SiteCustomization, ThemeColors } from '../types';
import { SITE_INDEX_TEMPLATE, SITE_STYLES_CSS, SITE_APP_JS, SITE_CHAT_HTML, FLEXSEARCH_MIN_JS, VENDOR_JS } from './siteAssets';
import { applyIndexHtmlSlots, applyStylesCssSlots } from './assetCustomizations/parse';
import type { AssetCustomization } from './assetCustomizations/types';
import { canPublishGated, WHOAMI_PATH } from '../utils/access';

const DEFAULT_SITE_TITLE = 'Notes';
const DEFAULT_PANEL_WIDTH = 600;
const DEFAULT_FONT_FAMILY = '"Helvetica Neue", Arial, sans-serif';

/**
 * Whether the LLM chat feature should render for this profile: the author
 * enabled it AND the chat stack is deployed (its outputs supply the Knowledge
 * Base id behind the /api/chat behavior). Shared by renderIndexHtml (to gate the
 * {{CHAT_HTML}} markup slot) and renderConfigJson (to gate chatEnabled/chatPath)
 * so the DOM and the client config can never disagree.
 */
function isChatEnabled(profile: PublishingProfile): boolean {
	const chat = profile.infrastructureState?.chat;
	return !!(profile.chat?.enabled && chat?.enabled && chat.knowledgeBaseId);
}

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

/**
 * Where index.html loads its long-cached assets from. The plain names are the
 * defaults; renderSiteAssets() substitutes content-hashed names so a browser
 * holding an `immutable` copy can never keep running an old version.
 */
export interface SiteAssetPaths {
	stylesCss: string;
	flexsearchJs: string;
	vendorJs: string;
	appJs: string;
}

const PLAIN_ASSET_PATHS: SiteAssetPaths = {
	stylesCss: 'styles.css',
	flexsearchJs: 'flexsearch.min.js',
	vendorJs: 'vendor.js',
	appJs: 'app.js',
};

export function renderIndexHtml(
	profile: PublishingProfile,
	homeNoteUid?: string,
	customizations: AssetCustomization[] = [],
	paths: SiteAssetPaths = PLAIN_ASSET_PATHS,
): string {
	const custom = getCustomization(profile);

	let html = SITE_INDEX_TEMPLATE;
	html = html.replace('{{STYLES_CSS_PATH}}', paths.stylesCss);
	html = html.replace('{{FLEXSEARCH_JS_PATH}}', paths.flexsearchJs);
	html = html.replace('{{VENDOR_JS_PATH}}', paths.vendorJs);
	html = html.replace('{{APP_JS_PATH}}', paths.appJs);
	html = html.replace('{{SITE_TITLE}}', custom.siteTitle || DEFAULT_SITE_TITLE);
	html = html.replace('{{HEADER_LINKS_HTML}}', renderHeaderLinksHtml(custom.headerLinks, homeNoteUid));

	if (homeNoteUid) {
		html = html.replace('{{HOME_NOTE_UID_SCRIPT}}',
			`<script>window.__CPN_HOME_UID__ = "${homeNoteUid}";</script>`);
	} else {
		html = html.replace('{{HOME_NOTE_UID_SCRIPT}}', '');
	}

	// Chat launcher/panel markup — emitted only for chat-enabled profiles so a
	// disabled profile ships zero chat DOM (mirrors the {{HOME_NOTE_UID_SCRIPT}}
	// conditional slot above). The client's chatEnabled() gate is a second guard.
	html = html.replace('{{CHAT_HTML}}', isChatEnabled(profile) ? SITE_CHAT_HTML : '');

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
	// Also moves the narrow-panels breakpoint, `@media (max-width: 600px)`, so
	// panels go full-width exactly when the screen is narrower than one panel.
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

/**
 * Cognito Hosted UI authorize URL (Google IdP) with the site's `/auth/callback`
 * as redirect_uri, or undefined when the pool outputs or base URL are missing.
 * The client appends `state` (where to return after sign-in).
 */
function buildAuthLoginUrl(profile: PublishingProfile): string | undefined {
	const auth = profile.infrastructureState?.cognitoAuth;
	if (!auth?.hostedUiDomain || !auth.userPoolClientId || !profile.baseUrl) return undefined;
	const redirectUri = profile.baseUrl.replace(/\/+$/, '') + '/auth/callback';
	const params = new URLSearchParams({
		client_id: auth.userPoolClientId,
		response_type: 'code',
		scope: 'openid email profile',
		identity_provider: 'Google',
		redirect_uri: redirectUri,
	});
	return `${auth.hostedUiDomain}/oauth2/authorize?${params.toString()}`;
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
				// Arbitrary custom CSS (auto-scoped client-side to .cpn-style-<name>).
				// Gate on non-empty-after-trim so a stray '' (e.g. hand-edited data.json)
				// is dropped; a css-only style is still kept by the length guard below.
				if (typeof style.css === 'string' && style.css.trim()) entry.css = style.css;
			if (Object.keys(entry).length) styles[name] = entry;
		}
		if (Object.keys(styles).length) config.styles = styles;
	}

	// Per-note access groups (consumed by the note loader via window.__CPN_CONFIG__).
	// Emitted only when the site's edge fn actually enforces `/restricted/<group>/*`
	// and at least one group exists. Group NAMES are deliberately not listed here
	// (config.json is readable by every reader): the SPA asks the edge
	// `GET <accessWhoamiPath>` for the viewer's own groups instead.
	const accessGating = !!profile.accessGroups
		&& Object.keys(profile.accessGroups).length > 0
		&& canPublishGated(profile).ok;

	// Commenting + built-in auth (consumed by the comment client via
	// window.__CPN_CONFIG__). Only emitted when commenting is enabled and the
	// Cognito auth stack has been deployed (its outputs supply the login URL).
	const auth = profile.infrastructureState?.cognitoAuth;
	const commentsOn = !!(profile.commenting?.enabled && auth?.commentIdentity);
	if (commentsOn) {
		config.commentsEnabled = true;
		config.commentReadPath = '/comments/';
		config.commentWritePath = '/api/comments';
		config.commentMePath = '/api/me';
	}
	// The Hosted UI sign-in URL: for the comment box, and for readers of a public
	// site who need to sign in to see notes gated to their groups.
	const loginUrl = (commentsOn || accessGating) ? buildAuthLoginUrl(profile) : undefined;
	if (loginUrl) {
		config.authLoginUrl = loginUrl;
		if (commentsOn) {
			// True when the whole site (and thus comment reads) requires login —
			// i.e. the Cognito edge fn gates reads. Password/BYO/public reads do not.
			config.readGating = profile.infrastructureState?.readGateMode === 'cognito';
		}
	}

	if (accessGating) {
		config.accessGating = true;
		config.accessWhoamiPath = WHOAMI_PATH;
	}

	// LLM chat (consumed by the chat client via window.__CPN_CONFIG__). Emitted
	// only when chat is enabled AND the chat stack has been deployed (its outputs
	// supply the Function URL host behind the /api/chat behavior). The endpoint is
	// same-origin, so the client just needs the path; auth is inherited at the edge.
	if (isChatEnabled(profile)) {
		config.chatEnabled = true;
		config.chatPath = '/api/chat';
	}

	return JSON.stringify(config, null, '\t');
}

export function getFlexSearchJs(): string {
	return FLEXSEARCH_MIN_JS;
}

export function renderVendorJs(): string {
	return VENDOR_JS;
}

/** A site file to upload, relative to the site root (the profile's S3 prefix). */
export interface SiteAssetFile {
	name: string;
	body: string;
	contentType: string;
	cacheControl: string;
}

const IMMUTABLE = 'public, max-age=31536000, immutable';

async function shortHash(text: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest).slice(0, 6)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `app.js` + hash -> `app.<hash>.js` (`flexsearch.min.js` -> `flexsearch.min.<hash>.js`). */
function hashedName(name: string, hash: string): string {
	const dot = name.lastIndexOf('.');
	return `${name.slice(0, dot)}.${hash}${name.slice(dot)}`;
}

/**
 * Render every site file for a profile, in upload order. The long-cached
 * scripts and styles get content-hashed names, and index.html (no-cache)
 * references them, so a new version reaches readers on their next page load.
 * The hashed files come before index.html so it never points at a missing
 * file mid-upload.
 *
 * `fingerprint` identifies this exact set of files (config.json excluded: it
 * is refreshed on every publish anyway). Publishing compares it with the last
 * push to decide whether the site code needs re-uploading.
 */
export async function renderSiteAssets(
	profile: PublishingProfile,
	homeNoteUid?: string,
	customizations: AssetCustomization[] = [],
): Promise<{ files: SiteAssetFile[]; fingerprint: string }> {
	const longCached = {
		stylesCss: { name: 'styles.css', body: renderStylesCss(profile, customizations), contentType: 'text/css' },
		flexsearchJs: { name: 'flexsearch.min.js', body: getFlexSearchJs(), contentType: 'application/javascript' },
		vendorJs: { name: 'vendor.js', body: renderVendorJs(), contentType: 'application/javascript' },
		appJs: { name: 'app.js', body: renderAppJs(), contentType: 'application/javascript' },
	};
	const files: SiteAssetFile[] = [];
	const paths = { ...PLAIN_ASSET_PATHS };
	for (const key of Object.keys(longCached) as Array<keyof SiteAssetPaths>) {
		const asset = longCached[key];
		const name = hashedName(asset.name, await shortHash(asset.body));
		paths[key] = name;
		files.push({ name, body: asset.body, contentType: asset.contentType, cacheControl: IMMUTABLE });
	}
	files.push({ name: 'index.html', body: renderIndexHtml(profile, homeNoteUid, customizations, paths), contentType: 'text/html', cacheControl: 'no-cache' });
	const fingerprint = await shortHash(files.map((f) => `${f.name}\n${f.body}`).join('\n'));
	files.push({ name: 'config.json', body: renderConfigJson(profile, homeNoteUid), contentType: 'application/json', cacheControl: 'no-cache' });
	return { files, fingerprint };
}
