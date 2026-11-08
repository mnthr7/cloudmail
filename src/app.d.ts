import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { CloudflareSendEmailBinding } from '#lib/server/providers/cloudflare-provider.ts';
import type { Domain, MailAddress, User } from '#lib/types.ts';

declare global {
	namespace App {
		interface Platform {
			env: {
				DB: D1Database;
				ATTACHMENTS: R2Bucket;
				ASSETS: Fetcher;
				EMAIL: CloudflareSendEmailBinding;
				/** `resend` (default) or `cloudflare`. */
				EMAIL_PROVIDER?: string;
				/** Comma-separated domains when EMAIL_PROVIDER=cloudflare. */
				CLOUDFLARE_MAIL_DOMAINS?: string;
				/** Resend API key — `wrangler secret put RESEND_API_KEY`. */
				RESEND_API_KEY: string;
				/** Signing secret from the Resend webhook (whsec_…). */
				RESEND_WEBHOOK_SECRET: string;
				/** VirusTotal public API key. Presence only is sent to the page. */
				VIRUSTOTAL_API_KEY?: string;
				/** Encrypts workspace AI provider keys stored in D1. 32 random bytes, base64. */
				AI_KEY_ENCRYPTION_KEY?: string;
				/** When set, first-run setup asks for this value. */
				SETUP_TOKEN?: string;
			};
		}
		interface Locals {
			user: User | null;
			/** Connected domains, loaded once per request for the switcher. */
			domains: Domain[];
			/** The signed-in user's sending identities. */
			addresses: MailAddress[];
			/** Active domain filter, or null for the combined inbox. */
			activeDomainId: string | null;
			/** Mail skin for this request: account choice, then cookie, then Ledger. */
			skin: import('#lib/skin.ts').MailSkin;
		}
	}
}

export {};
