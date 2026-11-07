import type { PageServerLoad } from './$types';
import { loadMailbox } from '#lib/server/mailbox.ts';

export const load: PageServerLoad = async ({ locals, platform, url, params }) =>
	loadMailbox(platform?.env.DB, locals.user?.id, 'all', url, locals.activeDomainId, {
		labelId: params.id
	});
