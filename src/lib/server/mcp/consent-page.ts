import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { CAPABILITY_LABELS, CAPABILITY_TRAITS, isAutonomyLevel, type AutonomyLevel, type Capability } from '#lib/agents/capabilities.ts';
import { EXTERNAL_DEFAULT_LEVELS, EXTERNAL_UNAVAILABLE } from '#lib/agents/definition.ts';

/**
 * The consent screen an MCP client sends the founder to (external-agents.md,
 * X2). Rendered here rather than as a SvelteKit page so it can carry its own
 * headers: the library's anti-framing and form-binding cookie, and a CSP whose
 * form-action allows the client's redirect (Chrome applies form-action to the
 * redirect that follows a form post). Everything from the client is escaped.
 */

export const CONSENT_CAPABILITIES: Capability[] = (Object.keys(EXTERNAL_DEFAULT_LEVELS) as Capability[]).filter(
	(capability) => !EXTERNAL_UNAVAILABLE.includes(capability) && capability !== 'read_threads'
);

export type ConsentForm = {
	displayName: string;
	job: string;
	readAddresses: string[];
	sendAs: string[];
	levels: Partial<Record<Capability, AutonomyLevel>>;
	/** An existing external agent to connect as, instead of a new one. */
	reconnectAgentId: string | null;
};

export type ConsentPageInput = {
	details: ConsentDescription;
	handle: string;
	founderName: string;
	addresses: string[];
	reconnectable: Array<{ id: string; name: string }>;
	error?: string | null;
};

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const MAX_NAME = 80;
const MAX_JOB = 2000;

/** Reads the posted form. Unknown capabilities and levels are dropped, never guessed. */
export function parseConsentForm(form: FormData): ConsentForm {
	const text = (name: string) => String(form.get(name) ?? '').trim();
	const levels: ConsentForm['levels'] = {};
	for (const capability of CONSENT_CAPABILITIES) {
		const level = form.get(`level_${capability}`);
		if (isAutonomyLevel(level)) levels[capability] = level;
	}
	const reconnect = text('reconnect');
	return {
		displayName: text('name').slice(0, MAX_NAME),
		job: text('job').slice(0, MAX_JOB),
		readAddresses: form.getAll('read').map((value) => String(value).trim().toLowerCase()).filter(Boolean),
		sendAs: form.getAll('send_as').map((value) => String(value).trim().toLowerCase()).filter(Boolean),
		levels,
		reconnectAgentId: reconnect && reconnect !== 'new' ? reconnect : null
	};
}

/** What's wrong with the form, in a sentence, or null. Addresses must be the founder's own. */
export function consentFormError(form: ConsentForm, ownAddresses: string[]): string | null {
	const own = new Set(ownAddresses.map((address) => address.toLowerCase()));
	if (!form.reconnectAgentId && !form.displayName) return 'Give the agent a name.';
	if (!form.reconnectAgentId && form.readAddresses.length === 0) return 'Pick at least one address it can read.';
	if (![...form.readAddresses, ...form.sendAs].every((address) => own.has(address))) {
		return 'Only your own addresses can be chosen.';
	}
	return null;
}

/** The CSP for the consent page: nothing loads, and the form may post here and redirect to the client. */
export function consentCsp(redirectUri: string): string {
	let target = '';
	try {
		const url = new URL(redirectUri);
		// http(s) redirects allow their origin; a native app's private-use scheme allows the scheme.
		target = url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : url.protocol;
	} catch {
		target = '';
	}
	return [
		"default-src 'none'",
		"style-src 'unsafe-inline'",
		"img-src 'self'",
		`form-action 'self'${target ? ` ${target}` : ''}`,
		"frame-ancestors 'none'",
		"base-uri 'none'"
	].join('; ');
}

const LEVEL_OPTIONS: AutonomyLevel[] = ['off', 'approve', 'auto'];
const LEVEL_TEXT: Record<AutonomyLevel, string> = { off: 'Off', approve: 'Ask me first', auto: 'On its own' };

