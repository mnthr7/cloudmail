import { describe, expect, test } from 'bun:test';
import {
	collectReplyFromCandidates,
	defaultReplyFromKey,
	matchReplyFromAddress,
	matchThreadReplyFrom,
	receivedAtAddresses,
	threadReceivedAtAddresses,
	replyFromOptions,
	type ReplyFromAddress,
	type ReplyFromDomain
} from '../src/lib/reply-from';

const USER_ID = 'user-1';
const OTHER_USER = 'user-2';

const owned: ReplyFromAddress[] = [
	{
		id: 'addr-default',
		address: 'sada@example.org',
		domain_id: 'dom-example',
		is_default: true
	},
	{
		id: 'addr-riti',
		address: 'sada@example.net',
		domain_id: 'dom-riti',
		is_default: false
	}
];

const domains: ReplyFromDomain[] = [
	{
		id: 'dom-example',
		name: 'example.org',
		sending_enabled: true,
		catchall_user_id: USER_ID
	},
	{
		id: 'dom-riti',
		name: 'example.net',
		sending_enabled: true,
		catchall_user_id: USER_ID
	}
];

function inbound(to: string, cc?: string | null) {
	return {
		direction: 'inbound' as const,
		from_addr: 'customer@example.com',
		to_addr: to,
		cc_addr: cc ?? null
	};
}

describe('collectReplyFromCandidates', () => {
	test('parses display names and multiple To recipients', () => {
		expect(
			collectReplyFromCandidates(
				inbound('Support Team <support@example.net>, Other <other@example.com>')
			)
		).toEqual(['support@example.net', 'other@example.com']);
	});

	test('includes Cc after To and de-duplicates', () => {
		expect(
			collectReplyFromCandidates(
				inbound('support@example.net', 'support@example.net, sada@example.net')
			)
		).toEqual(['support@example.net', 'sada@example.net']);
	});

	test('uses From when continuing an outbound message', () => {
		expect(
			collectReplyFromCandidates({
				direction: 'outbound',
				from_addr: 'Sada <SUPPORT@example.net>',
				to_addr: 'customer@example.com',
				cc_addr: null
			})
		).toEqual(['support@example.net']);
	});
});

describe('matchReplyFromAddress', () => {
	test('matches an owned address case-insensitively, including display names', () => {
		const match = matchReplyFromAddress(
			inbound('Sada <SADA@Example.NET>'),
			owned,
			domains,
			USER_ID
		);
		expect(match).toEqual({
			address: 'sada@example.net',
			addressId: 'addr-riti',
			domainId: 'dom-riti',
			viaCatchall: false
		});
	});

	test('picks the owned address out of several recipients', () => {
		const match = matchReplyFromAddress(
			inbound('sales@other.com, sada@example.net'),
			owned,
			domains,
			USER_ID
		);
		expect(match?.addressId).toBe('addr-riti');
		expect(match?.viaCatchall).toBe(false);
	});

	test('matches an owned address on Cc when To is someone else', () => {
		const match = matchReplyFromAddress(
			inbound('team@other.com', 'Sada <sada@example.net>'),
			owned,
			domains,
			USER_ID
		);
		expect(match?.addressId).toBe('addr-riti');
	});

	test('prefers an exact addresses row over a catch-all local on the same message', () => {
		const match = matchReplyFromAddress(
			inbound('support@example.net, sada@example.net'),
			owned,
			domains,
			USER_ID
		);
		expect(match).toMatchObject({
			address: 'sada@example.net',
			addressId: 'addr-riti',
			viaCatchall: false
		});
	});

	test('synthesizes a catch-all local when no addresses row exists', () => {
		const match = matchReplyFromAddress(
			inbound('Support <support@example.net>'),
			owned,
			domains,
			USER_ID
		);
		expect(match).toEqual({
			address: 'support@example.net',
			addressId: null,
			domainId: 'dom-riti',
			viaCatchall: true
		});
	});

	test('rejects an unowned domain', () => {
		expect(
			matchReplyFromAddress(inbound('support@notours.com'), owned, domains, USER_ID)
		).toBeNull();
	});

	test('rejects a catch-all on someone else’s domain', () => {
		const foreign: ReplyFromDomain[] = [
			{
				id: 'dom-foreign',
				name: 'acme.com',
				sending_enabled: true,
				catchall_user_id: OTHER_USER
			}
		];
		expect(
			matchReplyFromAddress(inbound('support@acme.com'), owned, foreign, USER_ID)
		).toBeNull();
	});

	test('does not send as a non-received-at catch-all when the domain cannot send', () => {
		const disabled: ReplyFromDomain[] = [
			{
				id: 'dom-riti',
				name: 'example.net',
				sending_enabled: false,
				catchall_user_id: USER_ID
			}
		];
		expect(
			matchReplyFromAddress(
				inbound('team@other.com', 'support@example.net'),
				owned,
				disabled,
				USER_ID
			)
		).toBeNull();
	});

	test('falls back to the default address key when nothing matches', () => {
		expect(defaultReplyFromKey(owned, null)).toBe('addr-default');
	});
});

