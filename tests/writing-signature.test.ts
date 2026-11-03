import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { saveSignature } from '../src/lib/server/signatures';
import { applySignature } from '../src/lib/writing/signature';

const SCHEMA = `
CREATE TABLE addresses (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	signature_html TEXT
);
`;

function open() {
	const sqlite = new Database(':memory:');
	sqlite.exec(SCHEMA);
	sqlite.run(`INSERT INTO addresses (id, user_id, signature_html) VALUES ('addr-1', 'user-1', NULL)`);
	return { sqlite, db: adapt(sqlite) };
}

function adapt(sqlite: Database): D1Database {
	return {
		prepare(sql: string) {
			return {
				bind(...params: unknown[]) {
					const values = params.map((value) => (value === undefined ? null : value));
					return {
						async all() {
							const results = sqlite.query(sql).all(...(values as never[]));
							return { results, success: true, meta: {} };
						},
						async run() {
							const info = sqlite.run(sql, values as never[]);
							return { success: true, meta: { changes: info.changes } };
						},
						async first() {
							return sqlite.query(sql).get(...(values as never[])) ?? null;
						}
					};
				}
			};
		}
	} as unknown as D1Database;
}

function stored(sqlite: Database, id: string): string | null {
	const row = sqlite.query(`SELECT signature_html FROM addresses WHERE id = ?`).get(id) as
		| { signature_html: string | null }
		| null;
	return row?.signature_html ?? null;
}

describe('saveSignature', () => {
	test('stores null for blank html, ignores another user, and round-trips a value', async () => {
		const { sqlite, db } = open();

		expect(await saveSignature(db, 'user-2', 'addr-1', '<p>Bea</p>')).toBe(false);
		expect(stored(sqlite, 'addr-1')).toBe(null);

		expect(await saveSignature(db, 'user-1', 'addr-1', '<p>Ada</p>')).toBe(true);
		expect(stored(sqlite, 'addr-1')).toBe('<p>Ada</p>');

		expect(await saveSignature(db, 'user-1', 'addr-1', '   ')).toBe(true);
		expect(stored(sqlite, 'addr-1')).toBe(null);

		expect(await saveSignature(db, 'user-1', 'addr-1', '')).toBe(true);
		expect(stored(sqlite, 'addr-1')).toBe(null);
	});
});

describe('applySignature', () => {
	test('inserts a signature above the quote', () => {
		const html = applySignature('<p></p><blockquote>old</blockquote>', '<p>Ada</p>');
		expect(html).toContain('<div data-qm-signature="1"><p>Ada</p></div>');
		expect(html.indexOf('data-qm-signature')).toBeLessThan(html.indexOf('<blockquote>'));
	});

	test('swaps an unedited signature and keeps an edited one', () => {
		const original = '<p></p><div data-qm-signature="1"><p>Ada</p></div>';
		expect(applySignature(original, '<p>Bea</p>')).toContain('<p>Bea</p>');
		const edited = original.replace('signature="1"', 'signature="edited"');
		expect(applySignature(edited, '<p>Bea</p>')).toContain('<p>Ada</p>');
		expect(applySignature(edited, '<p>Bea</p>')).not.toContain('<p>Bea</p>');
	});

	test('a blank signature removes only an unedited block', () => {
		const original = '<p></p><div data-qm-signature="1"><p>Ada</p></div>';
		expect(applySignature(original, '  ')).not.toContain('data-qm-signature');
		const edited = original.replace('signature="1"', 'signature="edited"');
		expect(applySignature(edited, null)).toContain('signature="edited"');
	});

	test('swaps a signature that contains replacement tokens', () => {
		const sig = "<p>$& $$ $'</p>";
		const original = '<p></p><div data-qm-signature="1">' + sig + '</div><blockquote>q</blockquote>';
		expect(applySignature(original, sig)).toBe(
			'<p></p><div data-qm-signature="1">' + sig + '</div><blockquote>q</blockquote>'
		);
	});

	test('swaps a signature that contains a nested div', () => {
		const original =
			'<p></p><div data-qm-signature="1"><div>inner</div></div><blockquote>q</blockquote>';
		expect(applySignature(original, '<p>Bea</p>')).toBe(
			'<p></p><div data-qm-signature="1"><p>Bea</p></div><blockquote>q</blockquote>'
		);
	});

	test('does not treat a divider tag as a nested div', () => {
		const original =
			'<p></p><div data-qm-signature="1"><divider></divider></div><blockquote>q</blockquote>';
		expect(applySignature(original, '<p>Bea</p>')).toBe(
			'<p></p><div data-qm-signature="1"><p>Bea</p></div><blockquote>q</blockquote>'
		);
	});

	test('keeps the following quote when a signature character lowercases to two code units', () => {
		const original =
			'<p></p><div data-qm-signature="1"><p>\u0130</p></div><blockquote>q</blockquote>';
		expect(applySignature(original, '<p>Bea</p>')).toBe(
			'<p></p><div data-qm-signature="1"><p>Bea</p></div><blockquote>q</blockquote>'
		);
	});
});
