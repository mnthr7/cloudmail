import { json, type RequestHandler } from '@sveltejs/kit';
import { getUserById } from '#lib/server/auth.ts';
import { createAddress } from '#lib/server/domains.ts';

/**
 * Gives an existing user another address, e.g. on a newly connected domain.
 * Without this the only way to hand out an address was to create a new user,
 * which also created a second login nobody wanted.
 */
export const POST: RequestHandler = async ({ request, locals, platform, params }) => {
	if (!locals.user?.is_admin) {
		return json({ error: 'Forbidden' }, { status: 403 });
	}

	const db = platform?.env.DB;
	if (!db) return json({ error: 'Database unavailable' }, { status: 503 });

	const user = params.id ? await getUserById(db, params.id) : null;
	if (!user) return json({ error: 'User not found' }, { status: 404 });

	const body = (await request.json().catch(() => ({}))) as {
		domainId?: string;
		localPart?: string;
	};

	if (!body.localPart?.trim() || !body.domainId) {
		return json({ error: 'Address and domain are required' }, { status: 400 });
	}

	try {
		const address = await createAddress(db, {
			userId: user.id,
			domainId: body.domainId,
			localPart: body.localPart,
			allowReserved: true
		});
		return json({ address }, { status: 201 });
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Failed to add address' },
			{ status: 400 }
		);
	}
};
