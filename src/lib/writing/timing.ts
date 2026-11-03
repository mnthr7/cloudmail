const ALLOWED = [5, 10, 20, 30] as const;
export type UndoSeconds = (typeof ALLOWED)[number];

export function parseUndoSeconds(value: unknown): UndoSeconds | null {
	return ALLOWED.find((seconds) => seconds === value) ?? null;
}

export function holdUntil(now: Date, seconds: UndoSeconds): string {
	return new Date(now.getTime() + seconds * 1000).toISOString();
}

export function scheduleError(sendAt: string, now: Date): string | null {
	const time = Date.parse(sendAt);
	if (!Number.isFinite(time) || time < now.getTime() + 60_000) {
		return 'Pick a time at least a minute from now.';
	}
	return null;
}
