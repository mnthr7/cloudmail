/**
 * Encrypts secrets that have to be stored in the database, such as a
 * workspace's AI provider key. AES-256-GCM under a master key that lives only
 * in the Worker's secrets (AI_KEY_ENCRYPTION_KEY), never in the database.
 *
 * Each sealed value is bound to a context string (the workspace and provider),
 * so a sealed key copied into another workspace's row won't open.
 */

const VERSION = 'v1';

export class SecretBoxError extends Error {
	constructor(readonly code: 'master_key' | 'sealed') {
		super(code === 'master_key' ? 'AI_KEY_ENCRYPTION_KEY is missing or malformed' : 'Sealed secret could not be opened');
		this.name = 'SecretBoxError';
	}
}

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** The master key: 32 random bytes, base64. Generate one with `openssl rand -base64 32`. */
export async function importMasterKey(encoded: string | undefined): Promise<CryptoKey> {
	if (!encoded) throw new SecretBoxError('master_key');
	let raw: Uint8Array;
	try {
		raw = fromBase64(encoded.trim());
	} catch {
		throw new SecretBoxError('master_key');
	}
	if (raw.length !== 32) throw new SecretBoxError('master_key');
	return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function sealSecret(key: CryptoKey, plaintext: string, context: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) },
		key,
		new TextEncoder().encode(plaintext)
	);
	return `${VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

export async function openSecret(key: CryptoKey, sealed: string, context: string): Promise<string> {
	const [version, iv, ciphertext] = sealed.split('.');
	if (version !== VERSION || !iv || !ciphertext) throw new SecretBoxError('sealed');
	try {
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: fromBase64(iv) as BufferSource, additionalData: new TextEncoder().encode(context) },
			key,
			fromBase64(ciphertext) as BufferSource
		);
		return new TextDecoder().decode(plaintext);
	} catch {
		throw new SecretBoxError('sealed');
	}
}
