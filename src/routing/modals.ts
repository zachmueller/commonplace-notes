/**
 * Interactive modals for the routing runner: the option suggester and the
 * title-input prompt. Modeled on the existing `SuggestModal` subclasses in
 * `settings.ts` / `publisher.ts` and the inline confirm `Modal`s in `main.ts`.
 */

import { App, Modal, Setting, SuggestModal } from 'obsidian';
import type { RoutingOptionDefinition } from './types';

/** Fuzzy-ish suggester over routing options, showing name + description. */
export class RoutingOptionSuggestModal extends SuggestModal<RoutingOptionDefinition> {
	private options: RoutingOptionDefinition[];
	private onChoose: (option: RoutingOptionDefinition | null) => void;
	private resolved = false;

	constructor(
		app: App,
		options: RoutingOptionDefinition[],
		onChoose: (option: RoutingOptionDefinition | null) => void,
	) {
		super(app);
		this.options = options;
		this.onChoose = onChoose;
		this.setPlaceholder('Select a routing option…');
	}

	getSuggestions(query: string): RoutingOptionDefinition[] {
		const q = query.toLowerCase();
		return this.options.filter(
			(o) =>
				o.name.toLowerCase().includes(q) ||
				(o.description ?? '').toLowerCase().includes(q),
		);
	}

	renderSuggestion(option: RoutingOptionDefinition, el: HTMLElement) {
		el.createEl('div', { text: option.name + (option.degraded ? ' ⚠️' : '') });
		if (option.description) {
			el.createEl('small', { text: option.description, cls: 'cpn-routing-option-desc' });
		}
	}

	onChooseSuggestion(option: RoutingOptionDefinition) {
		this.resolved = true;
		this.onChoose(option);
	}

	onClose() {
		super.onClose();
		// Obsidian's SuggestModal.selectSuggestion calls close() BEFORE
		// onChooseSuggestion (verified against obsidian.asar), so on a real pick
		// `resolved` is still false here. Defer the dismiss-resolve one tick so a
		// pending onChooseSuggestion sets `resolved` first; only a genuine Esc /
		// click-away (no onChooseSuggestion) then resolves null.
		window.setTimeout(() => {
			if (!this.resolved) this.onChoose(null);
		}, 0);
	}
}

/** Single-field text prompt for a note title. Resolves null on cancel/dismiss. */
export class TitlePromptModal extends Modal {
	private value: string;
	private onSubmit: (title: string | null) => void;
	private resolved = false;

	constructor(app: App, initialValue: string, onSubmit: (title: string | null) => void) {
		super(app);
		this.value = initialValue;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Title for note' });

		new Setting(contentEl).addText((text) => {
			text.setValue(this.value);
			text.setPlaceholder('Note title');
			text.onChange((v) => (this.value = v));
			// Submit on Enter.
			text.inputEl.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					this.submit();
				}
			});
			// Focus + select for quick overwrite of "Untitled".
			window.setTimeout(() => {
				text.inputEl.focus();
				text.inputEl.select();
			}, 0);
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText('Set title')
					.setCta()
					.onClick(() => this.submit()),
			)
			.addButton((btn) => btn.setButtonText('Skip').onClick(() => this.close()));
	}

	private submit() {
		this.resolved = true;
		const trimmed = this.value.trim();
		this.onSubmit(trimmed === '' ? null : trimmed);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
		if (!this.resolved) this.onSubmit(null);
	}
}
