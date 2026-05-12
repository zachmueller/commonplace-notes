import { App, Modal, Notice, Setting } from 'obsidian';
import type { PublishingProfile } from '../types';
import type { CloudFormationManager } from './cloudFormationManager';

export class DnsAssistantModal extends Modal {
	private cfManager: CloudFormationManager;
	private profile: PublishingProfile;

	constructor(app: App, cfManager: CloudFormationManager, profile: PublishingProfile) {
		super(app);
		this.cfManager = cfManager;
		this.profile = profile;
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass('cpn-dns-modal');
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'DNS Validation Records' });

		const certArn = this.profile.infrastructureState?.certificateArn;
		if (!certArn) {
			contentEl.createEl('p', { text: 'No certificate ARN found for this profile.' });
			return;
		}

		const loadingEl = contentEl.createEl('p', { text: 'Loading validation records...' });

		try {
			const records = await this.cfManager.getCertificateValidationRecords(certArn, this.profile);
			loadingEl.remove();

			if (records.length === 0) {
				contentEl.createEl('p', { text: 'No validation records available yet. The certificate may still be initializing.' });
				return;
			}

			contentEl.createEl('p', {
				text: 'Add the following CNAME record(s) to your DNS provider:',
				cls: 'cpn-wizard-description',
			});

			for (const record of records) {
				const row = contentEl.createDiv({ cls: 'cpn-dns-record-row' });

				row.createEl('strong', { text: 'Name:' });
				row.createEl('code', { text: record.name });
				const copyNameBtn = row.createEl('button', { text: 'Copy', cls: 'cpn-copy-btn' });
				copyNameBtn.addEventListener('click', () => {
					navigator.clipboard.writeText(record.name);
					new Notice('Copied name!');
				});

				row.createEl('strong', { text: 'Value:' });
				row.createEl('code', { text: record.value });
				const copyValueBtn = row.createEl('button', { text: 'Copy', cls: 'cpn-copy-btn' });
				copyValueBtn.addEventListener('click', () => {
					navigator.clipboard.writeText(record.value);
					new Notice('Copied value!');
				});
			}

			const statusEl = contentEl.createDiv({ cls: 'cpn-dns-status' });

			new Setting(contentEl)
				.addButton(btn => btn
					.setButtonText('Check Certificate Status')
					.setCta()
					.onClick(async () => {
						const status = await this.cfManager.checkCertificateStatus(certArn, this.profile);
						if (status === 'ISSUED') {
							statusEl.setText('Certificate is issued and valid.');
							statusEl.addClass('cpn-event-success');
						} else {
							statusEl.setText(`Certificate status: ${status}`);
						}
					}))
				.addButton(btn => btn
					.setButtonText('Close')
					.onClick(() => this.close()));
		} catch (err: any) {
			loadingEl.remove();
			contentEl.createEl('p', { text: `Error: ${err.message}`, cls: 'cpn-wizard-error' });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
