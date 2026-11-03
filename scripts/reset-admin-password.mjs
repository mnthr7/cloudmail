#!/usr/bin/env node
/**
 * Reset a user's password in remote (or local) D1, and sign that user out
 * everywhere. Trusted devices are tied to the old password, so they stop
 * counting as trusted on their own.
 *
 * Usage: bun scripts/reset-admin-password.mjs <email> <password> [--local] [--config <file>]
 */
import { execSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';

const { subtle } = webcrypto;
const PBKDF2_ITERATIONS = 100_000;

// Read the D1 name out of the wrangler config so this keeps working if you rename it.
// --config points at a live config such as wrangler.<name>.jsonc.
const configIndex = process.argv.indexOf('--config');
const configFile = configIndex === -1 ? 'wrangler.jsonc' : process.argv[configIndex + 1];
if (!configFile || configFile.startsWith('--') || !/^[\w./-]+\.jsonc?$/.test(configFile)) {
	console.error('--config needs a file, e.g. --config wrangler.mydomain.jsonc');
	process.exit(1);
}
const wranglerPath = new URL(`../${configFile}`, import.meta.url);
const databaseName = readFileSync(wranglerPath, 'utf8').match(
	/"database_name"\s*:\s*"([^"]+)"/
)?.[1];

if (!databaseName) {
	console.error(`Could not find "database_name" in ${configFile}.`);
	process.exit(1);
}

function toBase64(bytes) {
	return Buffer.from(bytes).toString('base64');
}

async function hashPassword(password) {
	const salt = webcrypto.getRandomValues(new Uint8Array(16));
	const keyMaterial = await subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits']
	);
	const hash = new Uint8Array(
		await subtle.deriveBits(
			{ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
			keyMaterial,
			256
		)
	);
	return `${toBase64(salt)}:${toBase64(hash)}`;
}

const [email, password] = process.argv
	.slice(2)
	.filter((arg, i, args) => !arg.startsWith('--') && args[i - 1] !== '--config');
const local = process.argv.includes('--local');

function usage(message) {
	console.error(message);
	console.error(
		'\nUsage: bun scripts/reset-admin-password.mjs <email> <password> [--local] [--config <file>]'
	);
	process.exit(1);
}

if (!email?.includes('@')) usage('A valid login email is required.');
if (!password || password.length < 8) usage('Password must be at least 8 characters.');

const passwordHash = await hashPassword(password);
const escape = (value) => value.replace(/'/g, "''");
const login = escape(email.toLowerCase());
// A new password should also end every existing session for that account.
const sql =
	`UPDATE users SET password_hash = '${escape(passwordHash)}' WHERE email = '${login}'; ` +
	`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = '${login}');`;

execSync(
	`bunx wrangler d1 execute ${databaseName} -c ${configFile} ${local ? '--local' : '--remote'} --command "${sql.replace(/"/g, '\\"')}"`,
	{ stdio: 'inherit', cwd: new URL('..', import.meta.url).pathname }
);

console.log(`\nPassword reset for ${email} (${local ? 'local' : 'remote'} DB). Existing sessions were signed out.`);
