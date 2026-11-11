import type { PageServerLoad } from './$types';

/** The token is after "#" in the link, so the server never sees it here; the page sends it in a request body. */
export const load: PageServerLoad = async ({ setHeaders }) => {
	setHeaders({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
	return {};
};
