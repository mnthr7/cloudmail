import { showToast } from '#lib/toast.ts';

/** A schedule at least this far ahead skips the undo toast. */
const SCHEDULE_LEAD_MS = 60_000;

export function holdDelay(sendAt: string, now: Date): number {
	return Math.max(0, Date.parse(sendAt) - now.getTime());
}

/** True when `sendAt` is a schedule, so the caller navigates to /scheduled. */
export function isFutureSchedule(sendAt: string, now: Date): boolean {
	return holdDelay(sendAt, now) >= SCHEDULE_LEAD_MS;
}

export type HoldSendHandlers = {
	/** Cancel returned `{ status: 'draft' }`. Keep the composer open on this id. */
	onDraft?: (id: string) => void;
	/** The hold ended, or undo found the message already sent. */
	onClose?: () => void;
};

/**
 * Shows Sending… with Undo for `holdDelay` milliseconds. Undo POSTs cancel.
 * When the delay elapses without undo, POSTs deliver.
 */
export function holdSend(id: string, sendAt: string, handlers: HoldSendHandlers = {}): void {
	const delay = holdDelay(sendAt, new Date());
	let undone = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	showToast('Sending…', {
		actionLabel: 'Undo',
		duration: delay,
		onAction: async () => {
			undone = true;
			if (timer !== undefined) clearTimeout(timer);
			try {
				const res = await fetch(`/api/mail/${encodeURIComponent(id)}/cancel`, {
					method: 'POST'
				});
				const body = (await res.json().catch(() => null)) as { status?: string } | null;
				if (body?.status === 'draft') {
					handlers.onDraft?.(id);
					return;
				}
				if (body?.status === 'sent') {
					showToast('Already sent');
					handlers.onClose?.();
					return;
				}
				showToast("Couldn't undo the send.", { kind: 'error' });
				handlers.onClose?.();
			} catch {
				showToast("Couldn't undo the send.", { kind: 'error' });
				handlers.onClose?.();
			}
		}
	});

	timer = setTimeout(() => {
		if (undone) return;
		void fetch(`/api/mail/${encodeURIComponent(id)}/deliver`, { method: 'POST' }).finally(() => {
			if (!undone) handlers.onClose?.();
		});
	}, delay);
}
