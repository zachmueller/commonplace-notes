import { Notice } from 'obsidian';
import { Logger } from './logging';

export class NoticeManager {
	private static activeNotices: Map<string, Notice> = new Map();
	private static animationIntervals: Map<Notice, number> = new Map();
	private static readonly spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

	static showNotice(message: string, duration?: number): Notice {
		const notice = new Notice(message, duration);
		return notice;
	}

	private static startLoadingAnimation(notice: Notice, baseMessage: string) {
		let frameIndex = 0;
		const interval = window.setInterval(() => {
			frameIndex = (frameIndex + 1) % this.spinnerFrames.length;
			const spinner = this.spinnerFrames[frameIndex];
			notice.setMessage(`${spinner} ${baseMessage}`);
		}, 100);

		this.animationIntervals.set(notice, interval);
	}

	private static stopLoadingAnimation(notice: Notice) {
		const interval = this.animationIntervals.get(notice);
		if (interval) {
			clearInterval(interval);
			this.animationIntervals.delete(notice);
		}
	}

	static async showProgress<T>(
		initialMessage: string,
		promise: Promise<T>,
		successMessage?: string,
		errorMessage?: string
	): Promise<{ success: boolean; result?: T; error?: Error }> {
		const notice = new Notice(initialMessage, 0);
		this.startLoadingAnimation(notice, initialMessage);

		try {
			const result = await promise;

			// Update notice with success message
			this.stopLoadingAnimation(notice);
			if (successMessage) {
				notice.setMessage(`✓ ${successMessage}`);
				setTimeout(() => notice.hide(), 4000);
			} else {
				notice.hide();
			}

			return { success: true, result };
		} catch (error) {
			// Stop animation and update notice with error message
			this.stopLoadingAnimation(notice);
			Logger.error(error.message);
			if (errorMessage) {
				notice.setMessage(`❌ ${errorMessage}`);
				setTimeout(() => notice.hide(), 8000);
			} else {
				notice.setMessage(`❌ Error: ${error.message}`);
				setTimeout(() => notice.hide(), 8000);
			}
			
			Logger.error('Operation failed:', error);
			return { success: false, error };
		}
	}

	static cleanup() {
		for (const [notice, interval] of this.animationIntervals) {
			clearInterval(interval);
			notice.hide();
		}
		this.animationIntervals.clear();
	}
}