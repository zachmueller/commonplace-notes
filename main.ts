import { Plugin, TFile, WorkspaceLeaf, FileView } from 'obsidian';

export default class CommonPlaceNotesPlugin extends Plugin {
	async onload() {
		console.log('CommonPlaceNotesPlugin: Loading plugin');

		// Update all open file titles on startup
		this.app.workspace.onLayoutReady(() => {
			console.log('CommonPlaceNotesPlugin: Layout ready, updating all open files');
			this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
				if (leaf.view instanceof FileView) {
					const file = leaf.view.file;
					if (file instanceof TFile) {
						console.log('CommonPlaceNotesPlugin: updating initial view', file.path);
						this.updateTitlesForFile(file);
					}
				}
			});
		});

		// Patch the file title display
		this.registerEvent(
			this.app.workspace.on('file-open', (file: TFile | null) => {
				console.log('CommonPlaceNotesPlugin: file-open event triggered', file?.path);
				if (file instanceof TFile) {
					this.updateTitlesForFile(file);
				}
			})
		);

		// Update upon edits made to frontmatter properties
		this.registerEvent(
			this.app.metadataCache.on('resolved', () => {
				console.log('CommonPlaceNotesPlugin: metadata resolved event');
				const activeFile = this.app.workspace.getActiveFile();
				console.log('CommonPlaceNotesPlugin: active file:', activeFile?.path);
				if (activeFile) {
					const metadata = this.app.metadataCache.getFileCache(activeFile);
					console.log('CommonPlaceNotesPlugin: resolved metadata:', metadata?.frontmatter);
					this.updateTitlesForFile(activeFile);
				}
			})
		);

		// Register for layout changes
		this.registerLayoutEvents();
	}

	private updateTitlesForFile(file: TFile) {
		const metadata = this.app.metadataCache.getFileCache(file);
		const customTitle = metadata?.frontmatter?.title;
		// fall back to using the basename when the custom title doesn't exist
		const displayTitle = customTitle || file.basename;

		console.log('CommonPlaceNotesPlugin: updating titles for file', file.path);

		// Find all leaves containing this file
		this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
			if (leaf.view instanceof FileView && leaf.view.file?.path === file.path) {
				console.log('CommonPlaceNotesPlugin: updating leaf for file', file.path);
				
				// Update view header title
				const viewHeader = leaf.view.containerEl.querySelector('.view-header-title');
				if (viewHeader instanceof HTMLElement) {
					console.log('CommonPlaceNotesPlugin: updating view header from', viewHeader.textContent, 'to', displayTitle);
					viewHeader.textContent = displayTitle;
				}

				// Update inline title
				const inlineTitle = leaf.view.containerEl.querySelector('.inline-title');
				if (inlineTitle instanceof HTMLElement) {
					console.log('CommonPlaceNotesPlugin: updating inline title from', inlineTitle.textContent, 'to', displayTitle);
					inlineTitle.textContent = displayTitle;
				}

				// Update tab header
				const tabHeaders = document.querySelectorAll(
					`.workspace-tab-header[aria-label="${file.basename}"] .workspace-tab-header-inner-title`
				);
				console.log(tabHeaders);
				tabHeaders.forEach(element => {
					if (element instanceof HTMLElement) {
						const currentText = element.textContent;
						console.log('CommonPlaceNotesPlugin: updating inline title from', currentText, 'to', displayTitle);
						element.textContent = displayTitle;
					}
				});
			}
		});

		// Inject the custom title into the alias cache if it exists and differs from basename
		if (customTitle && customTitle !== file.basename) {
			// Get the current cache
			console.log(`Modifying the cache for ${displayTitle} (${file.basename})`);
			const currentCache = this.app.metadataCache.getCache(file.path);
			console.log(currentCache);

			if (currentCache) {
				// Create or update the frontmatter aliases array
				const aliases = currentCache.frontmatter?.aliases || [];
				if (Array.isArray(aliases)) {
					// Add the custom title if it's not already in aliases
					if (!aliases.includes(customTitle)) {
						aliases.push(customTitle);

						// Update the cache with the new aliases
						currentCache.frontmatter = {
							...(currentCache.frontmatter || {}),
							aliases: aliases
						};

						// Force a cache update
						this.app.metadataCache.trigger("changed", file);
					}
				}
			}
		}
	}

	private registerLayoutEvents() {
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				console.log('CommonPlaceNotesPlugin: layout-change event');
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile) {
					this.updateTitlesForFile(activeFile);
				}
			})
		);
	}
}