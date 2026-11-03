import { describe, expect, test } from 'bun:test';
import { resolveFromAddress } from '../src/lib/server/outbox';
import type { User } from '../src/lib/types';

const user = { id: 'user-1', name: 'Sada' } as User;
const USER_ID = 'user-1';

type DomainRow = {
	id: string;
	name: string;
	status: string;
	region: string | null;
	sending_enabled: number;
	receiving_enabled: number;
	catchall_user_id: string | null;
	created_at: string;
	synced_at: string | null;
};

/** Minimal D1 stub: no addresses rows, one connected domain. */
function fakeDb(domain: Partial<DomainRow> | null) {
	const row = domain && {
		id: 'dom-riti',
		name: 'example.net',
		status: 'verified',
		region: null,
		sending_enabled: 1,
		receiving_enabled: 1,
		catchall_user_id: 'user-1',
		created_at: '',
		synced_at: null,
		...domain
	};
	return {
		prepare(sql: string) {
			return {
				bind() {
					return {
						first: async () => (sql.includes('FROM domains') ? row : null),
						all: async () => ({ results: [] })
					};
				}
			};
		}
	} as never;
}

describe('resolveFromAddress with received-at addresses', () => {
	test('accepts a catch-all local on an owned, sending-enabled domain', async () => {
		const from = await resolveFromAddress(fakeDb({}), user, null, 'support@example.net');
		expect(from.address).toBe('support@example.net');
		expect(from.domain_id).toBe('dom-riti');
	});

	test('rejects the same address when the sending flag is stale and it was not received-at', async () => {
		const db = fakeDb({ sending_enabled: 0 });
		await expect(resolveFromAddress(db, user, null, 'support@example.net')).rejects.toThrow(
			'You cannot send from that address.'
		);
	});

	test('accepts the received-at address even when the sending flag is stale', async () => {
		const db = fakeDb({ sending_enabled: 0 });
		const from = await resolveFromAddress(db, user, null, 'Support@example.net', [
			'support@example.net'
		]);
		expect(from.address).toBe('support@example.net');
	});

	test('received-at does not unlock other locals or unconnected domains', async () => {
		const stale = fakeDb({ sending_enabled: 0 });
		await expect(
			resolveFromAddress(stale, user, null, 'billing@example.net', ['support@example.net'])
		).rejects.toThrow();
		await expect(
			resolveFromAddress(fakeDb(null), user, null, 'support@example.net', ['support@example.net'])
		).rejects.toThrow();
	});
});
