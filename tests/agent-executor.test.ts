import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import type { D1Database } from '@cloudflare/workers-types';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultDefinition, type AgentDefinition } from '../src/lib/agents/definition';
import {
	createAgent,
	decideAction,
	proposeAction,
	setAgentStatus,
	updateAgentDefinition
} from '../src/lib/server/agents-store';
import {
	MAX_AGENT_MESSAGES_WITHOUT_HUMAN,
	MAX_SENDS_PER_RECIPIENT_PER_DAY,
	disclosureFooter,
	executeAction,
	executePending
} from '../src/lib/server/agent-executor';
import { looksLikeAutoReply } from '../src/lib/agents/auto-reply';
import { explainDetail } from '../src/lib/agents/activity';
import { enqueueMailRuns } from '../src/lib/server/agent-runs-store';
import { runDueAgents, type MessagesClient } from '../src/lib/server/agent-runner';
import {
	handBackThread,
	isThreadTakenOver,
	takeOverThread,
	threadActivity
} from '../src/lib/server/thread-activity-store';

const MIGRATIONS = path.join(import.meta.dir, '../migrations');

function adapt(sqlite: Database): D1Database {
	const statement = (sql: string, values: unknown[] = []) => ({
		sql,
		values,
		bind: (...params: unknown[]) => statement(sql, params.map((value) => (value === undefined ? null : value))),
		async first<T>() {
			return (sqlite.query(sql).get(...(values as never[])) as T) ?? null;
		},
		async all<T>() {
			return { results: sqlite.query(sql).all(...(values as never[])) as T[], success: true, meta: {} };
		},
		async run() {
			const info = sqlite.run(sql, values as never[]);
			return { success: true, meta: { changes: info.changes } };
		}
	});
	return {
		prepare: (sql: string) => statement(sql),
		async batch(statements: Array<ReturnType<typeof statement>>) {
			return sqlite.transaction(() => statements.map((s) => sqlite.run(s.sql, s.values as never[])))();
		}
	} as unknown as D1Database;
}

function addUser(sqlite: Database, id: string, name: string, addresses: string[], isAdmin = false) {
	sqlite.run(`INSERT INTO users (id, email, name, password_hash, is_admin) VALUES (?, ?, ?, 'x', ?)`, [
		id,
		`${id}@login.test`,
		name,
		isAdmin ? 1 : 0
	]);
	sqlite.run(`INSERT OR IGNORE INTO domains (id, name) VALUES ('d1', 'acme.com')`);
	for (const address of addresses) {
		sqlite.run(`INSERT INTO addresses (id, user_id, domain_id, address) VALUES (?, ?, 'd1', ?)`, [
			`ad_${address}`,
			id,
			address
		]);
	}
}

function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec('PRAGMA foreign_keys = ON');
	for (const file of readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));
	}
	addUser(sqlite, 'u1', 'Sada', ['sada@acme.com', 'support@acme.com']);
	return { sqlite, db: adapt(sqlite) };
}

