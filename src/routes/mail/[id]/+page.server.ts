import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { isMailCategory } from '#lib/organizing/categories.ts';
import {
	getEmailForUser,
	listThreadLabels,
	listThreadMessages,
	markThreadRead
} from '#lib/server/mail-store.ts';
import { displaySubject } from '#lib/server/threads.ts';
import { askableAgents } from '#lib/server/agent-runs-store.ts';
import { invitesForEmails } from '#lib/server/calendar-invites.ts';
import { threadActivity, type ThreadActivity } from '#lib/server/thread-activity-store.ts';
import { openSuggestion, type ReplySuggestion } from '#lib/server/reply-suggestions-store.ts';
import { DEMO_MODE, DEMO_USER, generateDemoMessages, demoStore } from '#lib/server/demo.ts';

export const load: PageServerLoad = async ({ params, locals, platform, url }) => {
	if (!locals.user) {
		throw error(401, 'Unauthorized');
	}

	// Demo mode: return fake thread
	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	const isDemoMode = DEMO_MODE;

	if (isDemoMode && locals.user.id === DEMO_USER.id) {
		const messages = generateDemoMessages(params.id);
		if (messages.length === 0) {
			throw error(404, 'Email not found');
		}

		// Mark as read
		demoStore.updateThread(params.id, { is_read: true });

		const stored = demoStore
			.getThreads()
			.find((thread) => thread.thread_id === params.id || thread.latest_id === params.id);

		return {
			threadId: messages[0].thread_id,
			focusId: params.id,
			trashed: Boolean(messages[0].trashed),
			spam: Boolean(stored?.spam),
			subject: displaySubject(messages[0].subject),
			inInbox: stored?.in_inbox ?? true,
			isMuted: stored?.is_muted ?? false,
			isImportant: stored?.is_important ?? false,
			category: stored?.category ?? 'primary',
			labels: stored?.labels ?? [],
			messages: messages.map((message) => ({ ...message, is_read: true })),
			agents: [] as Array<{ id: string; name: string }>,
			suggestion: null as ReplySuggestion | null,
			activity: null as ThreadActivity | null
		};
	}

	if (!platform?.env.DB) {
		throw error(401, 'Unauthorized');
	}

	const email = await getEmailForUser(platform.env.DB, locals.user.id, params.id);
	if (!email) {
		throw error(404, 'Email not found');
	}

	// Opening any message opens its whole conversation.
	await markThreadRead(platform.env.DB, locals.user.id, email);
	const messages = await listThreadMessages(platform.env.DB, locals.user.id, email);

	const threadId = email.thread_id ?? email.id;
	const labels = await listThreadLabels(platform.env.DB, locals.user.id, threadId);
	// Agents this user may ask for help here. A lookup failure only hides the button.
	const [agents, suggestion, activity, invites] = await Promise.all([
		askableAgents(platform.env.DB, locals.user.id).catch(() => []),
		openSuggestion(platform.env.DB, locals.user.id, threadId).catch(() => null),
		threadActivity(platform.env.DB, locals.user.id, threadId).catch((): ThreadActivity | null => null),
		invitesForEmails(platform.env.DB, locals.user.id, messages.map((message) => message.id)).catch(
			() => ({}) as Record<string, never>
		)
	]);

	return {
		threadId,
		/** The message that was linked to — expanded first when the page opens. */
		focusId: email.id,
		trashed: Boolean(email.deleted_at),
		spam: Number(email.is_spam) === 1,
		subject: displaySubject(messages[0]?.subject ?? email.subject),
		inInbox: email.in_inbox === 1,
		isMuted: email.is_muted === 1,
		isImportant: email.is_important === 1,
		category: isMailCategory(email.category) ? email.category : 'primary',
		labels,
		messages: messages.map((message) => ({ ...message, is_read: true, invite: invites[message.id] ?? null })),
		agents: agents.map((agent) => ({ id: agent.id, name: agent.name })),
		suggestion,
		activity
	};
};
