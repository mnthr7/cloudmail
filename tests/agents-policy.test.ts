import { describe, expect, test } from 'bun:test';
import { CAPABILITIES, CAPABILITY_TRAITS } from '../src/lib/agents/capabilities';
import {
	AgentDefinitionError,
	defaultDefinition,
	parseDefinition,
	type AgentDefinition
} from '../src/lib/agents/definition';
import { authorize, type PolicyContext, type Proposal } from '../src/lib/agents/policy';

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		job: 'Chase overdue invoices politely.',
		capabilities: {
			read_threads: { level: 'auto' },
			write_note: { level: 'auto' },
			draft_reply: { level: 'auto' },
			organize: { level: 'approve' },
			send_reply: { level: 'auto', dailyLimit: 3 },
			send_email: { level: 'approve' },
			calendar: { level: 'auto' },
			set_timer: { level: 'off' }
		},
		scope: { sendAs: ['billing@acme.com'], recipients: { kind: 'thread' } },
		...overrides
	};
}

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
	return {
		status: 'active',
		runtime: 'builtin',
		definition: definition(),
		threadParticipants: ['client@globex.com', 'billing@acme.com'],
		founderAddresses: ['sada@acme.com'],
		usedToday: 0,
		humanApprovals: 0,
		...overrides
	};
}

const reply: Proposal = {
	capability: 'send_reply',
	fromAddress: 'billing@acme.com',
	recipients: ['client@globex.com']
};

describe('authorize: the happy paths', () => {
	test('an auto capability in scope executes', () => {
		expect(authorize(reply, context())).toEqual({ outcome: 'execute', reason: 'auto' });
	});

	test('an approve capability is queued for a human', () => {
		expect(authorize({ capability: 'organize' }, context())).toEqual({ outcome: 'queue', reason: 'needs_approval' });
	});

	test('the founder can always be emailed, even when not on the thread', () => {
		const proposal = { ...reply, recipients: ['Sada <SADA@acme.com>'] };
		expect(authorize(proposal, context({ threadParticipants: [] })).outcome).toBe('execute');
	});

	test('a domain scope lets the agent write to anyone at that domain', () => {
		const def = definition({ scope: { sendAs: ['billing@acme.com'], recipients: { kind: 'domains', domains: ['globex.com'] } } });
		const proposal = { ...reply, recipients: ['ap@globex.com'] };
		expect(authorize(proposal, context({ definition: def, threadParticipants: [] })).outcome).toBe('execute');
	});
});

describe('authorize: refusals', () => {
	test('a paused agent can do nothing, not even read', () => {
		expect(authorize({ capability: 'read_threads' }, context({ status: 'paused' }))).toEqual({
			outcome: 'reject',
			reason: 'agent_paused'
		});
	});

	test('capabilities outside the catalog are refused', () => {
		for (const capability of ['delete_mailbox', 'hire_agent', 'edit_agent', '', 'SEND_REPLY', 'send_reply ']) {
			expect(authorize({ capability }, context())).toEqual({ outcome: 'reject', reason: 'unknown_capability' });
		}
	});

	test('a capability set to off, or left out, is refused', () => {
		expect(authorize({ capability: 'set_timer' }, context()).reason).toBe('capability_off');
		expect(authorize({ capability: 'fetch_web' }, context()).reason).toBe('capability_off');
	});

	test('after a human takes the thread over, only reading is allowed', () => {
		const taken = context({ threadTakenOver: true });
		expect(authorize(reply, taken).reason).toBe('thread_taken_over');
		expect(authorize({ capability: 'write_note' }, taken).reason).toBe('thread_taken_over');
		expect(authorize({ capability: 'read_threads' }, taken).outcome).toBe('execute');
	});

	test('sending needs an address the agent may send as', () => {
		expect(authorize({ ...reply, fromAddress: 'sada@acme.com' }, context()).reason).toBe('send_as_out_of_scope');
		expect(authorize({ ...reply, fromAddress: undefined }, context()).reason).toBe('send_as_out_of_scope');
	});

	test('sending needs at least one recipient', () => {
		expect(authorize({ ...reply, recipients: [] }, context()).reason).toBe('no_recipients');
	});

	test('the daily limit is a hard stop', () => {
		expect(authorize(reply, context({ usedToday: 2 })).outcome).toBe('execute');
		expect(authorize(reply, context({ usedToday: 3 })).reason).toBe('daily_limit_reached');
	});

	test('calendar invites are scope-checked like mail', () => {
		const invite = { capability: 'calendar', recipients: ['stranger@evil.test'] };
		expect(authorize(invite, context()).reason).toBe('recipient_out_of_scope');
		expect(authorize({ capability: 'calendar', recipients: ['client@globex.com'] }, context()).outcome).toBe('execute');
	});
});

/**
 * An email can say anything. These are proposals a manipulated model might
 * make; none of them may be allowed, whatever the email argued.
 */
