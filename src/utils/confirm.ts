import { App, ConfirmationModal } from 'obsidian';

export interface DestructiveConfirmOptions {
	title: string;
	/** Body text explaining what the action does. */
	body: string;
	/** Label of the destructive primary button, e.g. "Destroy". */
	confirmText: string;
	/** Optional opt-in checkbox (default off), e.g. "Also delete S3 data". */
	checkbox?: string;
}

export interface DestructiveConfirmResult {
	confirmed: boolean;
	/** State of the opt-in checkbox; always false when none was shown. */
	checked: boolean;
}

/**
 * ConfirmationModal that reports how it was dismissed. Buttons close the modal
 * after their handler runs, so the result is recorded in the handler and
 * delivered from onClose, which also covers Escape and the close button.
 */
class DestructiveConfirmModal extends ConfirmationModal {
	confirmed = false;
	checked = false;

	constructor(app: App, opts: DestructiveConfirmOptions, private onDone: (r: DestructiveConfirmResult) => void) {
		super(app);
		this.setTitle(opts.title);
		this.setContent(opts.body);
		if (opts.checkbox) {
			this.addCheckbox(opts.checkbox, (value: boolean) => { this.checked = value; });
		}
		this.addCancelButton();
		this.addButton(btn => btn
			.setButtonText(opts.confirmText)
			.setDestructive()
			.setCta()
			.onClick(() => { this.confirmed = true; }));
	}

	onClose(): void {
		super.onClose();
		this.onDone({ confirmed: this.confirmed, checked: this.confirmed && this.checked });
	}
}

/**
 * Ask the user to confirm a destructive action. Resolves `confirmed: true`
 * only when the destructive button was clicked.
 */
export function confirmDestructive(app: App, opts: DestructiveConfirmOptions): Promise<DestructiveConfirmResult> {
	return new Promise(resolve => {
		new DestructiveConfirmModal(app, opts, resolve).open();
	});
}
