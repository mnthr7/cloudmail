const API = 'https://www.virustotal.com/api/v3';

export type FileLookup =
	| { found: false }
	| { found: true; malicious: number }
	| { error: 'rate-limit' | 'other' };

export type UploadResult = { analysisId: string } | { error: 'rate-limit' | 'other' };

export type AnalysisResult =
	| { status: 'completed'; malicious: number }
	| { status: 'pending' }
	| { error: 'rate-limit' | 'other' };

export type VirusTotalClient = {
	getFile(hash: string): Promise<FileLookup>;
	upload(bytes: Uint8Array, filename: string): Promise<UploadResult>;
	getAnalysis(id: string): Promise<AnalysisResult>;
};

type VtError = { error: 'rate-limit' | 'other' };

export function createVirusTotal(apiKey: string, fetchImpl: typeof fetch = fetch): VirusTotalClient {
	return {
		async getFile(hash: string): Promise<FileLookup> {
			const result = await send(fetchImpl, apiKey, `${API}/files/${hash}`);
			if ('error' in result) return result;
			if (result.response.status === 404) return { found: false };
			if (!result.response.ok) return { error: 'other' };
			const malicious = countAt(await readJson(result.response), [
				'data',
				'attributes',
				'last_analysis_stats',
				'malicious'
			]);
			if (malicious === null) return { error: 'other' };
			return { found: true, malicious };
		},

		async upload(bytes: Uint8Array, filename: string): Promise<UploadResult> {
			const body = new FormData();
			const copy = new Uint8Array(bytes.byteLength);
			copy.set(bytes);
			body.append('file', new File([copy], filename));
			const result = await send(fetchImpl, apiKey, `${API}/files`, { method: 'POST', body });
			if ('error' in result) return result;
			if (!result.response.ok) return { error: 'other' };
			const id = valueAt(await readJson(result.response), ['data', 'id']);
			if (typeof id !== 'string' || id.length === 0) return { error: 'other' };
			return { analysisId: id };
		},

		async getAnalysis(id: string): Promise<AnalysisResult> {
			const result = await send(fetchImpl, apiKey, `${API}/analyses/${id}`);
			if ('error' in result) return result;
			if (!result.response.ok) return { error: 'other' };
			const body = await readJson(result.response);
			const status = valueAt(body, ['data', 'attributes', 'status']);
			if (status !== 'completed') return { status: 'pending' };
			const malicious = countAt(body, ['data', 'attributes', 'stats', 'malicious']);
			if (malicious === null) return { error: 'other' };
			return { status: 'completed', malicious };
		}
	};
}

async function send(
	fetchImpl: typeof fetch,
	apiKey: string,
	url: string,
	init?: RequestInit
): Promise<{ response: Response } | VtError> {
	try {
		const headers = new Headers(init?.headers);
		headers.set('x-apikey', apiKey);
		const response = await fetchImpl(url, { ...init, headers });
		if (response.status === 429) return { error: 'rate-limit' };
		return { response };
	} catch {
		return { error: 'other' };
	}
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

function valueAt(value: unknown, path: string[]): unknown {
	let current = value;
	for (const key of path) {
		if (!current || typeof current !== 'object') return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

/** Engine count only. A missing or non-numeric count is not a verdict. */
function countAt(value: unknown, path: string[]): number | null {
	const count = valueAt(value, path);
	if (typeof count !== 'number' || !Number.isFinite(count)) return null;
	return count;
}
