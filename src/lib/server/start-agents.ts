import { DEMO_MODE } from './demo';
import { getEmailProvider } from './context';
import type { EmailProvider } from './email-provider';
import { runAgentsNow } from './run-agents';

type PlatformLike = App.Platform | undefined;

/**
 * Starts waiting agent runs now (one workspace's, or all of them), after the response is sent,
 * instead of on the next minute's cron. Does nothing where that isn't possible;
 * the cron still picks the run up.
 */
export function startAgentsNow(platform: PlatformLike, workspaceId?: string): void {
	if (!platform?.ctx || DEMO_MODE) return;
	let provider: EmailProvider | null = null;
	try {
		provider = getEmailProvider(platform);
	} catch {
		provider = null;
	}
	platform.ctx.waitUntil(
		runAgentsNow(platform.env, provider, workspaceId ? [workspaceId] : undefined).catch((error) => console.error('Could not start agents now', error))
	);
}
