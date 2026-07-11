import { App, SuggestModal, TFile } from 'obsidian';

export class HomeNoteSuggestModal extends SuggestModal<TFile> {
	private files: TFile[];
	private onChoose: (file: TFile) => void;

	constructor(app: App, files: TFile[], onChoose: (file: TFile) => void) {
		super(app);
		this.files = files;
		this.onChoose = onChoose;
		this.setPlaceholder('Search for a publishable note...');
	}

	getSuggestions(query: string): TFile[] {
		const lower = query.toLowerCase();
		return this.files.filter(f => f.path.toLowerCase().includes(lower));
	}

	renderSuggestion(file: TFile, el: HTMLElement) {
		el.createEl('div', { text: file.path });
	}

	onChooseSuggestion(file: TFile) {
		this.onChoose(file);
	}
}
