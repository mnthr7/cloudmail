import type { PageServerLoad } from './$types';
import { loadMailbox } from '#lib/server/mailbox.ts';

export const load: PageServerLoad = async ({ locals, platform, url }) =>
	loadMailbox(platform?.env.DB, locals.user?.id, 'starred', url, locals.activeDomainId);
