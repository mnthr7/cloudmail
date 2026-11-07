import { json, type RequestHandler } from '@sveltejs/kit';
import { resolveFromAddress } from '#lib/server/outbox.ts';
import { saveDraft } from '#lib/server/mail-store.ts';
import type { OutboundAttachmentInput } from '#lib/types.ts';

type DraftAction = 'reply' | 'reply-all' | 'forward';

type DraftBody = {
	id?: string;
	fromAddressId?: string;
	fromAddress?: string;
	to?: string;
	cc?: string;
	bcc?: string;
	subject?: string;
	text?: string;
	html?: string;
	sourceEmailId?: string | null;
	draftAction?: DraftAction | null;
	attachments?: OutboundAttachmentInput[];
};

function draftAction(value: unknown): DraftAction | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (value === 'reply' || value === 'reply-all' || value === 'forward') return value;
	return undefined;
}

/** Create or update a draft. Drafts never touch Resend. */
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const db = platform?.env.DB;
	if (!db || !locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = (await request.json()) as DraftBody;
	const action = draftAction(body.draftAction);
	const sourceEmailId =
		typeof body.sourceEmailId === 'string'
			? body.sourceEmailId.trim() || null
			: body.sourceEmailId === null
				? null
				: undefined;

	try {
		const from = await resolveFromAddress(db, locals.user, body.fromAddressId, body.fromAddress);

		const id = await saveDraft(
			db,
			locals.user.id,
			{
				id: body.id,
				from: from.address,
				to: body.to?.trim() ?? '',
				cc: body.cc?.trim() || null,
				bcc: body.bcc?.trim() || null,
				subject: body.subject?.trim() ?? '',
				bodyText: body.text ?? null,
				bodyHtml: body.html ?? null,
				domainId: from.domain_id,
				sourceEmailId,
				draftAction: action,
				attachments: Array.isArray(body.attachments) ? body.attachments : undefined
			},
			platform?.env.ATTACHMENTS
		);

		return json({ ok: true, id });
	} catch (error) {
		return json(
			{ error: error instanceof Error ? error.message : 'Could not save draft' },
			{ status: 400 }
		);
	}
};