export function renderConsentPage(input: ConsentPageInput): string {
	const { details } = input;
	const client = escapeHtml(details.clientName);
	const origin = details.clientDomain
		? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
		: 'This app registered itself, so its name isn’t verified.';
	const loopback = details.redirectIsLoopback
		? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>'
		: '';
	const addressRows = (name: string) =>
		input.addresses
			.map(
				(address) =>
					`<label class="check"><input type="checkbox" name="${name}" value="${escapeHtml(address)}" checked> ${escapeHtml(address)}</label>`
			)
			.join('');
	const capabilityRows = CONSENT_CAPABILITIES.map((capability) => {
		const label = CAPABILITY_LABELS[capability];
		const options = LEVEL_OPTIONS.map(
			(level) =>
				`<option value="${level}"${level === EXTERNAL_DEFAULT_LEVELS[capability] ? ' selected' : ''}>${LEVEL_TEXT[level]}</option>`
		).join('');
		const note = CAPABILITY_TRAITS[capability].externalAutoNeedsTrackRecord
			? '<span class="hint">“On its own” starts only after shadow mode and 20 approvals.</span>'
			: '';
		return `<div class="cap"><div><strong>${escapeHtml(label.name)}</strong><span class="hint">${escapeHtml(label.hint)}</span>${note}</div>
			<select name="level_${capability}" aria-label="${escapeHtml(label.name)}">${options}</select></div>`;
	}).join('');
	const reconnect = input.reconnectable.length
		? `<fieldset><legend>Connect as</legend>
			<label class="check"><input type="radio" name="reconnect" value="new" checked> A new agent</label>
			${input.reconnectable
				.map(
					(agent) =>
						`<label class="check"><input type="radio" name="reconnect" value="${escapeHtml(agent.id)}"> ${escapeHtml(agent.name)} (keeps its settings and history; its old connection stops)</label>`
				)
				.join('')}
		</fieldset>`
		: '';

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${client} to CloudMail</title>
<style>
:root{color-scheme:light dark;--bg:#f7f6f3;--card:#fff;--ink:#1d1d1f;--muted:#6b6b70;--line:#e3e1dc;--accent:#2f5bd3;--warn:#8a5a00;--warnbg:#fff4dc}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1d1d20;--ink:#f1f1f3;--muted:#a0a0a8;--line:#323238;--accent:#7f9dff;--warn:#ffcf7a;--warnbg:#3a2d10}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:640px;margin:32px auto;padding:0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:22px;margin:0 0 8px}p{margin:0 0 12px}.muted,.hint{color:var(--muted)}.hint{display:block;font-size:13px}
.warn{background:var(--warnbg);color:var(--warn);padding:10px 12px;border-radius:8px}
.error{background:#fde8e8;color:#9b1c1c;padding:10px 12px;border-radius:8px}
fieldset{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:16px 0}legend{font-weight:600;padding:0 4px}
label.field{display:block;font-weight:600;margin:16px 0 6px}
input[type=text],textarea,select{width:100%;font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:8px;padding:8px 10px}
textarea{min-height:72px}.check{display:block;margin:4px 0;font-weight:400}
.cap{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:8px 0;border-top:1px solid var(--line)}.cap:first-of-type{border-top:0}
.cap select{width:auto;min-width:140px}
.actions{display:flex;gap:12px;margin-top:20px}
button{font:inherit;border-radius:8px;padding:10px 16px;border:1px solid var(--line);background:transparent;color:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
@media (max-width:520px){.cap{flex-direction:column;align-items:stretch}.cap select{width:100%}}
</style>
</head>
<body><main><div class="card">
<h1>Connect ${client} to your mail</h1>
<p>${origin} Access goes to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<p class="muted">${client} will work as an agent in ${escapeHtml(input.founderName)}’s mailbox. It starts in shadow mode: for its first 20 actions you see what it would do, and nothing happens. You can pause it, change what it may do, or disconnect it any time on the Staff page.</p>
${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ''}
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(input.handle)}">
${reconnect}
<label class="field" for="name">Agent name</label>
<input type="text" id="name" name="name" maxlength="${MAX_NAME}" value="${escapeHtml(details.clientName.slice(0, MAX_NAME))}">
<label class="field" for="job">What it’s for <span class="hint">Shown to the agent, and to you on the Staff page.</span></label>
<textarea id="job" name="job" maxlength="${MAX_JOB}">Help me with email I ask about through ${client}.</textarea>
<fieldset><legend>Mail it can read</legend><span class="hint">Threads to, from or copying these addresses.</span>${addressRows('read')}</fieldset>
<fieldset><legend>Addresses it can send from</legend><span class="hint">Untick all to keep it from sending.</span>${addressRows('send_as')}</fieldset>
<fieldset><legend>What it can do</legend><span class="hint">It can always read what you chose above. Emails it sends say they come from an AI assistant.</span>${capabilityRows}</fieldset>
<div class="actions"><button class="primary" name="decision" value="approve">Connect</button><button name="decision" value="deny">Cancel</button></div>
</form>
</div></main></body></html>`;
}

/** A small page for errors that can't go back to the client. */
export function renderConsentError(message: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Couldn’t connect</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#1d1d1f;background:#f7f6f3}@media (prefers-color-scheme:dark){body{color:#f1f1f3;background:#141416}}</style></head>
<body><h1>Couldn’t connect</h1><p>${escapeHtml(message)}</p><p>Start connecting again from your app.</p></body></html>`;
}
