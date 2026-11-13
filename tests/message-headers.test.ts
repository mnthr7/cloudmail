import { describe, expect, test } from 'bun:test';
import {
	MAX_HEADER_BYTES,
	authLines,
	headerBlockFromRaw,
	headerBlockFromRecord,
	parseHeaderBlock,
	senderDetails
} from '../src/lib/security/headers';

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

	test('writes a header record back out', () => {
		expect(headerBlockFromRecord({ From: 'a@b.com', 'Return-Path': '<x@y.com>', Empty: '' })).toBe(
			'From: a@b.com\nReturn-Path: <x@y.com>'
		);
		expect(headerBlockFromRecord(undefined)).toBeNull();
	});
});

describe('sender details', () => {
	test('says who really sent a forged Gmail message', () => {
		const details = senderDetails(headerBlockFromRaw(SPOOFED));
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
		const block = [
			'ARC-Authentication-Results: i=1; mx.cloudflare.net; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=bounce@mail.example.com; dmarc=pass header.from=example.com',
			'From: Ann <ann@example.com>'
		].join('\n');
		expect(senderDetails(block).mismatch).toBeNull();
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
