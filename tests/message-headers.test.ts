import { describe, expect, test } from 'bun:test';
import {
	MAX_HEADER_BYTES,
	authLines,
	headerBlockFromRaw,
	headerBlockFromRecord,
	parseHeaderBlock,
	senderDetails
} from '../src/lib/security/headers';
import { authClauses, cutAuthText, parseAuthResults, parseSecurity } from '../src/lib/security/phishing';

// A Gmail From sent through a marketing platform: Cloudflare's ARC set on top.
const SPOOFED = [
	'ARC-Authentication-Results: i=1; mx.cloudflare.net;',
	' dkim=pass header.d=klaviyomail.com header.s=kl;',
	' spf=pass (mx.cloudflare.net: domain of bounce@send.klaviyomail.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@send.klaviyomail.com;',
	' dmarc=fail reason="SPF not aligned (relaxed)" header.from=gmail.com (policy=none)',
	'Received: from mta.klaviyomail.com (mta.klaviyomail.com [1.2.3.4]) by mx.cloudflare.net with ESMTPS id x',
	'Received: from app-7.klaviyo.internal (unknown [10.0.0.7]) by mta.klaviyomail.com with ESMTP id y',
	'Return-Path: <bounce@send.klaviyomail.com>',
	'DKIM-Signature: v=1; a=rsa-sha256; d=klaviyomail.com; s=kl; h=from:to;',
	'DKIM-Signature: v=1; a=rsa-sha256; d=gmail.com; s=fake; h=from:to;',
	'From: pauladedayo01@gmail.com',
	'Reply-To: Paul <deals@promo-hub.net>',
	'To: support@ritiech.app',
	'Subject: Get reviews and installation app',
	'Date: Fri, 13 Nov 2026 15:50:00 -0500',
	'Message-ID: <abc@klaviyomail.com>',
	'',
	'Hi, I came across your app...'
].join('\r\n');

describe('header block', () => {
	test('keeps everything before the body, unfolded on read', () => {
		const block = headerBlockFromRaw(SPOOFED)!;
		expect(block).not.toContain('came across');
		expect(block).not.toContain('\r');
		const lines = parseHeaderBlock(block);
		expect(lines[0].name).toBe('ARC-Authentication-Results');
		expect(lines[0].value).toContain('dmarc=fail');
		expect(lines.find((line) => line.name === 'From')?.value).toBe('pauladedayo01@gmail.com');
	});

	test('caps a huge block at a line boundary', () => {
		const huge = Array.from({ length: 5000 }, (_, i) => `X-Junk-${i}: ${'a'.repeat(40)}`).join('\n') + '\n\nbody';
		const block = headerBlockFromRaw(new TextEncoder().encode(huge))!;
		expect(block.length).toBeLessThanOrEqual(MAX_HEADER_BYTES + 30);
		expect(block.endsWith('[headers cut short]')).toBe(true);
	});

	test('caps multibyte headers in UTF-8 bytes, marker included', () => {
		const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
		const euros = Array.from({ length: 40 }, (_, i) => `X-Note-${i}: ${'€'.repeat(1000)}`);
		const fromRecord = headerBlockFromRecord(Object.fromEntries(euros.map((line) => line.split(': '))))!;
		const fromRaw = headerBlockFromRaw(new TextEncoder().encode(`${euros.join('\r\n')}\r\n\r\nbody`))!;
		for (const block of [fromRecord, fromRaw]) {
			expect(bytes(block)).toBeLessThanOrEqual(MAX_HEADER_BYTES);
			expect(block.endsWith('[headers cut short]')).toBe(true);
			expect(block).not.toContain('\uFFFD');
		}
	});

	test('writes a header record back out', () => {
		expect(headerBlockFromRecord({ From: 'a@b.com', 'Return-Path': '<x@y.com>', Empty: '' })).toBe(
			'From: a@b.com\nReturn-Path: <x@y.com>'
		);
		expect(headerBlockFromRecord(undefined)).toBeNull();
	});
});

