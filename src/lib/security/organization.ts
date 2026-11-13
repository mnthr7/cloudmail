import { getDomain } from 'tldts';

/**
 * The domain an organization registered, read against the Public Suffix List:
 * victim.co.uk and attacker.co.uk are two organizations, not one "co.uk", and
 * so are alice.github.io and bob.github.io (private suffixes count too, since
 * anyone can claim a name under them).
 *
 * Server-side only in practice: the list is ~45 KB gzipped, so the client keeps
 * the cheap `registrableDomain` in host.ts. Hosts the list can't place (an IP,
 * "localhost", a bare suffix like "co.uk") come back as themselves, so they only
 * ever match exactly.
 */
export function organizationDomain(host: string): string {
	const value = host.trim().toLowerCase().replace(/\.$/, '');
	if (!value) return '';
	return getDomain(value, { allowPrivateDomains: true }) ?? value;
}
