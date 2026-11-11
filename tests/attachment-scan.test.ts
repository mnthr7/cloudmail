import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { scanPending } from '../src/lib/server/attachment-scan';
import { createVirusTotal } from '../src/lib/server/virus-total';

const SCHEMA = `
CREATE TABLE users (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL
);
CREATE TABLE emails (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL
);
CREATE TABLE email_attachments (
	id TEXT PRIMARY KEY,
	email_id TEXT NOT NULL,
	filename TEXT NOT NULL,
	scan_status TEXT NOT NULL,
	vt_analysis_id TEXT,
	scan_malicious INTEGER,
	created_at TEXT NOT NULL,
	storage_key TEXT
);
`;

type AttachmentRecord = {
	id: string;
	scan_status: string;
	vt_analysis_id: string | null;
	scan_malicious: number | null;
};

type RecordedCall = {
	method: 'getAnalysis' | 'getFile' | 'upload';
	id: string;
};

const FILE_BYTES = new Uint8Array([1, 2, 3, 4]);
const FILE_HASH = createHash('sha256').update(FILE_BYTES).digest('hex');

function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec(SCHEMA);
	sqlite.run(`INSERT INTO users (id, email) VALUES ('user-1', 'ada@login.test')`);
	sqlite.run(`INSERT INTO emails (id, user_id) VALUES ('mail-1', 'user-1')`);
	return { sqlite, db: adapt(sqlite) };
}

function adapt(sqlite: Database): D1Database {
	return {
		prepare(sql: string) {
			return {
				bind(...params: unknown[]) {
					const values = params.map((value) => (value === undefined ? null : value));
					return {
						async all() {
							const results = sqlite.query(sql).all(...(values as never[]));
							return { results, success: true, meta: {} };
						},
						async run() {
							const info = sqlite.run(sql, values as never[]);
							return { success: true, meta: { changes: info.changes } };
						},
						async first() {
							return sqlite.query(sql).get(...(values as never[])) ?? null;
						}
					};
				}
			};
		}
	} as unknown as D1Database;
}

