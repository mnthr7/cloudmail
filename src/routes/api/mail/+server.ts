import { json, type RequestHandler } from '@sveltejs/kit';
import { deleteDraft, listEmails } from '#lib/server/mail-store.ts';
import { queueOutbound } from '#lib/server/queue-outbound.ts';
import { holdUntil, scheduleError } from '#lib/writing/timing.ts';
import { DEMO_MODE, DEMO_USER } from '#lib/server/demo.ts';

type SendMailBody = {
	/** Set when the composer was editing a draft — it is removed once queued. */
	draftId?: string;
	fromAddressId?: string;
	fromAddress?: string;
	to?: string;
	cc?: string;
	bcc?: string;
	subject?: string;
	text?: string;
	html?: string;
	/** Schedule send. Absent means an undo hold. */
	sendAt?: string;
};

export const GET: RequestHandler = async ({ locals, platform, url }) => {
	const db = platform?.env.DB;
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	// Demo mode: no emails to list (or return empty)
	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	const isDemoMode = DEMO_MODE;

	if (isDemoMode && locals.user.id === DEMO_USER.id) {
		return json({ emails: [] });
	}

	if (!db) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const direction = url.searchParams.get('direction');
	const emails = await listEmails(db, locals.user.id, {
		direction: direction === 'inbound' || direction === 'outbound' ? direction : undefined,
		domainId: locals.activeDomainId
	});

	return json({ emails });
};

export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const db = platform?.env.DB;
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = (await request.json()) as SendMailBody;

	if (!body.to?.trim() || !body.subject?.trim() || (!body.text?.trim() && !body.html?.trim())) {
		return json({ error: 'To, subject, and message are required' }, { status: 400 });
	}

	// Demo mode: fake send. Hooks already reject this POST; the shape matches a real queue.
	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	const isDemoMode = DEMO_MODE;

	if (isDemoMode && locals.user.id === DEMO_USER.id) {
		const fakeId = `demo-sent-${Date.now()}`;
		return json({ id: fakeId, sendAt: holdUntil(new Date(), 10) });
	}

	if (!db) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const explicitSendAt = body.sendAt?.trim() ?? '';
	if (explicitSendAt) {
		const message = scheduleError(explicitSendAt, new Date());
		if (message) return json({ error: message }, { status: 400 });
	}

	try {
		const queued = await queueOutbound(db, locals.user, {
			fromAddressId: body.fromAddressId,
			fromAddress: body.fromAddress,
			to: body.to,
			cc: body.cc,
			bcc: body.bcc,
			subject: body.subject,
			text: body.text,
			html: body.html,
			sendAt: body.sendAt
		});

		if (body.draftId) {
			await deleteDraft(db, locals.user.id, body.draftId);
		}

		return json({ id: queued.id, sendAt: queued.sendAt });
	} catch (error) {
		const message = error instanceof Error && error.message ? error.message : 'Failed to send email';
		return json({ error: message }, { status: 400 });
	}
};
