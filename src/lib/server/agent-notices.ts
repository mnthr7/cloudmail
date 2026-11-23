import type { D1Database } from '@cloudflare/workers-types';
import { APP_NOTICE_HEADER } from '#lib/organizing/categories.ts';
import { getUserById } from './auth.ts';
import type { EmailProvider } from './email-provider.ts';
import { resolveFromAddress } from './outbox.ts';
import { sendOutboundEmail } from './send-mail.ts';

/**
 * Tells an agent's owner that CloudMail paused it on its own (external-agents.md,
 * story 10): too many refused requests, or a webhook failing for a day. Sent
 * from and to their own address as an app notice, so it lands in their inbox
 * and never wakes an agent. Failing to send never undoes the pause.
 */

export type PauseReason = 'too_many_rejections' | 'webhooks_failing';

const WHY: Record<PauseReason, string> = {
	too_many_rejections:
		'More than 10 of its requests were refused in the last hour. That usually means it keeps trying something it isn’t allowed to, or something on its side went wrong.',
	webhooks_failing:
		'The webhook you set for it has failed for a whole day, so it hasn’t been hearing about new mail.'
};

export async function notifyAgentPaused(
	db: D1Database,
	provider: EmailProvider | null | undefined,
	agentId: string,
	reason: PauseReason
): Promise<boolean> {
	if (!provider) return false;
	try {
		const row = await db
			.prepare(
				`SELECT a.display_name AS agent_name, o.user_id AS owner_user_id
				 FROM principals a JOIN principals o ON o.id = a.owner_principal_id
				 WHERE a.id = ?`
			)
			.bind(agentId)
			.first<{ agent_name: string; owner_user_id: string | null }>();
		const owner = row?.owner_user_id ? await getUserById(db, row.owner_user_id) : null;
		if (!row || !owner) return false;
		const from = await resolveFromAddress(db, owner, null, null);
		await sendOutboundEmail(provider, {
			from,
			senderName: 'CloudMail',
			to: from.address,
			subject: `${row.agent_name} was paused`.slice(0, 200),
			text: [
				`CloudMail paused ${row.agent_name}.`,
				'',
				WHY[reason],
				'',
				'Nothing it asks for will run until you resume it. Look at its tool calls on the Staff page, then resume it there (or in shadow mode, to watch it first), or disconnect it.'
			].join('\n'),
			headers: { [APP_NOTICE_HEADER]: 'agent_paused' }
		});
		return true;
	} catch (error) {
		console.error('Failed to tell the owner an agent was paused', agentId, error);
		return false;
	}
}
