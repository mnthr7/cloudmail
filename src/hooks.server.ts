import { env as workerEnv } from 'cloudflare:workers';
import { redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { countUsers, getUserFromSession, readSessionToken } from '#lib/server/auth.ts';
import { DOMAIN_COOKIE } from '#lib/server/constants.ts';
import { listAddressesForUser, listDomains } from '#lib/server/domains.ts';
import {
	DEMO_MODE,
	DEMO_USER,
	DEMO_DOMAIN,
	DEMO_ADDRESS,
	isDemoRequestAllowed
} from '#lib/server/demo.ts';
import { SKIN_COOKIE, isSkin, parseSkin } from '#lib/skin.ts';

// /api/calendar/feed: secret subscribe links, authenticated by the token in the path.
// /book and /api/book: public booking pages, open to anyone with the link.
const PUBLIC_PREFIXES = ['/login', '/setup', '/api/auth', '/api/setup', '/api/webhooks', '/api/calendar/feed', '/book', '/api/book'];

function isPublicPath(pathname: string): boolean {
	return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export const handle: Handle = async ({ event, resolve: resolvePage }) => {
	// Stamp the skin on <html> server side so the first paint is already right.
	const resolve: typeof resolvePage = (evt, opts) =>
		resolvePage(evt, {
			...opts,
			transformPageChunk: ({ html }) => html.replace('%qm.skin%', evt.locals.skin)
		});

	// adapter-cloudflare 8 (SvelteKit 3) no longer sets `event.platform`; bindings
	// live on `cloudflare:workers` instead. Put them back on `platform.env` once
	// here so every load and endpoint keeps reading `platform.env` unchanged.
	(event as { platform: App.Platform | undefined }).platform ??= {
		env: workerEnv
	};

	const db = event.platform?.env.DB;
	event.locals.user = null;
	event.locals.domains = [];
	event.locals.addresses = [];
	event.locals.activeDomainId = null;
	event.locals.skin = parseSkin(event.cookies.get(SKIN_COOKIE));

	// Demo mode: only via explicit server env DEMO_MODE="true" (never a URL
	// param), read-only, non-admin. Anything else is rejected outright.
	if (DEMO_MODE) {
		if (!isDemoRequestAllowed(event.request.method, event.url.pathname)) {
			return new Response(JSON.stringify({ error: 'Demo mode is read-only' }), {
				status: 403,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		event.locals.user = DEMO_USER;
		event.locals.domains = [DEMO_DOMAIN];
		event.locals.addresses = [DEMO_ADDRESS];
		event.locals.activeDomainId = DEMO_DOMAIN.id;

		// Allow demo mode to view all pages except setup/login
		if (event.url.pathname === '/setup' || event.url.pathname === '/login') {
			throw redirect(303, '/inbox');
		}

		return resolve(event);
	}

	if (db) {
		const token = readSessionToken(event.cookies);
		event.locals.user = await getUserFromSession(db, token);
		// The account's saved choice wins over the cookie (another device may have changed it).
		const saved = event.locals.user?.mail_skin;
		if (isSkin(saved)) event.locals.skin = saved;
	}

	const { pathname } = event.url;

	// Webhooks authenticate with a signature, not a session.
	if (pathname.startsWith('/api/webhooks/')) {
		return resolve(event);
	}

	if (db && event.locals.user) {
		const [domains, addresses] = await Promise.all([
			listDomains(db),
			listAddressesForUser(db, event.locals.user.id)
		]);

		event.locals.domains = domains;
		event.locals.addresses = addresses;

		// Only honour a domain filter that is still connected.
		const selected = event.cookies.get(DOMAIN_COOKIE);
		event.locals.activeDomainId =
			selected && domains.some((domain) => domain.id === selected) ? selected : null;
	}

	if (pathname.startsWith('/api/')) {
		if (isPublicPath(pathname)) {
			return resolve(event);
		}
		if (!event.locals.user) {
			return new Response(JSON.stringify({ error: 'Unauthorized' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' }
			});
		}
		return resolve(event);
	}

	const needsSetup = db ? await countUsers(db) === 0 : false;

	if (needsSetup && pathname !== '/setup') {
		throw redirect(303, '/setup');
	}

	if (pathname === '/setup') {
		if (!needsSetup && event.locals.user) {
			throw redirect(303, '/inbox');
		}
		if (!needsSetup && !event.locals.user) {
			throw redirect(303, '/login');
		}
		return resolve(event);
	}

	if (pathname === '/login') {
		if (event.locals.user) {
			throw redirect(303, '/inbox');
		}
		return resolve(event);
	}

	if (isPublicPath(pathname)) {
		return resolve(event);
	}

	if (!event.locals.user) {
		throw redirect(303, '/login');
	}

	// Nothing works until a provider domain is connected and the user owns an
	// address on it, so send them through onboarding first.
	const needsOnboarding =
		event.locals.domains.length === 0 || event.locals.addresses.length === 0;

	if (needsOnboarding && pathname !== '/onboarding') {
		throw redirect(303, '/onboarding');
	}

	if (!needsOnboarding && pathname === '/onboarding') {
		throw redirect(303, '/inbox');
	}

	if (pathname.startsWith('/admin') && !event.locals.user.is_admin) {
		throw redirect(303, '/inbox');
	}

	return resolve(event);
};
