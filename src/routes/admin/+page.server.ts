import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listUsers } from '#lib/server/auth.ts';
import {
	safeEmailProviderKind,
	listAvailableDomains,
	providerLoadError
} from '#lib/server/context.ts';
import { listAllAddresses, listUnroutedEmails } from '#lib/server/domains.ts';
import { providerStatusForUser, type ProviderStatus } from '#lib/server/ai-provider-store.ts';
import { DEMO_MODE } from '#lib/server/demo.ts';

export const load: PageServerLoad = async ({ locals, platform }) => {
	if (!locals.user?.is_admin) {
		throw error(403, 'Forbidden');
	}

	const providerKind = safeEmailProviderKind(platform);
	const db = platform?.env.DB;
	if (!db) {
		return {
			users: [],
			addresses: [],
			domains: locals.domains,
			available: [],
			unrouted: [],
			providerKind,
			ai: { providers: [] as ProviderStatus[], encryptionReady: false, demo: DEMO_MODE },
			loadError: 'Database unavailable'
		};
	}

	const [users, addresses, unrouted, providers] = await Promise.all([
		listUsers(db),
		listAllAddresses(db),
		listUnroutedEmails(db, 25),
		providerStatusForUser(db, locals.user.id).catch(() => [] as ProviderStatus[])
	]);
	// Only whether the secret is set reaches the page, never its value.
	const ai = { providers, encryptionReady: Boolean(platform?.env.AI_KEY_ENCRYPTION_KEY), demo: DEMO_MODE };

	try {
		const available = await listAvailableDomains(
			platform,
			locals.domains.map((domain) => domain.id)
		);

		return {
			users,
			addresses,
			unrouted,
			domains: locals.domains,
			available,
			providerKind,
			ai,
			loadError: null
		};
	} catch (err) {
		return {
			users,
			addresses,
			unrouted,
			domains: locals.domains,
			available: [],
			providerKind,
			ai,
			loadError: providerLoadError(providerKind, err)
		};
	}
};
