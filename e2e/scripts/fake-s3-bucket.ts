/**
 * An in-memory S3 bucket for unit tests of the attachment cleanup code
 * (test-attachments.ts, test-attachment-state.ts). Supports what
 * src/publish/attachmentS3.ts sends: ListObjectsV2 (Prefix, Delimiter,
 * paging), GetObject, DeleteObjects (with injected per-key errors or a failed
 * call). Pages are small so paging is exercised.
 */

export interface FakeBucketOptions {
	/** Keys DeleteObjects reports as per-key errors. */
	failDeleteKeys?: Set<string>;
	/** Make every DeleteObjects call throw. */
	failDeleteCall?: boolean;
	/** Make every call of this command throw (e.g. 'ListObjectsV2Command'). */
	failCommand?: string;
	/** ListObjectsV2 page size. */
	pageSize?: number;
}

export function fakeBucket(objects: Record<string, string>, opts: FakeBucketOptions = {}) {
	const store = new Map(Object.entries(objects));
	const calls: Array<{ name: string; input: any }> = [];
	const pageSize = opts.pageSize ?? 2;
	const send = async (cmd: any): Promise<any> => {
		const name: string = cmd.constructor.name;
		const input = cmd.input;
		calls.push({ name, input });
		if (opts.failCommand === name) {
			const err: any = new Error(`${name} failed`);
			err.name = 'NetworkingError';
			throw err;
		}
		switch (name) {
			case 'ListObjectsV2Command': {
				const prefix: string = input.Prefix ?? '';
				const keys = [...store.keys()].filter(k => k.startsWith(prefix)).sort();
				if (input.Delimiter) {
					const prefixes = [...new Set(keys
						.map(k => k.slice(prefix.length))
						.filter(rest => rest.includes(input.Delimiter))
						.map(rest => prefix + rest.slice(0, rest.indexOf(input.Delimiter) + 1)))].sort();
					return { CommonPrefixes: prefixes.map(Prefix => ({ Prefix })), KeyCount: prefixes.length, IsTruncated: false };
				}
				const max = Math.min(input.MaxKeys ?? pageSize, pageSize);
				const start = input.ContinuationToken ? Number(input.ContinuationToken) : 0;
				const page = keys.slice(start, start + max);
				const more = start + max < keys.length;
				return {
					Contents: page.map(Key => ({ Key })),
					KeyCount: page.length,
					IsTruncated: more,
					NextContinuationToken: more ? String(start + max) : undefined,
				};
			}
			case 'GetObjectCommand': {
				const body = store.get(input.Key);
				if (body === undefined) {
					const err: any = new Error('NoSuchKey');
					err.name = 'NoSuchKey';
					err.$metadata = { httpStatusCode: 404 };
					throw err;
				}
				return { Body: { transformToString: async () => body } };
			}
			case 'DeleteObjectsCommand': {
				if (opts.failDeleteCall) throw new Error('DeleteObjects failed');
				const Errors: any[] = [];
				for (const { Key } of input.Delete.Objects) {
					if (opts.failDeleteKeys?.has(Key)) Errors.push({ Key, Code: 'AccessDenied', Message: 'denied' });
					else store.delete(Key);
				}
				return Errors.length ? { Errors } : {};
			}
			default:
				return {};
		}
	};
	return { send, store, calls } as any as {
		send: (cmd: any) => Promise<any>;
		store: Map<string, string>;
		calls: Array<{ name: string; input: any }>;
	};
}