let mailCount = 0;
function addMail(
	sqlite: Database,
	input: {
		user?: string;
		to?: string;
		cc?: string;
		from?: string;
		subject?: string;
		body?: string;
		thread?: string;
		direction?: string;
		messageId?: string;
		inReplyTo?: string;
	}
): string {
	const id = `m${++mailCount}`;
	sqlite.run(
		`INSERT INTO emails (id, user_id, direction, from_addr, to_addr, subject, body_text, thread_id, created_at,
		                     cc_addr, message_id, in_reply_to)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			id,
			input.user ?? 'u1',
			input.direction ?? 'inbound',
			input.from ?? 'pat@customer.com',
			input.to ?? 'support@acme.com',
			input.subject ?? 'Help with my order',
			input.body ?? 'Where is my order #123?',
			input.thread ?? id,
			new Date(Date.UTC(2026, 10, 7, 12, mailCount)).toISOString(),
			input.cc ?? null,
			input.messageId ?? null,
			input.inReplyTo ?? null
		]
	);
	return id;
}

const NOW = new Date('2026-11-09T15:00:00Z');

/** Sends replies on its own: the riskiest setup, so the guards get exercised. */
function autoSender(overrides: Partial<AgentDefinition['capabilities']> = {}): AgentDefinition {
	const base = defaultDefinition('Answer customer questions sent to support@.');
	return {
		...base,
		capabilities: {
			...base.capabilities,
			send_reply: { level: 'auto' },
			write_note: { level: 'auto' },
			organize: { level: 'approve' },
			...overrides
		},
		scope: { sendAs: ['support@acme.com'], recipients: { kind: 'thread' } },
		triggers: { watch: ['support@acme.com'] }
	};
}

async function hire(db: D1Database, definition = autoSender()) {
	const agent = await createAgent(db, { ownerUserId: 'u1', displayName: 'Ava', definition }, NOW);
	await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'active' });
	return agent;
}

async function proposeReply(
	db: D1Database,
	agentId: string,
	email: string,
	thread: string,
	to = ['pat@customer.com'],
	when = NOW
) {
	return proposeAction(
		db,
		{
			agentId,
			proposal: { capability: 'send_reply', fromAddress: 'support@acme.com', recipients: to },
			threadId: thread,
			payload: { threadId: thread, emailId: email, from: 'support@acme.com', to, cc: [], subject: 'Re: Help', body: 'Your order ships Monday.\n\nAva' },
			reason: 'Answer the question',
			threadParticipants: ['pat@customer.com', 'lee@customer.com'],
			mailboxUserId: 'u1'
		},
		when
	);
}

function actionRow(sqlite: Database, id: string) {
	return sqlite
		.query(`SELECT status, result_ref, exec_error, executed_at FROM agent_actions WHERE id = ?`)
		.get(id) as { status: string; result_ref: string | null; exec_error: string | null; executed_at: string | null };
}

describe('carrying out agent actions', () => {
	test('an auto-allowed reply is queued once, from the authorized address, with the AI notice', async () => {
		const { sqlite, db } = open();
		const agent = await hire(db);
		const email = addMail(sqlite, { messageId: '<m1@customer.com>' });
		const { actionId, decision } = await proposeReply(db, agent.id, email, email);
		expect(decision.outcome).toBe('execute');

		const result = await executeAction(db, actionId, NOW);
		expect(result.status).toBe('executed');
		const row = actionRow(sqlite, actionId);
		expect(row.status).toBe('executed');

		const sent = sqlite
			.query(`SELECT from_addr, to_addr, status, body_text, in_reply_to, thread_id FROM emails WHERE id = ?`)
			.get(row.result_ref) as Record<string, string>;
		expect(sent.from_addr).toBe('support@acme.com');
		expect(sent.to_addr).toBe('pat@customer.com');
		expect(sent.thread_id).toBe(email);
		expect(sent.in_reply_to).toBe('<m1@customer.com>');
		expect(sent.body_text).toContain('Your order ships Monday.');
		expect(sent.body_text).toContain(disclosureFooter('Ava', 'Sada'));

		// Running it again does nothing.
		expect((await executeAction(db, actionId, NOW)).status).toBe('skipped');
		expect((sqlite.query(`SELECT COUNT(*) AS n FROM emails WHERE direction = 'outbound'`).get() as { n: number }).n).toBe(1);
	});

	test('only addresses the policy checked go out, whatever the payload says', async () => {
		const { sqlite, db } = open();
		const agent = await hire(db);
		const email = addMail(sqlite, {});
		const { actionId } = await proposeReply(db, agent.id, email, email);
		// Tamper with the payload after the policy decided.
		sqlite.run(`UPDATE agent_actions SET payload_json = json_set(payload_json, '$.to', json('["pat@customer.com","evil@x.com"]')) WHERE id = ?`, [actionId]);
		await executeAction(db, actionId, NOW);
		const ref = actionRow(sqlite, actionId).result_ref;
		const sent = sqlite.query(`SELECT to_addr FROM emails WHERE id = ?`).get(ref) as { to_addr: string };
		expect(sent.to_addr).toBe('pat@customer.com');
	});

	test('approving a queued proposal carries it out: a label is created and applied', async () => {
		const { sqlite, db } = open();
		const agent = await hire(db);
		const email = addMail(sqlite, {});
		const { actionId, decision } = await proposeAction(
			db,
			{
				agentId: agent.id,
				proposal: { capability: 'organize' },
				threadId: email,
				payload: { threadId: email, emailId: email, action: 'add_label', label: 'Orders' },
				mailboxUserId: 'u1'
			},
			NOW
		);
		expect(decision.outcome).toBe('queue');
		// Nothing happens before a human says so.
		expect((await executeAction(db, actionId, NOW)).status).toBe('skipped');

		await decideAction(db, { actionId, byUserId: 'u1', decision: 'approve' }, NOW);
		expect((await executeAction(db, actionId, NOW)).status).toBe('executed');
		const labelled = sqlite
			.query(`SELECT l.name FROM labels l JOIN thread_labels t ON t.label_id = l.id WHERE t.thread_id = ?`)
			.all(email) as Array<{ name: string }>;
		expect(labelled.map((row) => row.name)).toEqual(['Orders']);

		const activity = await threadActivity(db, 'u1', email);
		const item = activity.items.find((entry) => entry.kind === 'action');
		expect(item).toMatchObject({ what: 'Label "Orders"', state: 'done', decidedBy: 'Sada' });
	});

	test('a note shows on the thread for its owner', async () => {
		const { sqlite, db } = open();
		const agent = await hire(db);
		const email = addMail(sqlite, {});
		const { actionId } = await proposeAction(
			db,
			{
				agentId: agent.id,
				proposal: { capability: 'write_note' },
				threadId: email,
				payload: { threadId: email, emailId: email, note: 'Pat has asked twice this week.' },
				mailboxUserId: 'u1'
			},
			NOW
		);
		await executeAction(db, actionId, NOW);
		const activity = await threadActivity(db, 'u1', email);
		expect(activity.items).toEqual([
			expect.objectContaining({ kind: 'note', agentName: 'Ava', body: 'Pat has asked twice this week.' })
		]);
	});

	test('a paused agent does nothing, even with an approval', async () => {
		const { sqlite, db } = open();
		const agent = await hire(db);
		const email = addMail(sqlite, {});
		const { actionId } = await proposeReply(db, agent.id, email, email);
		await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'paused' });
		expect(await executeAction(db, actionId, NOW)).toEqual({ status: 'failed', error: 'agent_paused' });
		expect(actionRow(sqlite, actionId).status).toBe('auto_approved');
		// A failure isn't retried later.
		expect(await executePending(db, NOW)).toBe(0);
	});

	test('the decision is made again against the agent as it is now', async () => {
		const { sqlite, db } = open();
		const agent = await hire(db);

		// Back in shadow mode: nothing runs.
		const first = addMail(sqlite, {});
		const shadowed = await proposeReply(db, agent.id, first, first);
		await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'shadow' });
		expect(await executeAction(db, shadowed.actionId, NOW)).toEqual({ status: 'failed', error: 'agent_in_shadow' });
		await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'active' });

		// Sending turned down to "ask me first": what was allowed on its own no longer runs.
		const second = addMail(sqlite, {});
		const auto = await proposeReply(db, agent.id, second, second);
		await updateAgentDefinition(db, {
			agentId: agent.id,
			byUserId: 'u1',
			definition: autoSender({ send_reply: { level: 'approve' } })
		});
		await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'active' });
		expect(await executeAction(db, auto.actionId, NOW)).toEqual({ status: 'failed', error: 'needs_approval' });

		// The send-as address taken away: refused outright.
		const third = addMail(sqlite, {});
		const queued = await proposeReply(db, agent.id, third, third);
		await decideAction(db, { actionId: queued.actionId, byUserId: 'u1', decision: 'approve' }, NOW);
		const narrowed = autoSender({ send_reply: { level: 'approve' } });
		await updateAgentDefinition(db, {
			agentId: agent.id,
			byUserId: 'u1',
			definition: { ...narrowed, scope: { ...narrowed.scope, sendAs: [] } }
		});
		await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'active' });
		expect(await executeAction(db, queued.actionId, NOW)).toEqual({ status: 'failed', error: 'send_as_out_of_scope' });
		expect((sqlite.query(`SELECT COUNT(*) AS n FROM emails WHERE direction = 'outbound'`).get() as { n: number }).n).toBe(0);
	});

	test('the cron finishes an allowed action whose request was cut off', async () => {
		const { sqlite, db } = open();
		const agent = await hire(db);
		const email = addMail(sqlite, {});
		const { actionId } = await proposeReply(db, agent.id, email, email);
		expect(await executePending(db, new Date(NOW.getTime() + 60_000))).toBe(1);
		expect(actionRow(sqlite, actionId).status).toBe('executed');
	});
});

describe('loop and runaway protection', () => {
	test('subjects that mean a machine answered', () => {
		for (const subject of ['Automatic reply: Help', 'Out of Office: back Monday', 'Auto: away', 'Undeliverable: Help', 'AutoReply']) {
			expect(looksLikeAutoReply(subject)).toBe(true);
		}
		for (const subject of ['Re: Help with my order', 'About your automatic renewal', 'Office hours']) {
			expect(looksLikeAutoReply(subject)).toBe(false);
		}
	});

	test('an out-of-office reply never wakes an agent', async () => {
		const { sqlite, db } = open();
		await hire(db);
		const email = addMail(sqlite, { subject: 'Out of Office: back Monday' });
		expect(await enqueueMailRuns(db, 'u1', email, {}, NOW)).toBe(0);
	});

	test('answering an automatic reply is stopped, and the founder gets a note', async () => {
		const { sqlite, db } = open();
		const agent = await hire(db);
		const first = addMail(sqlite, {});
		const auto = addMail(sqlite, { thread: first, subject: 'Automatic reply: Help with my order' });
		const { actionId } = await proposeReply(db, agent.id, auto, first);
		expect(await executeAction(db, actionId, NOW)).toEqual({ status: 'blocked', error: 'loop_auto_reply' });

		const activity = await threadActivity(db, 'u1', first);
		expect(activity.items.some((item) => item.kind === 'alert')).toBe(true);
		expect(activity.items.find((item) => item.kind === 'action')).toMatchObject({ state: 'stopped', detail: 'loop_auto_reply' });
		expect(explainDetail('stopped', 'loop_auto_reply')).toContain('automatic reply');
	});

	test(`no more than ${MAX_SENDS_PER_RECIPIENT_PER_DAY} agent emails to one person a day`, async () => {
		const { sqlite, db } = open();
		const agent = await hire(db, autoSender({ send_reply: { level: 'auto', dailyLimit: 50 } }));
		const results: string[] = [];
		for (let i = 0; i <= MAX_SENDS_PER_RECIPIENT_PER_DAY; i++) {
			const email = addMail(sqlite, {});
			const { actionId } = await proposeReply(db, agent.id, email, email);
			results.push((await executeAction(db, actionId, NOW)).status);
		}
		expect(results).toEqual([...Array(MAX_SENDS_PER_RECIPIENT_PER_DAY).fill('executed'), 'blocked']);
	});

	test('sends being carried out at the same moment count toward the cap', async () => {
		const { sqlite, db } = open();
		const agent = await hire(db, autoSender({ send_reply: { level: 'auto', dailyLimit: 50 } }));
		const ids: string[] = [];
		for (let i = 0; i <= MAX_SENDS_PER_RECIPIENT_PER_DAY; i++) {
			const email = addMail(sqlite, {});
			ids.push((await proposeReply(db, agent.id, email, email)).actionId);
		}
		// Every other request has claimed its send and is mid-way through it.
		for (const id of ids.slice(0, -1)) {
			sqlite.run(`UPDATE agent_actions SET exec_claimed_at = ? WHERE id = ?`, [NOW.toISOString(), id]);
		}
		expect(await executeAction(db, ids.at(-1)!, NOW)).toEqual({ status: 'blocked', error: 'loop_recipient_flood' });
	});

	test(`a thread stops after ${MAX_AGENT_MESSAGES_WITHOUT_HUMAN} agent messages with nobody from our side`, async () => {
		const { sqlite, db } = open();
		const agent = await hire(db, autoSender({ send_reply: { level: 'auto', dailyLimit: 50 } }));
		const first = addMail(sqlite, {});
		const statuses: string[] = [];
		for (let i = 0; i <= MAX_AGENT_MESSAGES_WITHOUT_HUMAN; i++) {
			// Each to someone new on the thread, so the per-person guard stays out of the way.
			const to = [`person${i}@customer.com`];
			addMail(sqlite, { thread: first, from: to[0] });
			const { actionId } = await proposeAction(
				db,
				{
					agentId: agent.id,
					proposal: { capability: 'send_reply', fromAddress: 'support@acme.com', recipients: to },
					threadId: first,
					payload: { threadId: first, emailId: first, to, cc: [], subject: 'Re: Help', body: 'Hi' },
					threadParticipants: to,
					mailboxUserId: 'u1'
				},
				NOW
			);
			statuses.push((await executeAction(db, actionId, new Date(NOW.getTime() + i * 1000))).status);
		}
		expect(statuses.at(-1)).toBe('blocked');
		expect(statuses.slice(0, -1).every((status) => status === 'executed')).toBe(true);

		// The founder writing on the thread resets it.
		sqlite.run(
			`INSERT INTO emails (id, user_id, direction, from_addr, to_addr, subject, body_text, thread_id, created_at, status)
			 VALUES ('human1', 'u1', 'outbound', 'sada@acme.com', 'pat@customer.com', 'Re: Help', 'On it', ?, ?, 'sent')`,
			[first, new Date(NOW.getTime() + 60_000).toISOString()]
		);
		const to = ['someone@customer.com'];
		addMail(sqlite, { thread: first, from: to[0] });
		const { actionId } = await proposeAction(
			db,
			{
				agentId: agent.id,
				proposal: { capability: 'send_reply', fromAddress: 'support@acme.com', recipients: to },
				threadId: first,
				payload: { threadId: first, emailId: first, to, cc: [], subject: 'Re: Help', body: 'Hi' },
				threadParticipants: to,
				mailboxUserId: 'u1'
			},
			NOW
		);
		expect((await executeAction(db, actionId, new Date(NOW.getTime() + 120_000))).status).toBe('executed');
	});
});

describe('taking a thread over', () => {
	test('agents stop acting; waiting proposals expire; handing back lets them work again', async () => {
		const { sqlite, db } = open();
		const agent = await hire(db);
		const email = addMail(sqlite, {});
		const auto = await proposeReply(db, agent.id, email, email);
		const queued = await proposeAction(
			db,
			{
				agentId: agent.id,
				proposal: { capability: 'organize' },
				threadId: email,
				payload: { threadId: email, emailId: email, action: 'archive' },
				mailboxUserId: 'u1'
			},
			NOW
		);

		await takeOverThread(db, 'u1', email, NOW);
		expect(await isThreadTakenOver(db, 'u1', email)).toBe(true);
		expect(await executeAction(db, auto.actionId, NOW)).toEqual({ status: 'failed', error: 'thread_taken_over' });
		expect(actionRow(sqlite, queued.actionId).status).toBe('expired');

		const activity = await threadActivity(db, 'u1', email);
		expect(activity.takenOver).toBe(true);
		expect(activity.items.some((item) => item.kind === 'takeover')).toBe(true);

		await handBackThread(db, 'u1', email);
		addMail(sqlite, { thread: email, from: 'lee@customer.com' });
		const again = await proposeReply(db, agent.id, email, email, ['lee@customer.com']);
		expect((await executeAction(db, again.actionId, NOW)).status).toBe('executed');
	});

	test("new mail on a taken-over thread doesn't wake the agent's model", async () => {
		const { sqlite, db } = open();
		await hire(db);
		const email = addMail(sqlite, {});
		await takeOverThread(db, 'u1', email, NOW);
		expect(await enqueueMailRuns(db, 'u1', email, {}, NOW)).toBe(1);

		let calls = 0;
		const client: MessagesClient = {
			async create() {
				calls++;
				throw new Error('should not be called');
			}
		};
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client }, { now: () => NOW });
		expect(calls).toBe(0);
		const run = sqlite.query(`SELECT status, outcome FROM agent_runs`).get() as { status: string; outcome: string };
		expect(run).toEqual({ status: 'skipped', outcome: 'taken_over' });
	});
});

describe('the runner carries out what it is allowed to', () => {
	test('a note the policy allows lands on the thread in the same run', async () => {
		const { sqlite, db } = open();
		await hire(db);
		const email = addMail(sqlite, {});
		await enqueueMailRuns(db, 'u1', email, {}, NOW);
		const responses: Anthropic.Beta.BetaMessage['content'][] = [
			[
				{
					type: 'tool_use',
					id: 'tu1',
					name: 'write_note',
					input: { note: 'Pat is asking about order #123.', reason: 'Context for the founder' }
				} as Anthropic.Beta.BetaToolUseBlock
			],
				[{ type: 'text', text: 'Noted the order.', citations: null } as Anthropic.Beta.BetaTextBlock]
		];
		const results: string[] = [];
		const client: MessagesClient = {
			async create(params) {
				const last = params.messages.at(-1);
				if (last && Array.isArray(last.content)) {
					for (const block of last.content) {
						if (block.type === 'tool_result' && typeof block.content === 'string') results.push(block.content);
					}
				}
				const content = responses.shift()!;
				return {
					id: 'msg', type: 'message', role: 'assistant', model: params.model, stop_sequence: null,
					stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
					usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
					content
				} as Anthropic.Beta.BetaMessage;
			}
		};
		await runDueAgents(db, { workspaces: ['default'], clientFor: async () => client }, { now: () => NOW });
		expect(results).toEqual(['Done.']);
		const action = sqlite.query(`SELECT status FROM agent_actions`).get() as { status: string };
		expect(action.status).toBe('executed');
		const activity = await threadActivity(db, 'u1', email);
		expect(activity.items).toEqual([expect.objectContaining({ kind: 'note', body: 'Pat is asking about order #123.' })]);
	});
});
