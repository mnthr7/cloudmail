import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
	assessMessage,
	looksLike,
	parseAuthResults,
	parseSecurity,
	type AssessInput
} from '../src/lib/security/phishing';
import { organizeInbound } from '../src/lib/server/organize-inbound';
import { checkInbound, setPhishingToSpam } from '../src/lib/server/phishing-check';
import { createAgent, setAgentStatus } from '../src/lib/server/agents-store';
import { defaultDefinition } from '../src/lib/agents/definition';

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


const PASS = { spf: 'pass', dkim: 'pass', dmarc: 'pass' } as const;
const UNKNOWN = { spf: null, dkim: null, dmarc: null };

function input(overrides: Partial<AssessInput>): AssessInput {
	return {
		fromAddress: 'pat@customer.com',
		fromName: 'Pat Lee',
		replyTo: null,
		subject: 'Quick question',
		text: 'Do you have time on Thursday?',
		auth: { ...PASS },
		ownDomains: ['acme.com'],
		teammateNames: ['Sada Kshirsagar'],
		contactDomains: ['customer.com', 'globex.com'],
		firstTimeSender: false,
		...overrides
	};
}

function codes(overrides: Partial<AssessInput>) {
	const result = assessMessage(input(overrides));
	return { verdict: result.verdict, codes: result.reasons.map((reason) => reason.code) };
}

describe('reading authentication results', () => {
	test('a failure wins over a pass, so a forged pass hides nothing', () => {
		expect(
			parseAuthResults([
				'mx.example; spf=pass smtp.mailfrom=x.com; dkim=pass header.i=@x.com; dmarc=pass',
				'amazonses.com; spf=fail smtp.mailfrom=x.com; dkim=none; dmarc=fail header.from=x.com'
			])
		).toEqual({ spf: 'fail', dkim: 'none', dmarc: 'fail' });
	});

	test('Received-SPF and missing headers', () => {
		expect(parseAuthResults([], ['SoftFail (domain does not designate 1.2.3.4)'])).toEqual({
			spf: 'softfail',
			dkim: null,
			dmarc: null
		});
		expect(parseAuthResults([])).toEqual(UNKNOWN);
	});
});

describe('lookalikes', () => {
	test('character swaps and typos', () => {
		expect(looksLike('paypa1', 'paypal')).toBe(true);
		expect(looksLike('acrne', 'acme')).toBe(true);
		expect(looksLike('micros0ft', 'microsoft')).toBe(true);
		expect(looksLike('paypal', 'paypal')).toBe(false);
		// Short names need more than a one-letter difference to count.
		expect(looksLike('acmo', 'acme')).toBe(false);
	});
});

describe('the verdict', () => {
	test('ordinary mail from a known contact is left alone', () => {
		expect(codes({})).toEqual({ verdict: null, codes: [] });
		expect(codes({ auth: UNKNOWN })).toEqual({ verdict: null, codes: [] });
		expect(codes({ fromAddress: 'service@paypal.com', fromName: 'PayPal' })).toEqual({ verdict: null, codes: [] });
	});

	test("mail claiming to be from your own domain that it can't prove", () => {
		expect(codes({ fromAddress: 'ceo@acme.com', auth: { spf: 'fail', dkim: 'none', dmarc: 'fail' } })).toEqual({
			verdict: 'phishing',
			codes: ['own_domain_unverified']
		});
		// Real mail from your domain passes.
		expect(codes({ fromAddress: 'ceo@acme.com' }).verdict).toBeNull();
	});

	test("a domain that says the message isn't theirs", () => {
		expect(codes({ auth: { spf: 'fail', dkim: 'fail', dmarc: 'fail' } })).toEqual({
			verdict: 'suspicious',
			codes: ['dmarc_failed']
		});
	});

	test('lookalike brand, own, and contact domains', () => {
		expect(codes({ fromAddress: 'billing@paypa1.com', fromName: 'PayPal Billing' }).verdict).toBe('phishing');
		expect(codes({ fromAddress: 'it@acrne.com' })).toMatchObject({ verdict: 'phishing', codes: ['lookalike_own'] });
		expect(codes({ fromAddress: 'ap@g1obex.com' })).toMatchObject({ verdict: 'suspicious', codes: ['lookalike_contact'] });
		expect(codes({ fromAddress: 'x@xn--pple-43d.com' }).codes).toContain('lookalike_characters');
	});

	test('a brand word inside a longer domain is only a hint', () => {
		expect(codes({ fromAddress: 'hello@apple-orchard-farm.com', fromName: 'Orchard' }).verdict).toBeNull();
		expect(
			codes({ fromAddress: 'alerts@paypal-secure.com', fromName: 'PayPal', firstTimeSender: true }).verdict
		).toBe('phishing');
	});

	test('names that pretend to be someone', () => {
		expect(codes({ fromAddress: 'sada.k@gmail.com', fromName: 'Sada Kshirsagar' })).toMatchObject({
			verdict: 'suspicious',
			codes: ['teammate_name']
		});
		expect(codes({ fromAddress: 'help@randomsite.ru', fromName: 'Apple Support' }).codes).toContain('brand_name');
	});

	test('a stranger asking for money, with replies going elsewhere', () => {
		const ask = {
			fromAddress: 'cfo@newvendor.io',
			firstTimeSender: true,
			subject: 'Updated invoice',
			text: 'Our bank details have changed. Please wire the payment to the new account today.',
			replyTo: 'Accounts <payables@other-domain.com>'
		};
		expect(codes(ask)).toEqual({ verdict: 'phishing', codes: ['money_ask', 'reply_to_elsewhere'] });
		// The same words from someone you already deal with aren't flagged.
		expect(codes({ ...ask, firstTimeSender: false }).verdict).toBeNull();
	});

	test('stored results read back safely', () => {
		const stored = assessMessage(input({ fromAddress: 'it@acrne.com' }));
		expect(parseSecurity(JSON.stringify(stored))).toEqual(stored);
		expect(parseSecurity('not json')).toBeNull();
		expect(parseSecurity(null)).toBeNull();
	});
});

