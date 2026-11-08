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
		/** Turns agents on. Without it, runs wait in the queue. */
		ANTHROPIC_API_KEY?: string;
		DEMO_MODE?: string;
		PATH_REDIRECT_FROM?: string;
		PATH_REDIRECT_TO?: string;
		SETUP_TOKEN?: string;
	}
}

export {};
