import { describe, expect, test } from 'bun:test';
import {
	CONSENT_CAPABILITIES,
	consentCsp,
	consentFormError,
	parseConsentForm,
	renderConsentPage
} from '../src/lib/server/mcp/consent-page';

/** The consent screen an MCP client sends the founder to (external-agents.md, X2). */

const details = {
	clientId: 'c1',
	clientName: '<script>alert(1)</script>Claude',
	redirectUri: 'http://localhost:4567/callback',
	redirectHost: 'localhost',
	redirectIsLoopback: true,
	scope: ['agent']
};

describe('consent screen', () => {
	test('escapes what the client chose, warns about local apps, and shows the external defaults', () => {
		const page = renderConsentPage({
			details,
			handle: 'h"1',
			founderName: 'Sada',
			addresses: ['sada@acme.com'],
			reconnectable: [{ id: 'a_1', name: 'Research <old>' }]
		});
		expect(page).not.toContain('<script>alert(1)</script>');
		expect(page).toContain('&#60;script&#62;');
		expect(page).toContain('value="h&#34;1"');
		expect(page).toContain('app on your computer');
		expect(page).toContain('Research &#60;old&#62;');
		expect(page).toMatch(/name="level_send_reply"[^>]*>.*<option value="approve" selected>/s);
		expect(page).toMatch(/name="level_draft_reply"[^>]*>.*<option value="auto" selected>/s);
		expect(CONSENT_CAPABILITIES).not.toContain('hand_off');
		expect(CONSENT_CAPABILITIES).not.toContain('fetch_web');
	});

	test('the form keeps only known capabilities and levels, and only the founder’s own addresses', () => {
		const form = new FormData();
		form.set('name', 'Research');
		form.append('read', 'Sada@acme.com');
		form.append('send_as', 'sada@acme.com');
		form.set('level_send_reply', 'auto');
		form.set('level_hand_off', 'auto');
		form.set('level_organize', 'yolo');
		form.set('reconnect', 'new');
		const parsed = parseConsentForm(form);
		expect(parsed).toEqual({
			displayName: 'Research',
			job: '',
			readAddresses: ['sada@acme.com'],
			sendAs: ['sada@acme.com'],
			levels: { send_reply: 'auto' },
			reconnectAgentId: null
		});
		expect(consentFormError(parsed, ['sada@acme.com'])).toBeNull();
		expect(consentFormError({ ...parsed, readAddresses: [] }, ['sada@acme.com'])).toContain('at least one');
		expect(consentFormError({ ...parsed, sendAs: ['kim@acme.com'] }, ['sada@acme.com'])).toContain('own addresses');
	});

	test('the form may post here and go on to the client, and nothing else loads', () => {
		expect(consentCsp('http://localhost:4567/callback')).toContain("form-action 'self' http://localhost:4567");
		expect(consentCsp('https://claude.ai/api/mcp/auth_callback')).toContain("form-action 'self' https://claude.ai;");
		expect(consentCsp('com.example.app:/cb')).toContain("form-action 'self' com.example.app:");
		expect(consentCsp('')).toContain("default-src 'none'");
		expect(consentCsp('')).toContain("frame-ancestors 'none'");
	});
});
