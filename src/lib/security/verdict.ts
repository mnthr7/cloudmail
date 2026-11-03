export function parseThreshold(value: unknown): number | null {
	if (typeof value !== 'number' || !Number.isInteger(value)) return null;
	if (value < 1 || value > 70) return null;
	return value;
}

export function scanVerdict(malicious: number, threshold: number): 'clean' | 'infected' {
	return malicious >= threshold ? 'infected' : 'clean';
}
