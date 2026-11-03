import { writable } from 'svelte/store';

export type Toast = {
	id: number;
	message: string;
	kind: 'info' | 'error';
	actionLabel?: string;
	onAction?: () => void | Promise<void>;
};

export const toasts = writable<Toast[]>([]);

let nextId = 1;

/** Shows a brief message; returns a function that dismisses it early. */
export function showToast(
	message: string,
	options: {
		kind?: 'info' | 'error';
		actionLabel?: string;
		onAction?: () => void | Promise<void>;
		duration?: number;
	} = {}
): () => void {
	const id = nextId++;
	const toast: Toast = {
		id,
		message,
		kind: options.kind ?? 'info',
		actionLabel: options.actionLabel,
		onAction: options.onAction
	};
	toasts.update((list) => [...list.slice(-2), toast]);
	const dismiss = () => toasts.update((list) => list.filter((entry) => entry.id !== id));
	if (typeof setTimeout !== 'undefined') {
		setTimeout(dismiss, options.duration ?? (options.actionLabel ? 6000 : 4000));
	}
	return dismiss;
}
