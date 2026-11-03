export type SnoozePreset = 'later' | 'tomorrow' | 'next-week';

export function snoozeInstant(preset: SnoozePreset, now: Date): string {
	if (preset === 'tomorrow') return atLocal(addDays(now, 1), 8, 0).toISOString();
	if (preset === 'next-week') {
		const days = (8 - now.getDay()) % 7 || 7;
		return atLocal(addDays(now, days), 8, 0).toISOString();
	}
	const hour = now.getHours() < 16 ? 18 : 20;
	const later = atLocal(now, hour, 0);
	if (later.getTime() > now.getTime()) return later.toISOString();
	return atLocal(addDays(now, 1), 8, 0).toISOString();
}

export function isFutureInstant(iso: string, now: Date): boolean {
	const time = Date.parse(iso);
	return Number.isFinite(time) && time > now.getTime();
}

function addDays(date: Date, days: number): Date {
	const next = new Date(date);
	next.setDate(next.getDate() + days);
	return next;
}

function atLocal(date: Date, hours: number, minutes: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, 0, 0);
}
