import { appendLogLine, LogLine, stackEventLine } from './shared';

interface LiveOp {
	running: boolean;
	lines: LogLine[];
	listeners: Set<() => void>;
}

/**
 * State of the long-running settings actions (Cognito upgrade, session
 * length, bucket cleanup, destroy, force-clean), kept outside the rows that
 * start them. Declarative rows are torn down and rebuilt on every `update()`,
 * so a row re-attaches to its operation on render: the log keeps its lines and
 * the button stays disabled until the operation ends.
 *
 * Keys are per profile and action, e.g. `${profileRef}:destroy`.
 */
class LiveOps {
	private ops = new Map<string, LiveOp>();

	private op(key: string): LiveOp {
		let op = this.ops.get(key);
		if (!op) {
			op = { running: false, lines: [], listeners: new Set() };
			this.ops.set(key, op);
		}
		return op;
	}

	isRunning(key: string): boolean {
		return this.ops.get(key)?.running ?? false;
	}

	/**
	 * Run `task`, streaming its CloudFormation events into the operation's log.
	 * Resolves or rejects with the task; the operation is marked done either way.
	 */
	async run<T>(key: string, task: (onEvent: (event: { logicalResourceId: string; status: string }) => void) => Promise<T>): Promise<T> {
		const op = this.op(key);
		op.running = true;
		op.lines = [];
		this.notify(op);
		try {
			return await task(event => {
				op.lines.push(stackEventLine(event));
				this.notify(op);
			});
		} finally {
			op.running = false;
			this.notify(op);
		}
	}

	/**
	 * Show the operation's log in `logEl` (hidden while empty) and call
	 * `onChange(running)` now and whenever it changes. Returns the cleanup for a
	 * `render` row.
	 */
	mount(key: string, logEl: HTMLElement, onChange: (running: boolean) => void): () => void {
		const op = this.op(key);
		let shown = 0;
		const sync = () => {
			if (op.lines.length < shown) {
				logEl.empty();
				shown = 0;
			}
			for (; shown < op.lines.length; shown++) appendLogLine(logEl, op.lines[shown]);
			logEl.toggle(op.lines.length > 0);
			onChange(op.running);
		};
		op.listeners.add(sync);
		sync();
		return () => { op.listeners.delete(sync); };
	}

	private notify(op: LiveOp): void {
		for (const listener of op.listeners) listener();
	}
}

/** Shared for the plugin's lifetime, so operations outlive settings re-renders. */
export const liveOps = new LiveOps();
