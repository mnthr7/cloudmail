import { json } from '@sveltejs/kit';
import { importMasterKey } from './secret-box.ts';

/** The key outside calendar links are sealed with, or a response saying it isn't set up. */
export async function outsideKey(platform: App.Platform | undefined): Promise<{ key: CryptoKey } | { response: Response }> {
	try {
		return { key: await importMasterKey(platform?.env.AI_KEY_ENCRYPTION_KEY) };
	} catch {
		return {
			response: json(
				{ error: 'key', message: 'This server has no encryption key set, so calendar links can’t be stored safely.' },
				{ status: 503 }
			)
		};
	}
}
