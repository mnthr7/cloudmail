import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { readSubscription, resubscribeByToken, unsubscribeByToken } from '#lib/server/do-not-send.ts';

/**
 * The page behind the "Unsubscribe" link in marketing mail. Opening it changes
 * nothing: link scanners and mail previews fetch it too. The person presses a
 * button to unsubscribe, and can subscribe again from the same page.
 */
export const load: PageServerLoad = async ({ params, platform, setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
	const db = platform?.env.DB;
	const subscription = db ? await readSubscription(db, params.token) : null;
	return {
		subscription: subscription
			? { domain: subscription.scope, address: maskAddress(subscription.address), subscribed: subscription.subscribed }
			: null
	};
};

export const actions: Actions = {
	unsubscribe: async ({ params, platform }) => {
		const db = platform?.env.DB;
		if (!db) return fail(503, { error: 'Try again in a minute.' });
		const result = await unsubscribeByToken(db, params.token);
		if (!result) return fail(404, { error: "This link isn't valid." });
		return { done: 'unsubscribed' as const };
	},
	resubscribe: async ({ params, platform }) => {
		const db = platform?.env.DB;
		if (!db) return fail(503, { error: 'Try again in a minute.' });
		const result = await resubscribeByToken(db, params.token);
		if (!result) return fail(404, { error: "This link isn't valid." });
		return { done: 'resubscribed' as const };
	}
};

/** j•••@example.com: enough to recognise, not enough to harvest from a forwarded link. */
function maskAddress(address: string): string {
	const [local, domain] = address.split('@');
	if (!local || !domain) return address;
	return `${local[0]}${'•'.repeat(Math.min(Math.max(local.length - 1, 2), 6))}@${domain}`;
}
