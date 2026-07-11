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

/**
 * Append one CloudFormation event as a styled line in a live event log,
 * colouring failures red and completions green. Shared by the deploy/destroy/
 * force-clean flows so the styling logic lives in one place.
 */
export function appendStackEventLine(logEl: HTMLElement, event: { logicalResourceId: string; status: string }): void {
	const line = logEl.createDiv({ cls: 'cpn-wizard-event-line' });
	if (event.status.includes('FAILED') || event.status.includes('ROLLBACK')) {
		line.addClass('cpn-event-error');
	} else if (event.status.includes('COMPLETE')) {
		line.addClass('cpn-event-success');
	}
	line.setText(`${event.logicalResourceId} - ${event.status}`);
}
