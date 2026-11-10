import { parseEmailAddress } from '#lib/email-address.ts';
import {
	CAPABILITIES,
	CAPABILITY_TRAITS,
	isAutonomyLevel,
	isCapability,
	type AutonomyLevel,
	type Capability
} from './capabilities';

/**
 * What an agent is allowed to see and do, stored as one version of its
 * definition (docs/specs/agent-staff-platform.md, A3). What it remembers
 * lives beside the definition (agent_memory), so facts don't need a new version.
 */

/** Models an agent can run on. The first is the default. */
export const AGENT_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

export const AGENT_MODEL_LABELS: Record<AgentModel, string> = {
	'claude-opus-5-5': 'Claude Opus 5.5',
	'claude-sonnet-5-5': 'Claude Sonnet 5.5',
	'claude-haiku-5-5': 'Claude Haiku 5.5'
};

/** A new agent's monthly spend cap, in cents. Reaching it pauses the agent. */
export const DEFAULT_MONTHLY_BUDGET_CENTS = 1000;
export const MAX_MONTHLY_BUDGET_CENTS = 100_000;

export function isAgentModel(value: unknown): value is AgentModel {
	return typeof value === 'string' && (AGENT_MODELS as readonly string[]).includes(value);
}

export type CapabilitySetting = {
	level: AutonomyLevel;
	/** Most times per UTC day this capability may be allowed to run. */
	dailyLimit?: number;
};

/**
 * Who the agent may email. Everyone already on the thread and the founder are
 * always allowed; `domains` widens that to whole domains.
 */
export type RecipientScope = { kind: 'thread' } | { kind: 'domains'; domains: string[] };

export type AgentScope = {
	/** Addresses the agent may send from. Empty means it can't send. */
	sendAs: string[];
	recipients: RecipientScope;
};

/** When the agent wakes up (A5). Asking it on a thread always works. */
export type AgentTriggers = {
	/** New mail to any of these addresses starts a run. */
	watch: string[];
	/**
	 * Only mail a verified teammate sends to a watched address (a forward, a CC)
	 * wakes it, and what they wrote is their request. Mail from anyone else is
	 * left alone. Sam works this way.
	 */
	teamOnly: boolean;
};

/**
 * A specialist has one job (Demos, Billing). A generalist (Sam, A15) takes
 * whatever the team hands it, logs what kind of task each was, and suggests a
 * specialist when the same kind keeps coming up.
 */
export type AgentKind = 'specialist' | 'generalist';

export type AgentDefinition = {
	kind: AgentKind;
	job: string;
	capabilities: Partial<Record<Capability, CapabilitySetting>>;
	scope: AgentScope;
	triggers: AgentTriggers;
	model: AgentModel;
	/** Most it may spend on model calls per calendar month (UTC), in cents. */
	monthlyBudgetCents: number;
};

export const MAX_JOB_LENGTH = 8000;
const MAX_DAILY_LIMIT = 10_000;

export class AgentDefinitionError extends Error {
	readonly status = 400;

	/**
	 * `send_as` / `watch`: an address the person hiring the agent doesn't own
	 * (checked by the store). `trigger`, `model`, `budget`: malformed fields.
	 */
	constructor(
		readonly code:
			| 'job'
			| 'kind'
			| 'capability'
			| 'level'
			| 'limit'
			| 'scope'
			| 'send_as'
			| 'watch'
			| 'trigger'
			| 'model'
			| 'budget'
	) {
		super(code);
		this.name = 'AgentDefinitionError';
	}
}

/** A new agent's definition: every capability at its conservative default, sending from nowhere. */
export function defaultDefinition(job: string): AgentDefinition {
	const capabilities: AgentDefinition['capabilities'] = {};
	for (const capability of CAPABILITIES) {
		capabilities[capability] = { level: CAPABILITY_TRAITS[capability].defaultLevel };
	}
	return parseDefinition({ job, capabilities, scope: { sendAs: [], recipients: { kind: 'thread' } } });
}

