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
			window.clearInterval(interval);
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
				window.setTimeout(() => notice.hide(), 4000);
			} else {
				notice.hide();
			}

			return { success: true, result };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			// Stop animation and update notice with error message
			this.stopLoadingAnimation(notice);
			Logger.error(err.message);
			if (errorMessage) {
				notice.setMessage(`❌ ${errorMessage}`);
				window.setTimeout(() => notice.hide(), 8000);
			} else {
				notice.setMessage(`❌ Error: ${err.message}`);
				window.setTimeout(() => notice.hide(), 8000);
			}

			Logger.error('Operation failed:', err);
			return { success: false, error: err };
		}
	}

	static async showProgressWithCounter<T>(
		baseMessage: string,
		total: number,
		executor: (updateProgress: (current: number) => void) => Promise<T>,
		successMessage?: string,
		errorMessage?: string
	): Promise<{ success: boolean; result?: T; error?: Error }> {
		const notice = new Notice(`${baseMessage} (0/${total})`, 0);
		this.startLoadingAnimation(notice, `${baseMessage} (0/${total})`);

		const updateProgress = (current: number) => {
			const msg = `${baseMessage} (${current}/${total})`;
			this.stopLoadingAnimation(notice);
			this.startLoadingAnimation(notice, msg);
		};

		try {
			const result = await executor(updateProgress);

			this.stopLoadingAnimation(notice);
			if (successMessage) {
				notice.setMessage(`✓ ${successMessage}`);
				window.setTimeout(() => notice.hide(), 4000);
			} else {
				notice.hide();
			}

			return { success: true, result };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.stopLoadingAnimation(notice);
			Logger.error(err.message);
			if (errorMessage) {
				notice.setMessage(`❌ ${errorMessage}`);
				window.setTimeout(() => notice.hide(), 8000);
			} else {
				notice.setMessage(`❌ Error: ${err.message}`);
				window.setTimeout(() => notice.hide(), 8000);
			}

			Logger.error('Operation failed:', err);
			return { success: false, error: err };
		}
	}

	static cleanup() {
		for (const [notice, interval] of this.animationIntervals) {
			window.clearInterval(interval);
			notice.hide();
		}
		this.animationIntervals.clear();
	}
}