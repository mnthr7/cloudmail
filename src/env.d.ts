import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { CloudflareSendEmailBinding } from '#lib/server/providers/cloudflare-provider.ts';

declare global {
	interface Env {
		DB: D1Database;
		ATTACHMENTS: R2Bucket;
		ASSETS: Fetcher;
		EMAIL: CloudflareSendEmailBinding;
		EMAIL_PROVIDER?: string;
		CLOUDFLARE_MAIL_DOMAINS?: string;
		RESEND_API_KEY: string;
		RESEND_WEBHOOK_SECRET: string;
		VIRUSTOTAL_API_KEY?: string;
		/** Encrypts workspace AI provider keys stored in D1. 32 random bytes, base64. */
		AI_KEY_ENCRYPTION_KEY?: string;
		DEMO_MODE?: string;
		PATH_REDIRECT_FROM?: string;
		PATH_REDIRECT_TO?: string;
		SETUP_TOKEN?: string;
	}
}

export {};
