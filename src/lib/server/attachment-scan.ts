import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { scanVerdict } from '../security/verdict';
import type { VirusTotalClient } from './virus-total';

/** Four lookups per run. The public API allows four requests a minute, and the cron is every minute. */
const REQUEST_BUDGET = 4;

type PendingAttachment = {
	id: string;
	filename: string;
	storage_key: string | null;
	vt_analysis_id: string | null;
	user_id: string;
};

type ReadThreshold = (db: D1Database, userId: string) => Promise<number>;

const PENDING_ROWS = `
	SELECT a.id, a.filename, a.storage_key, a.vt_analysis_id, e.user_id AS user_id
	FROM email_attachments a
	INNER JOIN emails e ON e.id = a.email_id
`;

export async function scanPending(
	db: D1Database,
	bucket: R2Bucket,
	client: VirusTotalClient,
	readThreshold: ReadThreshold
): Promise<void> {
	let used = 0;
	const polling = await select(
		db,
		`${PENDING_ROWS}
		 WHERE a.scan_status = 'pending' AND a.vt_analysis_id IS NOT NULL
		 ORDER BY a.created_at ASC, a.id ASC`
	);

	for (const row of polling) {
		if (used >= REQUEST_BUDGET) break;
		if (!row.vt_analysis_id) continue;
		used += 1;
		const result = await client.getAnalysis(row.vt_analysis_id);
		if ('error' in result) {
			if (result.error === 'rate-limit') return;
			console.error('VirusTotal request failed', { attachmentId: row.id, step: 'analysis' });
			continue;
		}
		if (result.status !== 'completed') continue;
		await finish(db, row, result.malicious, readThreshold);
	}

	if (REQUEST_BUDGET - used < 2) return;

	const fresh = await select(
		db,
		`${PENDING_ROWS}
		 WHERE a.scan_status = 'pending' AND a.vt_analysis_id IS NULL
		 ORDER BY a.created_at ASC, a.id ASC`
	);

	for (const row of fresh) {
		if (REQUEST_BUDGET - used < 2) break;
		const bytes = await readBytes(bucket, row);
		if (!bytes) continue;
		used += 1;
		const lookup = await client.getFile(await sha256Hex(bytes));
		if ('error' in lookup) {
			if (lookup.error === 'rate-limit') return;
			console.error('VirusTotal request failed', { attachmentId: row.id, step: 'lookup' });
			continue;
		}
		if (lookup.found) {
			await finish(db, row, lookup.malicious, readThreshold);
			continue;
		}
		if (used >= REQUEST_BUDGET) break;
		used += 1;
		const uploaded = await client.upload(bytes, row.filename);
		if ('error' in uploaded) {
			if (uploaded.error === 'rate-limit') return;
			console.error('VirusTotal request failed', { attachmentId: row.id, step: 'upload' });
			continue;
		}
		await db
			.prepare(
				`UPDATE email_attachments
				 SET vt_analysis_id = ?
				 WHERE id = ? AND scan_status = 'pending'`
			)
			.bind(uploaded.analysisId, row.id)
			.run();
	}
}

async function finish(
	db: D1Database,
	row: PendingAttachment,
	malicious: number,
	readThreshold: ReadThreshold
): Promise<void> {
	const threshold = await readThreshold(db, row.user_id);
	const verdict = scanVerdict(malicious, threshold);
	await db
		.prepare(
			`UPDATE email_attachments
			 SET scan_status = ?, scan_malicious = ?, vt_analysis_id = NULL
			 WHERE id = ? AND scan_status = 'pending'`
		)
		.bind(verdict, malicious, row.id)
		.run();
}

async function select(db: D1Database, sql: string): Promise<PendingAttachment[]> {
	const result = await db.prepare(sql).bind().all<PendingAttachment>();
	return result.results ?? [];
}

async function readBytes(bucket: R2Bucket, row: PendingAttachment): Promise<Uint8Array | null> {
	if (!row.storage_key) {
		console.error('Attachment has no storage key', row.id);
		return null;
	}
	try {
		const object = await bucket.get(row.storage_key);
		if (!object) {
			console.error('Attachment bytes missing', row.id);
			return null;
		}
		return new Uint8Array(await object.arrayBuffer());
	} catch (error) {
		console.error('Failed to read attachment bytes', row.id, error);
		return null;
	}
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