/** Older stored versions predate triggers, model and budget; they get the defaults. */
function parseTriggers(value: unknown): AgentTriggers {
	if (value === undefined || value === null) return { watch: [], teamOnly: false };
	if (typeof value !== 'object') throw new AgentDefinitionError('trigger');
	const raw = value as Record<string, unknown>;
	const watch = raw.watch === undefined ? [] : Array.isArray(raw.watch) ? raw.watch.map(normalizeAddress) : null;
	if (!watch || watch.some((address) => address === null)) throw new AgentDefinitionError('trigger');
	if (raw.teamOnly !== undefined && typeof raw.teamOnly !== 'boolean') throw new AgentDefinitionError('trigger');
	return { watch: [...new Set(watch as string[])], teamOnly: raw.teamOnly === true };
}

function parseModel(value: unknown): AgentModel {
	if (value === undefined || value === null) return AGENT_MODELS[0];
	if (!isAgentModel(value)) throw new AgentDefinitionError('model');
	return value;
}

function parseBudget(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_MONTHLY_BUDGET_CENTS;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_MONTHLY_BUDGET_CENTS) {
		throw new AgentDefinitionError('budget');
	}
	return value;
}

/**
 * Validates untrusted input (an API body, a stored JSON blob) into a
 * definition. Throws `AgentDefinitionError` rather than guessing.
 */
export function parseDefinition(input: unknown): AgentDefinition {
	if (!input || typeof input !== 'object') throw new AgentDefinitionError('job');
	const raw = input as Record<string, unknown>;

	const job = typeof raw.job === 'string' ? raw.job.trim() : '';
	if (!job || job.length > MAX_JOB_LENGTH) throw new AgentDefinitionError('job');

	const capabilities: AgentDefinition['capabilities'] = {};
	const rawCapabilities = raw.capabilities ?? {};
	if (typeof rawCapabilities !== 'object' || Array.isArray(rawCapabilities)) {
		throw new AgentDefinitionError('capability');
	}
	for (const [name, setting] of Object.entries(rawCapabilities as Record<string, unknown>)) {
		if (!isCapability(name)) throw new AgentDefinitionError('capability');
		capabilities[name] = parseSetting(setting);
	}

	if (raw.kind !== undefined && raw.kind !== 'specialist' && raw.kind !== 'generalist') {
		throw new AgentDefinitionError('kind');
	}

	return {
		kind: raw.kind === 'generalist' ? 'generalist' : 'specialist',
		job,
		capabilities,
		scope: parseScope(raw.scope),
		triggers: parseTriggers(raw.triggers),
		model: parseModel(raw.model),
		monthlyBudgetCents: parseBudget(raw.monthlyBudgetCents)
	};
}

function parseSetting(value: unknown): CapabilitySetting {
	if (!value || typeof value !== 'object') throw new AgentDefinitionError('level');
	const raw = value as Record<string, unknown>;
	if (!isAutonomyLevel(raw.level)) throw new AgentDefinitionError('level');

	const setting: CapabilitySetting = { level: raw.level };
	if (raw.dailyLimit !== undefined && raw.dailyLimit !== null) {
		const limit = raw.dailyLimit;
		if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > MAX_DAILY_LIMIT) {
			throw new AgentDefinitionError('limit');
		}
		setting.dailyLimit = limit;
	}
	return setting;
}

function parseScope(value: unknown): AgentScope {
	if (!value || typeof value !== 'object') throw new AgentDefinitionError('scope');
	const raw = value as Record<string, unknown>;

	const sendAs = Array.isArray(raw.sendAs) ? raw.sendAs.map(normalizeAddress) : null;
	if (!sendAs || sendAs.some((address) => address === null)) throw new AgentDefinitionError('scope');

	const recipients = raw.recipients as Record<string, unknown> | undefined;
	let parsedRecipients: RecipientScope;
	if (recipients?.kind === 'thread') {
		parsedRecipients = { kind: 'thread' };
	} else if (recipients?.kind === 'domains' && Array.isArray(recipients.domains)) {
		const domains = recipients.domains.map(normalizeDomain);
		if (domains.length === 0 || domains.some((domain) => domain === null)) {
			throw new AgentDefinitionError('scope');
		}
		parsedRecipients = { kind: 'domains', domains: [...new Set(domains as string[])] };
	} else {
		throw new AgentDefinitionError('scope');
	}

	return { sendAs: [...new Set(sendAs as string[])], recipients: parsedRecipients };
}

function normalizeAddress(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const address = parseEmailAddress(value);
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : null;
}

function normalizeDomain(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const domain = value.trim().toLowerCase().replace(/^@/, '');
	return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
}
