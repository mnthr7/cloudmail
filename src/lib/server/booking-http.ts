import { json } from '@sveltejs/kit';
import { BookingError } from './booking-store.ts';
import { CalendarError } from './calendar-store.ts';

export function bookingFailure(error: unknown): Response {
	if (error instanceof BookingError) return json({ error: error.code }, { status: error.status });
	if (error instanceof CalendarError) return json({ error: error.code }, { status: error.status });
	throw error;
}

/**
 * Rate-limit keys for a visitor: their network, and for IPv6 also the wider
 * /48 a single customer is often given, so rotating addresses doesn't help.
 */
export function visitorKeys(prefix: string, network: string, limit: number): Array<{ key: string; limit: number }> {
	const keys = [{ key: `${prefix}:${network}`, limit }];
	if (network.endsWith('::/64')) {
		const wide = network.split(':').slice(0, 3).join(':');
		keys.push({ key: `${prefix}48:${wide}::/48`, limit: limit * 3 });
	}
	return keys;
}

/** The visitor's address, or a stand-in when the platform can't say. */
export function visitorAddress(request: Request, getClientAddress: () => string): string {
	try {
		return getClientAddress() || request.headers.get('cf-connecting-ip') || 'unknown';
	} catch {
		return request.headers.get('cf-connecting-ip') || 'unknown';
	}
}
