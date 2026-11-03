// Demo mode is OFF unless the server env explicitly sets DEMO_MODE="true".
// It is never enabled by a URL/query parameter (that was an auth bypass).
// Never set DEMO_MODE in production config.
export const DEMO_MODE =
	typeof process !== 'undefined' && process.env?.DEMO_MODE === 'true';

/**
 * Demo mode is read-only: only safe methods, and never admin/setup/auth
 * surfaces, so a demo session can never reach mutating handlers or D1 writes.
 */
export function isDemoRequestAllowed(method: string, pathname: string): boolean {
	if (method !== 'GET' && method !== 'HEAD') return false;
	const blocked = ['/admin', '/api/admin', '/api/setup', '/api/auth', '/setup'];
	return !blocked.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// Fake user for demo
export const DEMO_USER = {
	id: 'demo-user-1',
	email: 'demo@cloudmail.test',
	name: 'Demo User',
	password_hash: 'demo',
	is_admin: false,
	created_at: new Date('2024-01-01').toISOString()
};

// Fake domain for demo
export const DEMO_DOMAIN = {
	id: 'demo-domain-1',
	user_id: 'demo-user-1',
	name: 'cloudmail.test',
	sending_enabled: true,
	receiving_enabled: true,
	status: 'verified' as const,
	region: null,
	catchall_user_id: 'demo-user-1',
	synced_at: new Date('2024-01-01').toISOString(),
	created_at: new Date('2024-01-01').toISOString()
};

// Fake address for demo
export const DEMO_ADDRESS = {
	id: 'demo-address-1',
	user_id: 'demo-user-1',
	domain_id: 'demo-domain-1',
	address: 'demo@cloudmail.test',
	domain_name: 'cloudmail.test',
	label: 'Demo',
	is_default: true,
	created_at: new Date('2024-01-01').toISOString()
};

// Labels shown in the demo sidebar. Read-only, like the rest of demo mode.
export const DEMO_LABELS = [
	{ id: 'label-work', parentId: null, name: 'Work', color: 'blue' as const, unread: 1 },
	{ id: 'label-clients', parentId: 'label-work', name: 'Clients', color: 'violet' as const, unread: 1 },
	{ id: 'label-receipts', parentId: null, name: 'Receipts', color: 'green' as const, unread: 0 },
	{ id: 'label-travel', parentId: null, name: 'Travel', color: 'amber' as const, unread: 0 }
];

type DemoCategory = 'primary' | 'social' | 'promotions' | 'updates' | 'forums';

function demoLabels(ids: string[]) {
	return DEMO_LABELS.filter((label) => ids.includes(label.id)).map(({ id, name, color }) => ({
		id,
		name,
		color
	}));
}

// Generate fake threads for demo. Every sender is fictional and uses a reserved
// .example domain, so screenshots never show a real company or person.
export function generateDemoThreads() {
	const now = Date.now();
	const hour = 60 * 60 * 1000;
	const day = 24 * hour;

	const thread = (
		id: string,
		ageMs: number,
		from: { address: string; name: string },
		subject: string,
		preview: string,
		extra: Partial<{
			to_addr: string;
			from_name: string | null;
			is_read: boolean;
			is_starred: boolean;
			is_important: boolean;
			is_draft: boolean;
			trashed: boolean;
			spam: boolean;
			message_count: number;
			has_attachments: boolean;
			direction: 'inbound' | 'outbound';
			status: 'delivered' | null;
			category: DemoCategory;
			label_ids: string[];
			in_inbox: boolean;
			snoozed_until: string | null;
			is_scheduled: boolean;
		}> = {}
	) => {
		const label_ids = extra.label_ids ?? [];
		return {
			thread_id: `thread-${id}`,
			latest_id: `msg-${id}`,
			domain_id: 'demo-domain-1',
			subject,
			from_addr: from.address,
			from_name: extra.from_name ?? from.name,
			to_addr: extra.to_addr ?? 'demo@cloudmail.test',
			preview,
			created_at: new Date(now - ageMs).toISOString(),
			is_read: extra.is_read ?? true,
			is_starred: extra.is_starred ?? false,
			is_draft: extra.is_draft ?? false,
			trashed: extra.trashed ?? false,
			message_count: extra.message_count ?? 1,
			has_attachments: extra.has_attachments ?? false,
			direction: extra.direction ?? ('inbound' as const),
			status: extra.status ?? null,
			participants: [{ address: from.address, label: from.name, self: false }],
			spam: extra.spam ?? false,
			category: extra.category ?? ('primary' as DemoCategory),
			is_important: extra.is_important ?? false,
			in_inbox: extra.in_inbox ?? true,
			snoozed_until: extra.snoozed_until ?? (null as string | null),
			is_muted: false,
			is_scheduled: extra.is_scheduled ?? false,
			label_ids,
			labels: demoLabels(label_ids)
		};
	};

	const maya = { address: 'maya@harbor-studio.example', name: 'Maya Ortiz' };
	const team = { address: 'team@lumen-labs.example', name: 'Lumen Labs' };

	return [
		thread('support', 25 * 60 * 1000, { address: 'jordan@brightpath.example', name: 'Jordan Lee' },
			'New ticket: charged twice this month',
			'Hi, I was charged twice for my March plan. Could someone from support take a look?',
			{ to_addr: 'support@cloudmail.test', is_read: false, is_important: true, label_ids: ['label-work', 'label-clients'] }),
		thread('coffee', 2 * hour, maya, 'Coffee Thursday?',
			"Are you free around 10? There's a new place by the harbor I've been meaning to try.",
			{ is_read: false, is_starred: true, message_count: 3 }),
		thread('roadmap', 5 * hour, team, 'Q3 roadmap: final review',
			"Here's the last pass on the roadmap. The big call is whether search ships before sharing.",
			{ is_read: false, message_count: 6, has_attachments: true, label_ids: ['label-work'] }),
		thread('phish', 7 * hour, { address: 'alerts@secure-verify.example', name: 'security@northwind-bank.example' },
			'Action required: confirm your account',
			'We noticed unusual activity. Confirm your details within 24 hours to avoid suspension.',
			{ is_read: false }),
		thread('flight', day, { address: 'trips@skyway-air.example', name: 'Skyway Air' },
			'Your trip to Lisbon is confirmed',
			'Booking SKW-48213. Departs 7:40 AM, seat 14A. Check in opens 24 hours before departure.',
			{ category: 'updates', has_attachments: true, label_ids: ['label-travel'] }),
		thread('receipt', day + 3 * hour, { address: 'billing@inkwell-cloud.example', name: 'Inkwell Cloud' },
			'Receipt for your Inkwell Pro plan',
			'Thanks for your payment of $12.00. Your receipt is attached.',
			{ category: 'updates', has_attachments: true, label_ids: ['label-receipts'] }),
		thread('sale', 2 * day, { address: 'hello@fernway-goods.example', name: 'Fernway Goods' },
			'Spring sale: 30% off everything',
			'Our biggest sale of the season starts now. Free shipping on orders over $50.',
			{ category: 'promotions' }),
		thread('meetup', 2 * day + 4 * hour, { address: 'events@circle-social.example', name: 'Circle' },
			'Priya invited you to Design Meetup',
			'Priya Raman invited you to Design Meetup on Saturday at 6:00 PM.',
			{ category: 'social' }),
		thread('forum', 3 * day, { address: 'digest@devtalk-forum.example', name: 'DevTalk Digest' },
			'Top threads this week: edge runtimes',
			'"Is SQLite at the edge ready for production?" and 14 more threads you might like.',
			{ category: 'forums' }),
		thread('proposal', 3 * day + 2 * hour, { address: 'demo@cloudmail.test', name: 'Demo User' },
			'Re: Proposal for Harbor Studio',
			"Thanks for the notes. I've updated the timeline and attached the revised estimate.",
			{ to_addr: maya.address, direction: 'outbound', status: 'delivered', message_count: 4, has_attachments: true, label_ids: ['label-work', 'label-clients'] }),
		thread('draft', 4 * day, { address: 'demo@cloudmail.test', name: 'Demo User' },
			'Follow-up on the design review',
			'Hi all, a quick follow-up on the open questions from Tuesday...',
			{ to_addr: team.address, direction: 'outbound', is_draft: true }),
		thread('scheduled', 0, { address: 'demo@cloudmail.test', name: 'Demo User' },
			'Monday standup notes',
			'Agenda for Monday: release checklist, on-call handoff, and hiring update.',
			{ to_addr: team.address, direction: 'outbound', is_scheduled: true, in_inbox: false }),
		thread('snoozed', 5 * day, { address: 'renewals@quietdomain.example', name: 'Quiet Domains' },
			'Your domain renews in 30 days',
			'harbor-studio.example renews on June 1. No action is needed if auto-renew is on.',
			{ category: 'updates', in_inbox: false, snoozed_until: new Date(now + 2 * day).toISOString() }),
		thread('notes', 6 * day, team, 'Meeting notes: design review',
			"Key takeaways from today's review: simplify onboarding, and keep the reading pane on by default.",
			{ is_starred: true, message_count: 2, label_ids: ['label-work'] }),
		thread('spam', 6 * day + 5 * hour, { address: 'winner@prize-center.example', name: 'Prize Center' },
			'You have been selected!!!',
			'Claim your reward now before it expires.',
			{ spam: true, in_inbox: false }),
		thread('trash', 7 * day, { address: 'news@oldletter.example', name: 'Old Letter' },
			'Weekly roundup #112',
			'This week in tooling, plus three links worth your time.',
			{ category: 'promotions', trashed: true })
	];
}

// Earlier messages in a multi-message demo thread, newest first.
const DEMO_REPLIES = [
	'Sounds good to me. I can have a draft ready by Wednesday.',
	'Agreed on the first two points. Can we talk through the third one live?',
	"I've attached my notes from last time so we're working from the same list.",
	'Quick update: the numbers came back better than expected.',
	'Kicking this off. Let me know what you think of the outline below.',
	'Thanks for pulling this together!',
	'Looping in the rest of the team so everyone has the context.'
];

// Generate full message details for a thread
export function generateDemoMessages(threadId: string) {
	const thread = generateDemoThreads().find((t) => t.thread_id === threadId || t.latest_id === threadId);
	if (!thread) return [];

	const baseMessage = {
		id: thread.latest_id,
		thread_id: threadId,
		user_id: 'demo-user-1',
		from_addr: thread.from_addr,
		from_name: thread.from_name,
		to_addr: thread.to_addr,
		cc_addr: null,
		bcc_addr: null,
		subject: thread.subject,
		body_text: generateBodyText(thread),
		body_html: generateBodyHtml(thread),
		message_id: `<${thread.latest_id}@cloudmail.test>`,
		references_header: null,
		reply_to_header: null,
		direction: thread.direction,
		status: thread.status,
		status_detail: null,
		is_read: thread.is_read,
		is_starred: thread.is_starred,
		is_draft: thread.is_draft,
		trashed: thread.trashed,
		deleted_at: null,
		created_at: thread.created_at,
		attachments: thread.has_attachments ? generateDemoAttachments() : []
	};

	// For multi-message threads, generate earlier messages
	if (thread.message_count > 1) {
		const messages = [baseMessage];
		const dayMs = 24 * 60 * 60 * 1000;

		for (let i = 1; i < thread.message_count; i++) {
			const timestamp = new Date(
				Date.parse(thread.created_at) - i * dayMs - Math.random() * dayMs
			).toISOString();

			messages.unshift({
				...baseMessage,
				id: `${thread.latest_id}-${i}`,
				message_id: `<${thread.latest_id}-${i}@cloudmail.test>`,
				created_at: timestamp,
				direction: i % 2 === 0 ? 'inbound' : ('outbound' as const),
				from_addr: i % 2 === 0 ? thread.from_addr : 'demo@cloudmail.test',
				from_name: i % 2 === 0 ? thread.from_name : 'Demo User',
				to_addr: i % 2 === 0 ? 'demo@cloudmail.test' : thread.from_addr,
				body_text: DEMO_REPLIES[(i - 1) % DEMO_REPLIES.length],
				body_html: `<p>${DEMO_REPLIES[(i - 1) % DEMO_REPLIES.length]}</p>`,
				attachments: []
			});
		}

		return messages;
	}

	return [baseMessage];
}

function generateBodyText(thread: any): string {
	return `${thread.preview}\n\nThis is a demo message in CloudMail.\n\n${thread.from_name ?? thread.from_addr}`;
}

function generateBodyHtml(thread: any): string {
	if (thread.thread_id === 'thread-phish') {
		// Shows the reading-safety features: a held remote image, a link whose
		// text and target disagree, and a display name that claims another address.
		return [
			'<p><img src="https://cdn.secure-verify.example/northwind-logo.png" alt="Northwind Bank" width="180"></p>',
			`<p>${thread.preview}</p>`,
			'<p><a href="https://secure-verify.example/login">https://northwind-bank.example/account</a></p>',
			'<p>Northwind Bank Security Team</p>'
		].join('');
	}
	return `<p>${thread.preview}</p><p>This is a demo message in CloudMail. The full content would appear here in a real email.</p><p>${thread.from_name ?? thread.from_addr}</p>`;
}

function generateDemoAttachments() {
	return [
		{
			id: 'attach-1',
			email_id: 'demo',
			filename: 'invoice.pdf',
			size_bytes: 45678,
			content_type: 'application/pdf',
			scan_status: 'skipped' as const,
			created_at: new Date().toISOString()
		}
	];
}

// In-memory store for demo mode mutations
class DemoStore {
	private threads = generateDemoThreads();

	getThreads() {
		return this.threads;
	}

	updateThread(id: string, updates: any) {
		const thread = this.threads.find((t) => t.latest_id === id || t.thread_id === id);
		if (thread) {
			Object.assign(thread, updates);
		}
	}

	addThread(thread: any) {
		this.threads.unshift(thread);
	}

	reset() {
		this.threads = generateDemoThreads();
	}
}

export const demoStore = new DemoStore();