describe('when mail arrives', () => {
	test('the check is stored, and Spam is opt-in', async () => {
		const { sqlite, db } = open();
		const spoof = addMail(sqlite, { from: 'ceo@acme.com', to: 'sada@acme.com', subject: 'Need a favor' });
		await organizeInbound(db, 'u1', spoof, {
			hasAttachment: false,
			authenticationResults: 'amazonses.com; spf=fail; dkim=none; dmarc=fail header.from=acme.com'
		});
		const first = sqlite.query(`SELECT security_json, is_spam, in_inbox FROM emails WHERE id = ?`).get(spoof) as {
			security_json: string;
			is_spam: number;
			in_inbox: number;
		};
		expect(parseSecurity(first.security_json)?.verdict).toBe('phishing');
		expect(first.is_spam).toBe(0);
		expect(first.in_inbox).toBe(1);

		await setPhishingToSpam(db, 'u1', true);
		const second = addMail(sqlite, { from: 'ceo@acme.com', to: 'sada@acme.com', subject: 'Another favor' });
		await organizeInbound(db, 'u1', second, {
			hasAttachment: false,
			authenticationResults: 'amazonses.com; spf=fail; dkim=none; dmarc=fail header.from=acme.com'
		});
		expect((sqlite.query(`SELECT is_spam FROM emails WHERE id = ?`).get(second) as { is_spam: number }).is_spam).toBe(1);
	});

	test('mail that looks like phishing never wakes an agent', async () => {
		const { sqlite, db } = open();
		const definition = { ...defaultDefinition('Help with support mail.'), scope: { sendAs: ['support@acme.com'], recipients: { kind: 'thread' as const } }, triggers: { watch: ['support@acme.com'] } };
		const agent = await createAgent(db, { ownerUserId: 'u1', displayName: 'Ava', definition });
		await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'active' });

		const phish = addMail(sqlite, { from: 'billing@paypa1.com', subject: 'Your account is locked' });
		await organizeInbound(db, 'u1', phish, { hasAttachment: false });
		const normal = addMail(sqlite, { from: 'pat@customer.com' });
		await organizeInbound(db, 'u1', normal, { hasAttachment: false });

		const runs = sqlite.query(`SELECT email_id FROM agent_runs`).all() as Array<{ email_id: string }>;
		expect(runs.map((run) => run.email_id)).toEqual([normal]);
	});

	test('only exactly this address counts as someone you know', async () => {
		const { sqlite, db } = open();
		const sent = (to: string) =>
			sqlite.run(
				`INSERT INTO emails (id, user_id, direction, from_addr, to_addr, subject, body_text, created_at, status)
				 VALUES (?, 'u1', 'outbound', 'sada@acme.com', ?, 'Hi', 'Hi', '2026-11-01T00:00:00Z', 'sent')`,
				[`out_${to}`, to]
			);
		sent('Joann Smith <joann@vendor.io>');
		const ask = { subject: 'Invoice', body: 'Our bank details have changed, please wire the payment.' };

		// A substring of someone you wrote to, or a wildcard address, is still a stranger.
		for (const from of ['ann@vendor.io', '%@vendor.io', '_oann@vendor.io']) {
			const id = addMail(sqlite, { from, to: 'sada@acme.com', ...ask });
			const result = await checkInbound(db, 'u1', id, {});
			expect(result?.reasons.map((reason) => reason.code)).toContain('money_ask');
		}
		// The real contact isn't.
		const known = addMail(sqlite, { from: 'joann@vendor.io', to: 'sada@acme.com', ...ask });
		expect((await checkInbound(db, 'u1', known, {}))?.verdict).toBeNull();
	});

	test("if the check can't run, no agent wakes up", async () => {
		const { sqlite, db } = open();
		const definition = { ...defaultDefinition('Help with support mail.'), scope: { sendAs: ['support@acme.com'], recipients: { kind: 'thread' as const } }, triggers: { watch: ['support@acme.com'] } };
		const agent = await createAgent(db, { ownerUserId: 'u1', displayName: 'Ava', definition });
		await setAgentStatus(db, { agentId: agent.id, byUserId: 'u1', status: 'active' });
		const email = addMail(sqlite, { from: 'pat@customer.com' });
		// Only saving the check's result fails; everything else works.
		sqlite.exec(`CREATE TRIGGER break_check BEFORE UPDATE OF security_json ON emails
		             BEGIN SELECT RAISE(ABORT, 'check failed'); END;`);
		await organizeInbound(db, 'u1', email, { hasAttachment: false });
		expect(sqlite.query(`SELECT COUNT(*) AS n FROM agent_runs`).get()).toEqual({ n: 0 });

		// The same mail with the check working does wake the agent, so the test is fair.
		sqlite.exec('DROP TRIGGER break_check');
		const again = addMail(sqlite, { from: 'pat@customer.com' });
		await organizeInbound(db, 'u1', again, { hasAttachment: false });
		expect(sqlite.query(`SELECT COUNT(*) AS n FROM agent_runs`).get()).toEqual({ n: 1 });
		// The mail is still filed.
		expect((sqlite.query(`SELECT in_inbox FROM emails WHERE id = ?`).get(email) as { in_inbox: number }).in_inbox).toBe(1);
	});
});
