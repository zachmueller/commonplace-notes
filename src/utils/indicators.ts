import { WorkspaceLeaf, TFile, MarkdownView } from 'obsidian';
import CommonplaceNotesPlugin from '../main';
import { PublishingProfile } from '../types';
import { Logger } from './logging';

export class IndicatorManager {
	private plugin: CommonplaceNotesPlugin;
	private indicators: Map<string, HTMLElement[]> = new Map();

	constructor(plugin: CommonplaceNotesPlugin) {
		this.plugin = plugin;
	}

	async updateAllVisibleIndicators() {
		// Update indicators for all visible markdown files
		this.plugin.app.workspace.iterateAllLeaves(leaf => {
			if (leaf.view.getViewType() === 'markdown') {
				const view = leaf.view as MarkdownView;
				const file = view.file;
				if (file) {
					this.updateIndicators(file);
				}
			}
		});
	}

	async updateIndicators(file: TFile | null) {
		try {
			Logger.debug(`Starting indicator update for file: ${file?.path}`);
			
			// Clear existing indicators for this file only
			this.clearIndicatorsForFile(file);

			if (!file) {
				Logger.debug('No file to update indicators for');
				return;
			}

			// Get publishing contexts and filter profiles as before
			const contexts = await this.plugin.publisher.getPublishContextsForFile(file);
			if (!contexts || contexts.length === 0) {
				Logger.debug(`No publishing contexts for ${file.path}`);
				return;
			}

			const profiles = this.plugin.settings.publishingProfiles
				.filter(profile => {
					const isExcluded = this.plugin.publisher.isFileExcluded(file, profile);
					const isInContext = contexts.includes(profile.id);
					return !isExcluded && isInContext;
				});

			if (profiles.length === 0) {
				Logger.debug(`No valid profiles for ${file.path}`);
				return;
			}

			// Update both locations for this specific file
			await this.updateTitleIndicators(file, profiles);
			await this.updateTabIndicators(file, profiles);

		} catch (error) {
			Logger.error(`Error updating indicators for ${file?.path}:`, error);
		}
	}

	private createIndicator(profile: PublishingProfile): HTMLElement | null {
		if (!profile.indicator) {
			Logger.debug(`No indicator settings for profile ${profile.name}`);
			return null;
		}

		const indicator = document.createElement('div');
		indicator.addClass('cpn-publish-indicator');
		
		if (profile.indicator.style === 'color') {
			indicator.style.backgroundColor = profile.indicator.color || '#000000';
			indicator.style.width = '12px';
			indicator.style.height = '12px';
			indicator.style.display = 'inline-block';
			indicator.style.marginRight = '4px';
			indicator.style.borderRadius = '2px';
		} else {
			indicator.setText(profile.indicator.emoji || '📝');
			indicator.style.marginRight = '4px';
		}

		// Add tooltip
		indicator.setAttribute('aria-label', `Published to: ${profile.name}`);
		indicator.addClass('cpn-tooltip');

		return indicator;
	}

	private clearIndicatorsForFile(file: TFile | null) {
		if (!file) return;

		// Clear indicators from title
		const titleParentEl = this.getTitleElementForFile(file);
		if (titleParentEl) {
			titleParentEl.querySelectorAll('.cpn-publish-indicators').forEach(el => el.remove());
		}

		// Clear indicators from tab
		const tabHeader = this.getTabHeader(file);
		if (tabHeader) {
			tabHeader.querySelectorAll('.cpn-publish-indicators').forEach(el => el.remove());
		}
	}

	private createIndicatorContainer(profiles: PublishingProfile[]): HTMLElement {
		const container = document.createElement('div');
		container.addClass('cpn-publish-indicators');

		profiles.forEach(profile => {
			const indicator = this.createIndicator(profile);
			if (indicator) {
				container.appendChild(indicator);
			}
		});

		return container;
	}

	private getTitleElementForFile(file: TFile): HTMLElement | null {
		// Find all markdown views
		const markdownViews = this.plugin.app.workspace.getLeavesOfType('markdown')
			.map(leaf => leaf.view)
			.filter((view): view is MarkdownView => view instanceof MarkdownView);

		// Find the view for our specific file
		const targetView = markdownViews.find(view => view.file?.path === file.path);
		
		if (!targetView) {
			Logger.debug(`Could not find view for file: ${file.path}`);
			return null;
		}

		const titleParentEl = targetView.containerEl.querySelector('.view-header-title-parent');
		if (!titleParentEl) {
			Logger.debug(`Could not find title parent element in view for: ${file.path}`);
			return null;
		}

		return titleParentEl as HTMLElement;
	}

	private async updateTitleIndicators(file: TFile, profiles: PublishingProfile[]) {
		// Find title element specifically for this file
		const titleParentEl = this.getTitleElementForFile(file);
		if (!titleParentEl) {
			Logger.debug(`Could not find title parent element for ${file.path}`);
			return;
		}

		const container = this.createIndicatorContainer(profiles);
		titleParentEl.insertBefore(container, titleParentEl.firstChild);
		Logger.debug(`Added title indicators for ${file.path}`);
	}

	private async updateTabIndicators(file: TFile, profiles: PublishingProfile[]) {
		const tabHeader = this.getTabHeader(file);
		if (!tabHeader) {
			Logger.debug(`Could not find tab header for ${file.path}`);
			return;
		}

		const container = this.createIndicatorContainer(profiles);
		container.addClass('cpn-tab-indicators');
		tabHeader.appendChild(container);
		Logger.debug(`Added tab indicators for ${file.path}`);
	}

	private getTabHeader(file: TFile): HTMLElement | null {
		// Find all tab headers
		const tabHeaders = document.querySelectorAll('.workspace-tab-header-inner');
		
		// Look for the one matching our file
		for (const header of Array.from(tabHeaders)) {
			const titleEl = header.querySelector('.workspace-tab-header-inner-title');
			if (titleEl && titleEl.textContent === file.basename) {
				return header as HTMLElement;
			}
		}

		return null;
	}
}