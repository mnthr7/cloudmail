/**
 * Where to send someone after they sign in. Only paths on this site that a
 * sign-in can be asked to return to (the OAuth consent screen), so a crafted
 * link can't bounce a fresh session anywhere else.
 */
const RETURNABLE_PREFIXES = ['/oauth/'];

export function safeReturnPath(value: string | null | undefined): string | null {
	if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
	let path: URL;
	try {
		path = new URL(value, 'https://return.invalid');
	} catch {
		return null;
	}
	if (path.origin !== 'https://return.invalid') return null;
	if (!RETURNABLE_PREFIXES.some((prefix) => path.pathname.startsWith(prefix))) return null;
	return `${path.pathname}${path.search}`;
}
