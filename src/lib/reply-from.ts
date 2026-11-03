import {
	domainOf,
	isValidLocalPart,
	localPartOf,
	parseEmailAddresses
} from '$lib/email-address';

export type ReplyFromAddress = {
	id: string;
	address: string;
	domain_id: string;
	is_default?: boolean;
};

export type ReplyFromDomain = {
	id: string;
	name: string;
	sending_enabled: boolean;
	catchall_user_id: string | null;
};

export type ReplyFromMessage = {
	direction: 'inbound' | 'outbound';
	from_addr: string;
	to_addr: string;
	cc_addr?: string | null;
};

export type ReplyFromMatch = {
	address: string;
	addressId: string | null;
	domainId: string;
	viaCatchall: boolean;
};

export type ReplyFromOption = {
	key: string;
	address: string;
	addressId: string | null;
};

function uniqueAddresses(values: string[]): string[] {
	const seen = new Set<string>();
	const ordered: string[] = [];

	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		ordered.push(value);
	}

	return ordered;
}

/**
 * Addresses on the message that might be "us": To/Cc for inbound, From when
 * we are continuing a conversation we already sent.
 */
export function collectReplyFromCandidates(message: ReplyFromMessage): string[] {
	if (message.direction === 'outbound') {
		return parseEmailAddresses(message.from_addr);
	}

	return uniqueAddresses([
		...parseEmailAddresses(message.to_addr),
		...parseEmailAddresses(message.cc_addr)
	]);
}

function matchExactAddress(
	candidates: string[],
	addresses: ReplyFromAddress[]
): ReplyFromMatch | null {
	const byAddress = new Map(
		addresses.map((address) => [address.address.toLowerCase(), address] as const)
	);

	for (const candidate of candidates) {
		const owned = byAddress.get(candidate);
		if (!owned) continue;

		return {
			address: owned.address,
			addressId: owned.id,
			domainId: owned.domain_id,
			viaCatchall: false
		};
	}

	return null;
}

function synthesizeMatch(
	candidate: string,
	domain: ReplyFromDomain
): ReplyFromMatch | null {
	const localPart = localPartOf(candidate);
	if (!localPart || !isValidLocalPart(localPart)) return null;

	return { address: candidate, addressId: null, domainId: domain.id, viaCatchall: true };
}

/**
 * Catch-all local on a connected domain. `receivedHere` marks the address the
 * message was actually delivered to. The domain must still be one this user
 * owns the catch-all of, but the cached `sending_enabled` flag (only refreshed
 * on an admin re-sync, so easily stale) does not hide it: if the provider truly
 * cannot send, the send fails with a clear error instead of the reply silently
 * defaulting to another identity. Other addresses still need a sending-enabled
 * domain.
 */
function matchCatchallAddress(
	candidates: string[],
	domains: ReplyFromDomain[],
	userId: string,
	receivedHere: Set<string>
): ReplyFromMatch | null {
	const byName = new Map(domains.map((domain) => [domain.name.toLowerCase(), domain] as const));

	for (const candidate of candidates) {
		const domain = byName.get(domainOf(candidate) ?? '');
		if (!domain) continue;

		// Never on a domain someone else owns the catch-all of.
		if (domain.catchall_user_id !== userId) continue;
		if (!receivedHere.has(candidate) && !domain.sending_enabled) continue;

		const match = synthesizeMatch(candidate, domain);
		if (match) return match;
	}

	return null;
}

/**
 * The address(es) an inbound message was delivered to. Inbound `to_addr` holds
 * the single received-at address the webhook routed on; Cc is never "received
 * at".
 */
export function receivedAtAddresses(message: ReplyFromMessage): string[] {
	return message.direction === 'inbound' ? parseEmailAddresses(message.to_addr) : [];
}

/**
 * Pick the From identity for a reply. The received-at address wins: an owned
 * addresses row, else a catch-all local on a connected domain (per message —
 * nothing is added to the user's addresses). Unconnected domains never match.
 */
export function matchReplyFromAddress(
	message: ReplyFromMessage,
	addresses: ReplyFromAddress[],
	domains: ReplyFromDomain[],
	userId: string
): ReplyFromMatch | null {
	const receivedAt = receivedAtAddresses(message);
	const receivedHere = new Set(receivedAt);
	// Received-at first, then the rest of To/Cc (or From when continuing outbound).
	const candidates = uniqueAddresses([...receivedAt, ...collectReplyFromCandidates(message)]);
	const first = candidates.slice(0, receivedAt.length);

	return (
		matchExactAddress(first, addresses) ??
		matchCatchallAddress(first, domains, userId, receivedHere) ??
		matchExactAddress(candidates, addresses) ??
		matchCatchallAddress(candidates, domains, userId, receivedHere)
	);
}

/**
 * Reply context for a whole conversation. The default follows the address the
 * newest *inbound* message was received at, even when the newest message is our
 * own earlier reply (which may have gone out from the wrong identity). The
 * newest message's own match is kept as `also` so it stays selectable.
 */
export function matchThreadReplyFrom(
	messages: ReplyFromMessage[],
	addresses: ReplyFromAddress[],
	domains: ReplyFromDomain[],
	userId: string
): { preferred: ReplyFromMatch | null; also: ReplyFromMatch | null } {
	const latest = messages[messages.length - 1];
	if (!latest) return { preferred: null, also: null };

	const latestMatch = matchReplyFromAddress(latest, addresses, domains, userId);
	if (latest.direction === 'inbound') return { preferred: latestMatch, also: null };

	const lastInbound = [...messages].reverse().find((message) => message.direction === 'inbound');
	const inboundMatch = lastInbound
		? matchReplyFromAddress(lastInbound, addresses, domains, userId)
		: null;

	return { preferred: inboundMatch ?? latestMatch, also: inboundMatch ? latestMatch : null };
}

/** Received-at addresses of every inbound message in a conversation (lowercased). */
export function threadReceivedAtAddresses(messages: ReplyFromMessage[]): string[] {
	return uniqueAddresses(messages.flatMap((message) => receivedAtAddresses(message)));
}

export function replyFromOptionKey(addressId: string | null, address: string): string {
	return addressId ?? `address:${address.toLowerCase()}`;
}

/**
 * Owned identities, plus the received-at catch-all address(es) of this
 * conversation that have no row. Per message only — never a global list.
 */
export function replyFromOptions(
	addresses: ReplyFromAddress[],
	preferred: ReplyFromMatch | null,
	also: ReplyFromMatch | null = null
): ReplyFromOption[] {
	const options: ReplyFromOption[] = addresses.map((address) => ({
		key: replyFromOptionKey(address.id, address.address),
		address: address.address,
		addressId: address.id
	}));

	for (const extra of [also, preferred]) {
		if (!extra) continue;
		if (options.some((option) => option.address.toLowerCase() === extra.address.toLowerCase())) {
			continue;
		}
		options.unshift({
			key: replyFromOptionKey(extra.addressId, extra.address),
			address: extra.address,
			addressId: extra.addressId
		});
	}

	return options;
}

export function defaultReplyFromKey(
	addresses: ReplyFromAddress[],
	preferred: ReplyFromMatch | null
): string {
	if (preferred) {
		return replyFromOptionKey(preferred.addressId, preferred.address);
	}

	const fallback = addresses.find((address) => address.is_default) ?? addresses[0];
	return fallback ? replyFromOptionKey(fallback.id, fallback.address) : '';
}
