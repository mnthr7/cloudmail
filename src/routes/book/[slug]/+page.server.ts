import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { publicPage } from '#lib/server/booking-store.ts';

export const load: PageServerLoad = async ({ params, platform }) => {
	const db = platform?.env.DB;
	const page = db ? await publicPage(db, params.slug) : null;
	if (!page) error(404, 'This booking page is not available.');
	return { page };
};