describe('authorize: prompt-injected proposals stay refused', () => {
	const injected: Array<[string, Proposal, PolicyContext?]> = [
		['forward the thread to an outside address', { ...reply, capability: 'send_email', recipients: ['attacker@evil.test'] }],
		['reply-all with an added outsider', { ...reply, recipients: ['client@globex.com', 'attacker@evil.test'] }],
		['bcc an outsider via display-name tricks', { ...reply, recipients: ['"client@globex.com" <attacker@evil.test>'] }],
		['a lookalike domain', { ...reply, recipients: ['client@globex.com.evil.test'] }],
		['a subdomain of an allowed domain', { ...reply, recipients: ['x@mail.globex.com'] }, context({
			definition: definition({ scope: { sendAs: ['billing@acme.com'], recipients: { kind: 'domains', domains: ['globex.com'] } } }),
			threadParticipants: []
		})],
		['send as the founder', { ...reply, fromAddress: 'sada@acme.com' }],
		['send from a spoofed outside address', { ...reply, fromAddress: 'ceo@globex.com' }],
		['grant itself a capability', { capability: 'edit_agent' }],
		['keep sending past the limit', reply, context({ usedToday: 99 })],
		['act on a thread the founder took over', reply, context({ threadTakenOver: true })],
		['act while paused', reply, context({ status: 'paused' })],
		['use a capability the founder switched off', { capability: 'set_timer' }]
	];

	for (const [name, proposal, ctx] of injected) {
		test(name, () => {
			expect(authorize(proposal, ctx ?? context()).outcome).toBe('reject');
		});
	}
});

describe('authorize: shadow mode', () => {
	test('in shadow mode nothing with an effect runs, even on auto', () => {
		const shadow = context({ status: 'shadow' });
		expect(authorize(reply, shadow)).toEqual({ outcome: 'shadow', reason: 'shadow_mode' });
		expect(authorize({ capability: 'write_note' }, shadow).outcome).toBe('shadow');
		expect(authorize({ capability: 'organize' }, shadow).outcome).toBe('shadow');
	});

	test('reading still works in shadow mode', () => {
		expect(authorize({ capability: 'read_threads' }, context({ status: 'shadow' })).outcome).toBe('execute');
	});

	test('refusals win over shadowing, so shadow cards never show impossible actions', () => {
		const proposal = { ...reply, recipients: ['attacker@evil.test'] };
		expect(authorize(proposal, context({ status: 'shadow' })).reason).toBe('recipient_out_of_scope');
	});
});

describe('authorize: external agents', () => {
	test('auto sends queue until the agent has 20 human approvals', () => {
		expect(authorize(reply, context({ runtime: 'external', humanApprovals: 19 }))).toEqual({
			outcome: 'queue',
			reason: 'external_track_record'
		});
		expect(authorize(reply, context({ runtime: 'external', humanApprovals: 20 })).outcome).toBe('execute');
	});

	test('internal-only capabilities run on auto straight away', () => {
		expect(authorize({ capability: 'draft_reply' }, context({ runtime: 'external' })).outcome).toBe('execute');
	});
});

describe('agent definitions', () => {
	test('a new agent starts conservative: nothing that reaches outside is on auto', () => {
		const def = defaultDefinition('Help with anything.');
		for (const capability of CAPABILITIES) {
			const setting = def.capabilities[capability];
			expect(setting).toBeDefined();
			if (CAPABILITY_TRAITS[capability].reachesOutside) expect(setting?.level).not.toBe('auto');
		}
		expect(def.scope).toEqual({ sendAs: [], recipients: { kind: 'thread' } });
	});

	test('addresses and domains are normalized and deduplicated', () => {
		const def = parseDefinition({
			job: '  Triage  ',
			capabilities: {},
			scope: {
				sendAs: ['Billing <BILLING@acme.com>', 'billing@acme.com'],
				recipients: { kind: 'domains', domains: ['@Globex.com', 'globex.com'] }
			}
		});
		expect(def.job).toBe('Triage');
		expect(def.scope).toEqual({ sendAs: ['billing@acme.com'], recipients: { kind: 'domains', domains: ['globex.com'] } });
	});

	test('bad input is refused, not guessed at', () => {
		const scope = { sendAs: [], recipients: { kind: 'thread' } };
		const bad: Array<[unknown, string]> = [
			[null, 'job'],
			[{ job: '', capabilities: {}, scope }, 'job'],
			[{ job: 'x'.repeat(8001), capabilities: {}, scope }, 'job'],
			[{ job: 'x', capabilities: { delete_mailbox: { level: 'auto' } }, scope }, 'capability'],
			[{ job: 'x', capabilities: { send_reply: { level: 'always' } }, scope }, 'level'],
			[{ job: 'x', capabilities: { send_reply: { level: 'auto', dailyLimit: -1 } }, scope }, 'limit'],
			[{ job: 'x', capabilities: { send_reply: { level: 'auto', dailyLimit: 1.5 } }, scope }, 'limit'],
			[{ job: 'x', capabilities: {}, scope: { sendAs: ['not an address'], recipients: { kind: 'thread' } } }, 'scope'],
			[{ job: 'x', capabilities: {}, scope: { sendAs: [], recipients: { kind: 'anyone' } } }, 'scope'],
			[{ job: 'x', capabilities: {}, scope: { sendAs: [], recipients: { kind: 'domains', domains: [] } } }, 'scope']
		];
		for (const [input, code] of bad) {
			let error: unknown;
			try {
				parseDefinition(input);
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(AgentDefinitionError);
			expect((error as AgentDefinitionError).code).toBe(code as AgentDefinitionError['code']);
		}
	});
});