describe('sender details', () => {
	// What the inbound path stores from Cloudflare's ARC set when the mail arrives.
	const TRUSTED =
		'mx.cloudflare.net; dkim=pass header.d=klaviyomail.com header.s=kl; spf=pass smtp.mailfrom=bounce@send.klaviyomail.com; dmarc=fail header.from=gmail.com';

	test('says who really sent a forged Gmail message', () => {
		const details = senderDetails(headerBlockFromRaw(SPOOFED), TRUSTED);
		expect(details.from).toBe('pauladedayo01@gmail.com');
		expect(details.returnPath).toBe('<bounce@send.klaviyomail.com>');
		expect(details.replyTo).toBe('Paul <deals@promo-hub.net>');
		expect(details.mailedBy).toEqual({ domain: 'send.klaviyomail.com', checked: true });
		// The checked signature, then the sender's unverified claim of a gmail.com one.
		expect(details.signedBy).toEqual([
			{ domain: 'klaviyomail.com', checked: true },
			{ domain: 'gmail.com', checked: false }
		]);
		expect(details.hops).toBe(2);
		expect(details.origin).toBe('app-7.klaviyo.internal (unknown [10.0.0.7])');
		expect(details.mismatch).toBe("It says it's from gmail.com, but it was sent through klaviyomail.com.");
	});

	test('no mismatch when the From domain signed it', () => {
		const auth = 'mx.cloudflare.net; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=bounce@mail.example.com; dmarc=pass header.from=example.com';
		expect(senderDetails('From: Ann <ann@example.com>', auth).mismatch).toBeNull();
	});

	test('a passing signature counts even after a failing one from the same domain', () => {
		const auth = 'mx.cloudflare.net; dkim=fail header.d=example.com; dkim=pass header.d=example.com';
		const details = senderDetails('From: ann@example.com', auth);
		expect(details.signedBy).toEqual([{ domain: 'example.com', checked: true }]);
		expect(details.mismatch).toBeNull();
	});

	test('siblings under a shared suffix are different senders', () => {
		const coUk = senderDetails('From: boss@victim.co.uk', 'mx.cloudflare.net; dkim=pass header.d=attacker.co.uk');
		expect(coUk.mismatch).toBe("It says it's from victim.co.uk, but it was sent through attacker.co.uk.");
		const pages = senderDetails('From: alice@alice.github.io', 'mx.cloudflare.net; dkim=pass header.d=bob.github.io');
		expect(pages.mismatch).toBe("It says it's from alice.github.io, but it was sent through bob.github.io.");
	});

	test("the receiving server's DMARC pass settles alignment for a sibling subdomain", () => {
		const auth = 'mx.cloudflare.net; dkim=pass header.d=bounce.example.com; dmarc=pass header.from=mail.example.com';
		expect(senderDetails('From: a@mail.example.com', auth).mismatch).toBeNull();
		// Without that pass, siblings aren't assumed to be one sender.
		expect(senderDetails('From: a@mail.example.com', 'mx.cloudflare.net; dkim=pass header.d=bounce.example.com').mismatch).toBe(
			"It says it's from mail.example.com, but it was sent through bounce.example.com."
		);
	});

	test('a Cloudflare-looking ARC set in the stored headers is never read as checked', () => {
		// Resend hands over the sender's headers as-is; this one is forged.
		const block = [
			'ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=pass header.d=paypal.com; spf=pass smtp.mailfrom=x@paypal.com; dmarc=pass header.from=paypal.com',
			'Return-Path: <x@evil.test>',
			'From: service@paypal.com'
		].join('\n');
		const details = senderDetails(block);
		expect(details.mailedBy).toEqual({ domain: 'evil.test', checked: false });
		expect(details.signedBy).toEqual([]);
		expect(details.mismatch).toBe("It says it's from paypal.com, but it was sent through evil.test.");
	});

	test('a long crafted value is skipped quickly', () => {
		const block = `Return-Path: a@${'.'.repeat(200_000)}x\nFrom: a@example.com`;
		const started = performance.now();
		expect(senderDetails(block).mailedBy).toBeNull();
		expect(performance.now() - started).toBeLessThan(100);
	});

	test("a sender's own Authentication-Results lower down isn't trusted", () => {
		const block = [
			'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=paypal.com; spf=pass smtp.mailfrom=x@paypal.com',
			'Return-Path: <x@evil.test>',
			'From: service@paypal.com'
		].join('\n');
		const details = senderDetails(block);
		expect(details.mailedBy).toEqual({ domain: 'evil.test', checked: false });
		expect(details.signedBy).toEqual([]);
		expect(details.mismatch).toBe("It says it's from paypal.com, but it was sent through evil.test.");
	});

	test('nothing kept: empty facts', () => {
		const details = senderDetails(null);
		expect(details.from).toBeNull();
		expect(details.mismatch).toBeNull();
		expect(details.signedBy).toEqual([]);
	});
});

test('auth lines explain each check', () => {
	const rows = authLines({ spf: 'pass', dkim: 'pass', dmarc: 'fail', dmarcFrom: ['gmail.com'] });
	expect(rows.map((row) => [row.method, row.ok])).toEqual([
		['SPF', true],
		['DKIM', true],
		['DMARC', false]
	]);
	expect(rows[2].note).toBe('Does gmail.com vouch for it?');
	expect(authLines(null)).toEqual([]);
});