describe('replyFromOptions', () => {
	test('prepends a catch-all received-at address that has no row', () => {
		const preferred = matchReplyFromAddress(
			inbound('support@example.net'),
			owned,
			domains,
			USER_ID
		);
		const options = replyFromOptions(owned, preferred);
		expect(options[0]).toEqual({
			key: 'address:support@example.net',
			address: 'support@example.net',
			addressId: null
		});
		expect(options.map((option) => option.address)).toContain('sada@example.org');
		expect(defaultReplyFromKey(owned, preferred)).toBe('address:support@example.net');
	});
});

describe('received-at address (example.net catch-all regression)', () => {
	// Owned row is sada@example.net only; support@example.net arrived via catch-all.
	const ownedRiti: ReplyFromAddress[] = [owned[1]];

	test('defaults to the received-at address, keeping sada@ selectable', () => {
		const match = matchReplyFromAddress(
			inbound('support@example.net'),
			ownedRiti,
			domains,
			USER_ID
		);
		expect(match?.address).toBe('support@example.net');
		const options = replyFromOptions(ownedRiti, match);
		expect(options.map((o) => o.address)).toEqual(['support@example.net', 'sada@example.net']);
		expect(defaultReplyFromKey(ownedRiti, match)).toBe('address:support@example.net');
	});

	test('received-at wins even when Cc lists an owned row first', () => {
		const match = matchReplyFromAddress(
			inbound('support@example.net', 'sada@example.net'),
			ownedRiti,
			domains,
			USER_ID
		);
		expect(match?.address).toBe('support@example.net');
	});

	test('still offers the received-at address when the cached sending flag is stale', () => {
		const stale: ReplyFromDomain[] = [
			{ id: 'dom-riti', name: 'example.net', sending_enabled: false, catchall_user_id: USER_ID }
		];
		const match = matchReplyFromAddress(inbound('support@example.net'), ownedRiti, stale, USER_ID);
		expect(match).toMatchObject({ address: 'support@example.net', addressId: null });
	});

	test('never treats Cc recipients as received-at on a sending-disabled domain', () => {
		const stale: ReplyFromDomain[] = [
			{ id: 'dom-riti', name: 'example.net', sending_enabled: false, catchall_user_id: USER_ID }
		];
		expect(
			matchReplyFromAddress(inbound('team@other.com', 'other@example.net'), [], stale, USER_ID)
		).toBeNull();
	});

	test('received-at on a domain that is not connected is not offered', () => {
		expect(
			matchReplyFromAddress(inbound('support@notours.com'), ownedRiti, domains, USER_ID)
		).toBeNull();
	});

	test('does not add other catch-all addresses to the options', () => {
		const match = matchReplyFromAddress(
			inbound('support@example.net'),
			ownedRiti,
			domains,
			USER_ID
		);
		expect(replyFromOptions(ownedRiti, match)).toHaveLength(2);
		expect(replyFromOptions(ownedRiti, null).map((o) => o.address)).toEqual([
			'sada@example.net'
		]);
	});

	test('receivedAtAddresses is To of inbound only', () => {
		expect(receivedAtAddresses(inbound('Support <support@example.net>', 'x@y.com'))).toEqual([
			'support@example.net'
		]);
		expect(
			receivedAtAddresses({
				direction: 'outbound',
				from_addr: 'sada@example.net',
				to_addr: 'c@example.com'
			})
		).toEqual([]);
	});
});

describe('matchThreadReplyFrom', () => {
	const ownedRiti: ReplyFromAddress[] = [owned[1]];
	const received = inbound('support@example.net');
	const sentFromDefault = {
		direction: 'outbound' as const,
		from_addr: 'sada@example.net',
		to_addr: 'customer@example.com',
		cc_addr: null
	};

	test('newest inbound: default is its received-at address', () => {
		const { preferred, also } = matchThreadReplyFrom([received], ownedRiti, domains, USER_ID);
		expect(preferred?.address).toBe('support@example.net');
		expect(also).toBeNull();
	});

	test('after an earlier reply from sada@, still defaults to the received-at address', () => {
		const { preferred, also } = matchThreadReplyFrom(
			[received, sentFromDefault],
			ownedRiti,
			domains,
			USER_ID
		);
		expect(preferred?.address).toBe('support@example.net');
		expect(also?.address).toBe('sada@example.net');
		const options = replyFromOptions(ownedRiti, preferred, also);
		expect(options.map((o) => o.address)).toEqual(['support@example.net', 'sada@example.net']);
	});

	test('outbound-only thread falls back to its From', () => {
		const { preferred } = matchThreadReplyFrom([sentFromDefault], ownedRiti, domains, USER_ID);
		expect(preferred?.address).toBe('sada@example.net');
	});

	test('threadReceivedAtAddresses collects inbound To across the thread', () => {
		expect(
			threadReceivedAtAddresses([received, sentFromDefault, inbound('help@example.net')])
		).toEqual(['support@example.net', 'help@example.net']);
	});
});
