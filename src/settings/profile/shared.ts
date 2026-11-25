import { PublishingProfile } from '../../types';

/**
 * Ensure a profile has an `awsSettings` object with sane defaults. Shared by the
 * AWS destination/auth renderers and the import-stack modal, all of which read
 * or mutate `profile.awsSettings` and must not hit `undefined`.
 */
export function initAWSSettings(profile: PublishingProfile): void {
	if (!profile.awsSettings) {
		profile.awsSettings = {
			awsAccountId: '',
			awsProfile: '',
			region: '',
			bucketName: '',
			cloudFrontInvalidationScheme: 'individual',
			credentialMode: 'sdk',
			credentialRefreshCommands: '',
			awsCliPath: ''
		};
	}
}

/** A rendered event-log line: text plus an optional status class. */
export interface LogLine {
	text: string;
	cls?: 'cpn-event-error' | 'cpn-event-success';
}

/** One CloudFormation event as a log line: failures red, completions green. */
export function stackEventLine(event: { logicalResourceId: string; status: string }): LogLine {
	const text = `${event.logicalResourceId} - ${event.status}`;
	if (event.status.includes('FAILED') || event.status.includes('ROLLBACK')) return { text, cls: 'cpn-event-error' };
	if (event.status.includes('COMPLETE')) return { text, cls: 'cpn-event-success' };
	return { text };
}

/** Append a line to a live event log and keep the newest line in view. */
export function appendLogLine(logEl: HTMLElement, line: LogLine): void {
	const el = logEl.createDiv({ cls: 'cpn-wizard-event-line' });
	if (line.cls) el.addClass(line.cls);
	el.setText(line.text);
	logEl.scrollTop = logEl.scrollHeight;
}

/**
 * Append one CloudFormation event as a styled line in a live event log.
 * Shared by the deploy/destroy/force-clean flows so the styling logic lives
 * in one place.
 */
export function appendStackEventLine(logEl: HTMLElement, event: { logicalResourceId: string; status: string }): void {
	appendLogLine(logEl, stackEventLine(event));
}
