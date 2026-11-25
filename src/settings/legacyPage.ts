import { SettingPage } from 'obsidian';

/**
 * Adapter page that runs one of the pre-declarative imperative renderers
 * unchanged (spec phases P1–P4). Obsidian does not refresh custom pages on
 * `update()` and does not index their contents for search, so each adapter is
 * replaced by declarative items as its area is converted.
 */
export class LegacyPage extends SettingPage {
	constructor(
		private readonly renderBody: (containerEl: HTMLElement, page: LegacyPage) => void,
		/** Tells the tab which adapter is on screen, so `refresh()` can redraw it. */
		private readonly onShown: (page: LegacyPage, shown: boolean) => void,
	) {
		super();
	}

	display(): void {
		this.containerEl.empty();
		this.onShown(this, true);
		this.renderBody(this.containerEl, this);
	}

	hide(): void {
		this.onShown(this, false);
		super.hide();
	}
}
