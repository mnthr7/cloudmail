import { parseEmailAddress } from '$lib/email-address';
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
 * definition (docs/specs/agent-staff-platform.md, A3). Triggers, memory and
 * budget join this shape in later phases.
 */

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

export type AgentDefinition = {
	job: string;
	capabilities: Partial<Record<Capability, CapabilitySetting>>;
	scope: AgentScope;
};

export const MAX_JOB_LENGTH = 8000;
const MAX_DAILY_LIMIT = 10_000;

export class AgentDefinitionError extends Error {
	readonly status = 400;

	/** `send_as`: an address the person hiring the agent doesn't own (checked by the store). */
	constructor(readonly code: 'job' | 'capability' | 'level' | 'limit' | 'scope' | 'send_as') {
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

	return { job, capabilities, scope: parseScope(raw.scope) };
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
