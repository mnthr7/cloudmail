import type { PageServerLoad } from './$types';
import { readUndoSendSeconds, readVtThreshold } from '#lib/server/auth.ts';
import { DEMO_MODE, DEMO_USER } from '#lib/server/demo.ts';
import {
	listBlockedSenders,
	listFilters,
	type BlockedSender,
	type FilterRecord
} from '#lib/server/filters-store.ts';
import { listImageSenders } from '#lib/server/image-senders.ts';
import { listLabels, type LabelRecord } from '#lib/server/labels-store.ts';
import type { UndoSeconds } from '#lib/writing/timing.ts';

export const load: PageServerLoad = async ({ locals, platform }) => {
	const domains = locals.domains;
	const addresses = locals.addresses;
	// The dataset sentence depends on the key, including for the demo user.
	const virusTotalConfigured = Boolean(platform?.env.VIRUSTOTAL_API_KEY);
	const empty: {
		domains: typeof domains;
		addresses: typeof addresses;
		filters: FilterRecord[];
		blocked: BlockedSender[];
		labels: LabelRecord[];
		undoSendSeconds: UndoSeconds;
		vtMaliciousThreshold: number;
		virusTotalConfigured: boolean;
		imageSenders: string[];
	} = {
		domains,
		addresses,
		filters: [],
		blocked: [],
		labels: [],
		undoSendSeconds: 10,
		vtMaliciousThreshold: 1,
		virusTotalConfigured,
		imageSenders: []
	};

	// Demo mode is server-env only (DEMO_MODE="true"), never a URL param.
	// Writes stay the existing 403. The lists are empty, same as the read APIs.
	if (DEMO_MODE && locals.user?.id === DEMO_USER.id) return empty;

	const db = platform?.env.DB;
	if (!db || !locals.user) return empty;

	const [filters, blocked, labels, undoSendSeconds, vtMaliciousThreshold, imageSenders] =
		await Promise.all([
			listFilters(db, locals.user.id),
			listBlockedSenders(db, locals.user.id),
			listLabels(db, locals.user.id),
			readUndoSendSeconds(db, locals.user.id),
			readVtThreshold(db, locals.user.id),
			listImageSenders(db, locals.user.id)
		]);

	return {
		domains,
		addresses,
		filters,
		blocked,
		labels,
		undoSendSeconds,
		vtMaliciousThreshold,
		virusTotalConfigured,
		imageSenders
	};
};