function addAttachment(
	sqlite: Database,
	row: {
		id: string;
		scanStatus: string;
		analysisId?: string | null;
		malicious?: number | null;
		createdAt: string;
		filename?: string;
		storageKey?: string | null;
		emailId?: string;
	}
) {
	sqlite.run(
		`INSERT INTO email_attachments (
			id, email_id, filename, scan_status, vt_analysis_id, scan_malicious, created_at, storage_key
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.emailId ?? 'mail-1',
			row.filename ?? `${row.id}.txt`,
			row.scanStatus,
			row.analysisId ?? null,
			row.malicious ?? null,
			row.createdAt,
			row.storageKey === undefined ? `objects/${row.id}` : row.storageKey
		]
	);
}

function attachment(sqlite: Database, id: string): AttachmentRecord {
	const stored = sqlite
		.query(
			`SELECT id, scan_status, vt_analysis_id, scan_malicious FROM email_attachments WHERE id = ?`
		)
		.get(id) as AttachmentRecord | null;
	if (!stored) throw new Error(`missing attachment ${id}`);
	return stored;
}

function bucketOf(bytes: Uint8Array): R2Bucket {
	return {
		async get() {
			const copy = new Uint8Array(bytes);
			return {
				async arrayBuffer() {
					return copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength);
				}
			};
		}
	} as unknown as R2Bucket;
}

function recorder(impl: {
	getAnalysis?: (id: string) =>
		| { status: 'completed'; malicious: number }
		| { status: 'pending' }
		| { error: 'rate-limit' | 'other' };
	getFile?: (hash: string) =>
		| { found: false }
		| { found: true; malicious: number }
		| { error: 'rate-limit' | 'other' };
	upload?: (filename: string, bytes: Uint8Array) => { analysisId: string } | { error: 'rate-limit' | 'other' };
}) {
	const calls: RecordedCall[] = [];
	return {
		calls,
		async getAnalysis(id: string) {
			calls.push({ method: 'getAnalysis', id });
			if (!impl.getAnalysis) throw new Error(`unexpected getAnalysis ${id}`);
			return impl.getAnalysis(id);
		},
		async getFile(hash: string) {
			calls.push({ method: 'getFile', id: hash });
			if (!impl.getFile) throw new Error(`unexpected getFile ${hash}`);
			return impl.getFile(hash);
		},
		async upload(bytes: Uint8Array, filename: string) {
			calls.push({ method: 'upload', id: filename });
			if (!impl.upload) throw new Error(`unexpected upload ${filename}`);
			return impl.upload(filename, bytes);
		}
	};
}

const thresholdOfOne = async () => 1;

describe('scanPending', () => {
	test('a completed analysis with zero malicious engines is clean at threshold 1', async () => {
		const { sqlite, db } = open();
		addAttachment(sqlite, {
			id: 'file-1',
			scanStatus: 'pending',
			analysisId: 'analysis-1',
			createdAt: '2026-01-01T00:00:00.000Z'
		});
		const client = recorder({
			getAnalysis: () => ({ status: 'completed', malicious: 0 })
		});
		const seen: unknown[][] = [];

		await scanPending(db, bucketOf(FILE_BYTES), client, async (...args) => {
			seen.push(args);
			return 1;
		});

		const row = attachment(sqlite, 'file-1');
		expect(row.scan_status).toBe('clean');
		expect(row.scan_malicious).toBe(0);
		expect(row.vt_analysis_id).toBeNull();
		expect(client.calls).toEqual([{ method: 'getAnalysis', id: 'analysis-1' }]);
		expect(seen).toEqual([[db, 'user-1']]);
	});

	test('malicious 1 at threshold 1 is infected and stores the count', async () => {
		const { sqlite, db } = open();
		addAttachment(sqlite, {
			id: 'file-1',
			scanStatus: 'pending',
			analysisId: 'analysis-1',
			createdAt: '2026-01-01T00:00:00.000Z'
		});
		const client = recorder({
			getAnalysis: () => ({ status: 'completed', malicious: 1 })
		});

		await scanPending(db, bucketOf(FILE_BYTES), client, thresholdOfOne);

		const row = attachment(sqlite, 'file-1');
		expect(row.scan_status).toBe('infected');
		expect(row.scan_malicious).toBe(1);
		expect(row.vt_analysis_id).toBeNull();
	});

	test('the threshold from readThreshold decides the verdict', async () => {
		const { sqlite, db } = open();
		addAttachment(sqlite, {
			id: 'below',
			scanStatus: 'pending',
			analysisId: 'analysis-below',
			createdAt: '2026-01-01T00:00:00.000Z'
		});
		addAttachment(sqlite, {
			id: 'at',
			scanStatus: 'pending',
			analysisId: 'analysis-at',
			createdAt: '2026-01-02T00:00:00.000Z'
		});
		const client = recorder({
			getAnalysis: (id) => ({ status: 'completed', malicious: id === 'analysis-at' ? 3 : 2 })
		});

		await scanPending(db, bucketOf(FILE_BYTES), client, async () => 3);

		expect(attachment(sqlite, 'below').scan_status).toBe('clean');
		expect(attachment(sqlite, 'below').scan_malicious).toBe(2);
		expect(attachment(sqlite, 'at').scan_status).toBe('infected');
		expect(attachment(sqlite, 'at').scan_malicious).toBe(3);
	});

	test('the fifth call is not made and that row stays pending', async () => {
		const { sqlite, db } = open();
		for (let index = 1; index <= 5; index += 1) {
			addAttachment(sqlite, {
				id: `file-${index}`,
				scanStatus: 'pending',
				analysisId: `analysis-${index}`,
				createdAt: `2026-01-0${index}T00:00:00.000Z`
			});
		}
		const client = recorder({
			getAnalysis: () => ({ status: 'completed', malicious: 0 })
		});

		await scanPending(db, bucketOf(FILE_BYTES), client, thresholdOfOne);

		expect(client.calls).toHaveLength(4);
		expect(client.calls.map((call) => call.id)).toEqual([
			'analysis-1',
			'analysis-2',
			'analysis-3',
			'analysis-4'
		]);
		expect(attachment(sqlite, 'file-4').scan_status).toBe('clean');
		expect(attachment(sqlite, 'file-4').vt_analysis_id).toBeNull();
		const fifth = attachment(sqlite, 'file-5');
		expect(fifth.scan_status).toBe('pending');
		expect(fifth.vt_analysis_id).toBe('analysis-5');
		expect(fifth.scan_malicious).toBeNull();
	});

	test('a rate limit leaves that row pending and makes no further call', async () => {
		const { sqlite, db } = open();
		addAttachment(sqlite, {
			id: 'file-1',
			scanStatus: 'pending',
			analysisId: 'analysis-1',
			createdAt: '2026-01-01T00:00:00.000Z'
		});
		addAttachment(sqlite, {
			id: 'file-2',
			scanStatus: 'pending',
			analysisId: 'analysis-2',
			createdAt: '2026-01-02T00:00:00.000Z'
		});
		addAttachment(sqlite, {
			id: 'file-new',
			scanStatus: 'pending',
			createdAt: '2026-01-03T00:00:00.000Z',
			filename: 'new.bin'
		});
		const client = recorder({
			getAnalysis: () => ({ error: 'rate-limit' }),
			getFile: () => ({ found: false }),
			upload: () => ({ analysisId: 'should-not-run' })
		});

		await scanPending(db, bucketOf(FILE_BYTES), client, thresholdOfOne);

		expect(client.calls).toEqual([{ method: 'getAnalysis', id: 'analysis-1' }]);
		expect(attachment(sqlite, 'file-1')).toMatchObject({
			scan_status: 'pending',
			vt_analysis_id: 'analysis-1',
			scan_malicious: null
		});
		expect(attachment(sqlite, 'file-2').vt_analysis_id).toBe('analysis-2');
		expect(attachment(sqlite, 'file-new').vt_analysis_id).toBeNull();
	});

	test('another error leaves the row pending and the run continues until four requests', async () => {
		const { sqlite, db } = open();
		for (let index = 1; index <= 5; index += 1) {
			addAttachment(sqlite, {
				id: `file-${index}`,
				scanStatus: 'pending',
				analysisId: `analysis-${index}`,
				createdAt: `2026-01-0${index}T00:00:00.000Z`
			});
		}
		const errors: unknown[][] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args);
		};
		const client = recorder({
			getAnalysis: (id) => (id === 'analysis-1' ? { error: 'other' } : { status: 'completed', malicious: 0 })
		});

		try {
			await scanPending(db, bucketOf(FILE_BYTES), client, thresholdOfOne);
		} finally {
			console.error = original;
		}

		expect(client.calls.map((call) => call.id)).toEqual([
			'analysis-1',
			'analysis-2',
			'analysis-3',
			'analysis-4'
		]);
		expect(attachment(sqlite, 'file-1')).toMatchObject({
			scan_status: 'pending',
			vt_analysis_id: 'analysis-1'
		});
		expect(attachment(sqlite, 'file-4').scan_status).toBe('clean');
		expect(attachment(sqlite, 'file-5').vt_analysis_id).toBe('analysis-5');
		expect(errors.length).toBeGreaterThan(0);
	});

	test('a pending analysis stays pending and keeps its analysis id', async () => {
		const { sqlite, db } = open();
		addAttachment(sqlite, {
			id: 'file-1',
			scanStatus: 'pending',
			analysisId: 'analysis-1',
			createdAt: '2026-01-01T00:00:00.000Z'
		});
		const client = recorder({
			getAnalysis: () => ({ status: 'pending' })
		});

		await scanPending(db, bucketOf(FILE_BYTES), client, thresholdOfOne);

		expect(attachment(sqlite, 'file-1')).toMatchObject({
			scan_status: 'pending',
			vt_analysis_id: 'analysis-1',
			scan_malicious: null
		});
	});

	test('a skipped row is not passed to the client', async () => {
		const { sqlite, db } = open();
		addAttachment(sqlite, {
			id: 'skipped',
			scanStatus: 'skipped',
			analysisId: 'analysis-skipped',
			createdAt: '2026-01-01T00:00:00.000Z'
		});
		addAttachment(sqlite, {
			id: 'pending',
			scanStatus: 'pending',
			analysisId: 'analysis-pending',
			createdAt: '2026-01-02T00:00:00.000Z'
		});
		const client = recorder({
			getAnalysis: () => ({ status: 'completed', malicious: 0 })
		});

		await scanPending(db, bucketOf(FILE_BYTES), client, thresholdOfOne);

		expect(client.calls).toEqual([{ method: 'getAnalysis', id: 'analysis-pending' }]);
		expect(attachment(sqlite, 'skipped')).toMatchObject({
			scan_status: 'skipped',
			vt_analysis_id: 'analysis-skipped',
			scan_malicious: null
		});
	});

	test('a finished row is not selected again', async () => {
		const { sqlite, db } = open();
		addAttachment(sqlite, {
			id: 'clean',
			scanStatus: 'clean',
			analysisId: 'analysis-clean',
			malicious: 0,
			createdAt: '2026-01-01T00:00:00.000Z'
		});
		addAttachment(sqlite, {
			id: 'infected',
			scanStatus: 'infected',
			analysisId: 'analysis-infected',
			malicious: 4,
			createdAt: '2026-01-02T00:00:00.000Z'
		});
		addAttachment(sqlite, {
			id: 'pending',
			scanStatus: 'pending',
			analysisId: 'analysis-pending',
			createdAt: '2026-01-03T00:00:00.000Z'
		});
		const client = recorder({
			getAnalysis: () => ({ status: 'completed', malicious: 1 })
		});

		await scanPending(db, bucketOf(FILE_BYTES), client, thresholdOfOne);

		expect(client.calls).toEqual([{ method: 'getAnalysis', id: 'analysis-pending' }]);
		expect(attachment(sqlite, 'clean')).toMatchObject({ scan_status: 'clean', scan_malicious: 0 });
		expect(attachment(sqlite, 'infected')).toMatchObject({
			scan_status: 'infected',
			scan_malicious: 4
		});
	});

	test('a new file is not started when fewer than two requests remain', async () => {
		const { sqlite, db } = open();
		for (let index = 1; index <= 3; index += 1) {
			addAttachment(sqlite, {
				id: `file-${index}`,
				scanStatus: 'pending',
				analysisId: `analysis-${index}`,
				createdAt: `2026-01-0${index}T00:00:00.000Z`
			});
		}
		addAttachment(sqlite, {
			id: 'file-new',
			scanStatus: 'pending',
			createdAt: '2026-01-04T00:00:00.000Z',
			filename: 'new.bin'
		});
		const client = recorder({
			getAnalysis: () => ({ status: 'pending' }),
			getFile: () => ({ found: false }),
			upload: () => ({ analysisId: 'should-not-run' })
		});

		await scanPending(db, bucketOf(FILE_BYTES), client, thresholdOfOne);

		expect(client.calls).toEqual([
			{ method: 'getAnalysis', id: 'analysis-1' },
			{ method: 'getAnalysis', id: 'analysis-2' },
			{ method: 'getAnalysis', id: 'analysis-3' }
		]);
		expect(attachment(sqlite, 'file-new')).toMatchObject({
			scan_status: 'pending',
			vt_analysis_id: null
		});
	});

	test('a new file starts when two requests remain', async () => {
		const { sqlite, db } = open();
		addAttachment(sqlite, {
			id: 'file-1',
			scanStatus: 'pending',
			analysisId: 'analysis-1',
			createdAt: '2026-01-01T00:00:00.000Z'
		});
		addAttachment(sqlite, {
			id: 'file-2',
			scanStatus: 'pending',
			analysisId: 'analysis-2',
			createdAt: '2026-01-02T00:00:00.000Z'
		});
		addAttachment(sqlite, {
			id: 'file-new',
			scanStatus: 'pending',
			createdAt: '2026-01-03T00:00:00.000Z',
			filename: 'report.pdf'
		});
		let uploaded: Uint8Array | null = null;
		const client = recorder({
			getAnalysis: () => ({ status: 'pending' }),
			getFile: (hash) => {
				expect(hash).toBe(FILE_HASH);
				return { found: false };
			},
			upload: (filename, bytes) => {
				expect(filename).toBe('report.pdf');
				uploaded = bytes;
				return { analysisId: 'analysis-new' };
			}
		});

		await scanPending(db, bucketOf(FILE_BYTES), client, thresholdOfOne);

		expect(client.calls.map((call) => call.method)).toEqual([
			'getAnalysis',
			'getAnalysis',
			'getFile',
			'upload'
		]);
		expect(uploaded).toEqual(FILE_BYTES);
		expect(attachment(sqlite, 'file-1').vt_analysis_id).toBe('analysis-1');
		expect(attachment(sqlite, 'file-new')).toMatchObject({
			scan_status: 'pending',
			vt_analysis_id: 'analysis-new',
			scan_malicious: null
		});
	});

	test('a known file is finished from the hash report and is not uploaded', async () => {
		const { sqlite, db } = open();
		addAttachment(sqlite, {
			id: 'file-new',
			scanStatus: 'pending',
			createdAt: '2026-01-01T00:00:00.000Z',
			filename: 'known.bin'
		});
		const client = recorder({
			getFile: (hash) => {
				expect(hash).toBe(FILE_HASH);
				return { found: true, malicious: 1 };
			},
			upload: () => ({ analysisId: 'should-not-run' })
		});

		await scanPending(db, bucketOf(FILE_BYTES), client, thresholdOfOne);

		expect(client.calls).toEqual([{ method: 'getFile', id: FILE_HASH }]);
		expect(attachment(sqlite, 'file-new')).toMatchObject({
			scan_status: 'infected',
			scan_malicious: 1,
			vt_analysis_id: null
		});
	});

	test('a lookup error does not upload, and a later file can still be scanned', async () => {
		const { sqlite, db } = open();
		addAttachment(sqlite, {
			id: 'file-a',
			scanStatus: 'pending',
			createdAt: '2026-01-01T00:00:00.000Z',
			filename: 'a.bin'
		});
		addAttachment(sqlite, {
			id: 'file-b',
			scanStatus: 'pending',
			createdAt: '2026-01-02T00:00:00.000Z',
			filename: 'b.bin'
		});
		let lookups = 0;
		const client = recorder({
			getFile: () => {
				lookups += 1;
				if (lookups === 1) return { error: 'other' };
				return { found: true, malicious: 0 };
			},
			upload: () => ({ analysisId: 'should-not-run' })
		});
		const original = console.error;
		console.error = () => undefined;

		try {
			await scanPending(db, bucketOf(FILE_BYTES), client, async () => 1);
		} finally {
			console.error = original;
		}

		expect(client.calls.map((call) => call.method)).toEqual(['getFile', 'getFile']);
		expect(attachment(sqlite, 'file-a')).toMatchObject({
			scan_status: 'pending',
			vt_analysis_id: null
		});
		expect(attachment(sqlite, 'file-b')).toMatchObject({
			scan_status: 'clean',
			scan_malicious: 0
		});
	});

	test('a rate limit on upload stops the run before the next file', async () => {
		const { sqlite, db } = open();
		addAttachment(sqlite, {
			id: 'file-a',
			scanStatus: 'pending',
			createdAt: '2026-01-01T00:00:00.000Z',
			filename: 'a.bin'
		});
		addAttachment(sqlite, {
			id: 'file-b',
			scanStatus: 'pending',
			createdAt: '2026-01-02T00:00:00.000Z',
			filename: 'b.bin'
		});
		const client = recorder({
			getFile: () => ({ found: false }),
			upload: () => ({ error: 'rate-limit' })
		});

		await scanPending(db, bucketOf(FILE_BYTES), client, thresholdOfOne);

		expect(client.calls.map((call) => call.method)).toEqual(['getFile', 'upload']);
		expect(attachment(sqlite, 'file-a')).toMatchObject({
			scan_status: 'pending',
			vt_analysis_id: null
		});
		expect(attachment(sqlite, 'file-b').vt_analysis_id).toBeNull();
	});

	test('two new files use the four-request budget and a third is not started', async () => {
		const { sqlite, db } = open();
		for (const id of ['file-a', 'file-b', 'file-c']) {
			addAttachment(sqlite, {
				id,
				scanStatus: 'pending',
				createdAt: `2026-01-0${id.at(-1) === 'a' ? 1 : id.at(-1) === 'b' ? 2 : 3}T00:00:00.000Z`,
				filename: `${id}.bin`
			});
		}
		const client = recorder({
			getFile: () => ({ found: false }),
			upload: (filename) => ({ analysisId: `uploaded-${filename}` })
		});

		await scanPending(db, bucketOf(FILE_BYTES), client, thresholdOfOne);

		expect(client.calls).toHaveLength(4);
		expect(client.calls.map((call) => call.method)).toEqual(['getFile', 'upload', 'getFile', 'upload']);
		expect(attachment(sqlite, 'file-a').vt_analysis_id).toBe('uploaded-file-a.bin');
		expect(attachment(sqlite, 'file-b').vt_analysis_id).toBe('uploaded-file-b.bin');
		expect(attachment(sqlite, 'file-c')).toMatchObject({
			scan_status: 'pending',
			vt_analysis_id: null
		});
	});
});

describe('createVirusTotal', () => {
	test('getFile sends the key, treats 404 as missing, and reads malicious', async () => {
		const seen: { url: string; method: string; key: string | null }[] = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			seen.push({ url, method: init?.method ?? 'GET', key: headers.get('x-apikey') });
			expect(url).not.toContain('vt-secret');
			if (url.endsWith('/missing')) return new Response(null, { status: 404 });
			if (url.endsWith('/limited')) return new Response(null, { status: 429 });
			if (url.endsWith('/broken')) return new Response('nope', { status: 500 });
			if (url.endsWith('/empty')) {
				return Response.json({ data: { attributes: { last_analysis_stats: { suspicious: 4 } } } });
			}
			return Response.json({
				data: {
					attributes: {
						last_analysis_stats: { malicious: 2, suspicious: 9 },
						stats: { malicious: 40 }
					}
				}
			});
		};
		const client = createVirusTotal('vt-secret', fetchImpl);

		expect(await client.getFile('abc123')).toEqual({ found: true, malicious: 2 });
		expect(await client.getFile('missing')).toEqual({ found: false });
		expect(await client.getFile('limited')).toEqual({ error: 'rate-limit' });
		expect(await client.getFile('broken')).toEqual({ error: 'other' });
		expect(await client.getFile('empty')).toEqual({ error: 'other' });
		expect(seen.every((call) => call.method === 'GET' && call.key === 'vt-secret')).toBe(true);
		expect(seen[0]?.url).toBe('https://www.virustotal.com/api/v3/files/abc123');
	});

	test('getFile zero malicious is a report, and a network failure is other', async () => {
		const fetchImpl: typeof fetch = async (input) => {
			if (String(input).endsWith('/zero')) {
				return Response.json({
					data: { attributes: { last_analysis_stats: { malicious: 0, suspicious: 3 } } }
				});
			}
			throw new Error('offline');
		};
		const client = createVirusTotal('vt-secret', fetchImpl);

		expect(await client.getFile('zero')).toEqual({ found: true, malicious: 0 });
		expect(await client.getFile('offline')).toEqual({ error: 'other' });
	});

	test('upload posts the file field and returns the analysis id', async () => {
		let seen: { url: string; method: string; key: string | null; contentType: string | null } | null =
			null;
		const fetchImpl: typeof fetch = async (input, init) => {
			const headers = new Headers(init?.headers);
			seen = {
				url: String(input),
				method: init?.method ?? 'GET',
				key: headers.get('x-apikey'),
				contentType: headers.get('content-type')
			};
			const form = init?.body;
			expect(form).toBeInstanceOf(FormData);
			const part = (form as FormData).get('file');
			expect(part).toBeInstanceOf(Blob);
			expect((part as File).name).toBe('report.pdf');
			expect(new Uint8Array(await (part as Blob).arrayBuffer())).toEqual(FILE_BYTES);
			return Response.json({ data: { id: 'analysis-uploaded', type: 'analysis' } });
		};
		const client = createVirusTotal('vt-secret', fetchImpl);

		expect(await client.upload(FILE_BYTES, 'report.pdf')).toEqual({ analysisId: 'analysis-uploaded' });
		expect(seen).toEqual({
			url: 'https://www.virustotal.com/api/v3/files',
			method: 'POST',
			key: 'vt-secret',
			contentType: null
		});
	});

	test('upload maps 429, other HTTP statuses, and network errors', async () => {
		const statuses = [429, 500, 0];
		let index = 0;
		const fetchImpl: typeof fetch = async () => {
			const status = statuses[index] ?? 500;
			index += 1;
			if (status === 0) throw new Error('offline');
			return new Response(null, { status });
		};
		const client = createVirusTotal('vt-secret', fetchImpl);

		expect(await client.upload(FILE_BYTES, 'a.bin')).toEqual({ error: 'rate-limit' });
		expect(await client.upload(FILE_BYTES, 'a.bin')).toEqual({ error: 'other' });
		expect(await client.upload(FILE_BYTES, 'a.bin')).toEqual({ error: 'other' });
	});

	test('getAnalysis reads stats.malicious only when the analysis is completed', async () => {
		const fetchImpl: typeof fetch = async (input, init) => {
			const headers = new Headers(init?.headers);
			expect(headers.get('x-apikey')).toBe('vt-secret');
			expect(init?.method ?? 'GET').toBe('GET');
			const url = String(input);
			expect(url.startsWith('https://www.virustotal.com/api/v3/analyses/')).toBe(true);
			if (url.endsWith('/done')) {
				return Response.json({
					data: {
						attributes: {
							status: 'completed',
							stats: { malicious: 2, suspicious: 9 },
							last_analysis_stats: { malicious: 40 }
						}
					}
				});
			}
			if (url.endsWith('/zero')) {
				return Response.json({
					data: { attributes: { status: 'completed', stats: { malicious: 0, suspicious: 5 } } }
				});
			}
			if (url.endsWith('/queued')) {
				return Response.json({
					data: { attributes: { status: 'queued', stats: { malicious: 5 } } }
				});
			}
			if (url.endsWith('/blank')) {
				return Response.json({ data: { attributes: { status: 'completed', stats: { suspicious: 1 } } } });
			}
			if (url.endsWith('/limited')) return new Response(null, { status: 429 });
			if (url.endsWith('/missing')) return new Response(null, { status: 404 });
			throw new Error('offline');
		};
		const client = createVirusTotal('vt-secret', fetchImpl);

		expect(await client.getAnalysis('done')).toEqual({ status: 'completed', malicious: 2 });
		expect(await client.getAnalysis('zero')).toEqual({ status: 'completed', malicious: 0 });
		expect(await client.getAnalysis('queued')).toEqual({ status: 'pending' });
		expect(await client.getAnalysis('blank')).toEqual({ error: 'other' });
		expect(await client.getAnalysis('limited')).toEqual({ error: 'rate-limit' });
		expect(await client.getAnalysis('missing')).toEqual({ error: 'other' });
		expect(await client.getAnalysis('offline')).toEqual({ error: 'other' });
	});
});

describe('scheduled scan', () => {
	test('delivery stays, and the scan runs only with a key outside demo mode', async () => {
		const source = await Bun.file(new URL('../src/worker.ts', import.meta.url)).text();
		const env = await Bun.file(new URL('../src/env.d.ts', import.meta.url)).text();
		const wrangler = await Bun.file(new URL('../wrangler.jsonc', import.meta.url)).text();
		const scheduled = source.slice(source.indexOf('async scheduled'));

		expect(scheduled.match(/ctx\.waitUntil\(/g)?.length).toBe(5);
		expect(scheduled).toContain('syncDueOutsideCalendars(env.DB, key,');
		expect(scheduled).toContain('expireActions(env.DB)');
		expect(scheduled).toContain('Failed to expire or finish agent actions');
		expect(scheduled).toContain('deliverDue(env.DB, getEmailProvider({ env }), new Date(), 20)');
		expect(scheduled).toContain('Failed to deliver scheduled mail');
		const guard = scheduled.search(/!env\.VIRUSTOTAL_API_KEY \|\| env\.DEMO_MODE === 'true'/);
		const call = scheduled.indexOf('createVirusTotal(');
		expect(guard).toBeGreaterThan(-1);
		expect(call).toBeGreaterThan(guard);
		expect(scheduled).toContain('scanPending(');
		expect(scheduled).toContain('readVtThreshold');
		expect(scheduled).toContain('Failed to scan attachments');
		expect(env).toContain('DEMO_MODE?: string');
		expect(wrangler).not.toContain('VIRUSTOTAL_API_KEY');
	});
});