describe('results the sender tries to write into the receiver\'s report', () => {
	// Cloudflare echoes the envelope sender in a comment and in smtp.mailfrom.
	const forged = (mailfrom: string) =>
		`mx.cloudflare.net; dkim=none; spf=pass (mx.cloudflare.net: domain of ${mailfrom} designates 1.2.3.4 as permitted sender) smtp.mailfrom=${mailfrom}; dmarc=fail header.from=victim.co.uk`;

	test('a quoted local part with ";dmarc=pass" adds no result', () => {
		const text = forged('"x;dmarc=pass header.from=victim.co.uk"@evil.test');
		expect(authClauses(text).map((clause) => `${clause.method}=${clause.result}`)).toEqual(['dkim=none', 'spf=pass', 'dmarc=fail']);
		expect(authClauses(text)[1].props['smtp.mailfrom']).toBe('"x;dmarc=pass header.from=victim.co.uk"@evil.test'.toLowerCase());
		expect(parseAuthResults([text]).dmarc).toBe('fail');
		const details = senderDetails('From: boss@victim.co.uk', text);
		expect(details.mismatch).toBe("It says it's from victim.co.uk, but it was sent through evil.test.");
	});

	test('a ")" inside a quoted local part does not end the comment early', () => {
		const text = forged('"a)b; dmarc=pass header.from=victim.co.uk"@evil.test');
		expect(authClauses(text).filter((clause) => clause.method === 'dmarc').map((clause) => clause.result)).toEqual(['fail']);
	});

	test('an escaped ")" inside a comment does not end it', () => {
		const text = 'mx.cloudflare.net; spf=pass (note \\); dmarc=pass header.from=victim.co.uk) smtp.mailfrom=a@evil.test';
		expect(authClauses(text).map((clause) => clause.method)).toEqual(['spf']);
	});

	test('a property inside a quoted value is not read as a property', () => {
		const text = 'mx.cloudflare.net; dkim=pass header.i="x header.d=victim.co.uk"@evil.test header.d=evil.test';
		expect(authClauses(text)[0].props['header.d']).toBe('evil.test');
	});

	test('a quote or comment left open fails closed instead of hiding the real result', () => {
		const openQuote = forged('"x@evil.test');
		const openComment = 'mx.cloudflare.net; spf=pass (unclosed smtp.mailfrom=a@evil.test; dmarc=fail header.from=victim.co.uk';
		const strayClose = 'mx.cloudflare.net; spf=pass ) dmarc=pass header.from=victim.co.uk; dmarc=fail header.from=victim.co.uk';
		for (const text of [openQuote, openComment, strayClose]) {
			expect(authClauses(text).map((clause) => `${clause.method}=${clause.result}`)).toEqual([
				'spf=permerror',
				'dkim=permerror',
				'dmarc=permerror'
			]);
			const auth = parseAuthResults([text]);
			expect(auth.dmarc === 'pass').toBe(false);
			expect(senderDetails('From: boss@victim.co.uk', text).mismatch).not.toBeNull();
		}
		// The plain scan still sees the receiver's fail, so it wins over the error.
		expect(parseAuthResults([openComment]).dmarc).toBe('fail');
	});

	test('a long report is cut only between clauses', () => {
		const filler = `mx.cloudflare.net; spf=none smtp.helo=${'a'.repeat(4000)}.test; `;
		const text = `${filler}dkim=pass header.d=victim.com.attacker.net; dmarc=fail header.from=victim.com`;
		const at = filler.length + 'dkim=pass header.d=victim.com'.length;
		const cut = cutAuthText(text, at);
		expect(cut.endsWith('.test')).toBe(true);
		expect(authClauses(cut).map((clause) => clause.method)).toEqual(['spf']);
		expect(senderDetails('From: a@victim.com', cut).signedBy).toEqual([]);
		// Stored text goes through the same cut when read back.
		const read = parseSecurity(JSON.stringify({ auth: {}, verdict: null, reasons: [], authText: text.padEnd(5000, ' ') }));
		const signer = authClauses(read!.authText).find((clause) => clause.method === 'dkim');
		expect(signer?.props['header.d']).toBe('victim.com.attacker.net');
		expect(cutAuthText('short; text')).toBe('short; text');
		expect(cutAuthText('x'.repeat(5000))).toBe('');
	});

	test('ordinary results still read, versions and quoted values included', () => {
		const clauses = authClauses('mx.google.com; dkim/1=pass header.d="example.com" (ok); spf=softfail smtp.mailfrom=a@example.com; dmarc=pass (p=none) header.from=example.com');
		expect(clauses).toEqual([
			{ method: 'dkim', result: 'pass', props: { 'header.d': 'example.com' } },
			{ method: 'spf', result: 'softfail', props: { 'smtp.mailfrom': 'a@example.com' } },
			{ method: 'dmarc', result: 'pass', props: { 'header.from': 'example.com' } }
		]);
	});
});
