export const LABEL_COLORS = [
	'slate',
	'red',
	'orange',
	'amber',
	'green',
	'blue',
	'violet',
	'pink'
] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

export type LabelDraft = { id: string; parentId: string | null; name: string };

const MAX_DEPTH = 5;

export function labelEditError(
	existing: LabelDraft[],
	draft: LabelDraft
): 'duplicate' | 'cycle' | 'depth' | null {
	const name = draft.name.trim().toLowerCase();
	const duplicate = existing.some(
		(label) =>
			label.id !== draft.id &&
			label.parentId === draft.parentId &&
			label.name.trim().toLowerCase() === name
	);
	if (duplicate || !name) return 'duplicate';
	if (draft.parentId && reaches(existing, draft.parentId, draft.id)) return 'cycle';
	if (depth(existing, draft) > MAX_DEPTH) return 'depth';
	return null;
}

function reaches(existing: LabelDraft[], start: string, target: string): boolean {
	let current: string | null = start;
	const seen = new Set<string>();
	while (current) {
		if (current === target || seen.has(current)) return current === target;
		seen.add(current);
		current = existing.find((label) => label.id === current)?.parentId ?? null;
	}
	return false;
}

function depth(existing: LabelDraft[], draft: LabelDraft): number {
	let levels = 1;
	let current = draft.parentId;
	const seen = new Set<string>();
	while (current && !seen.has(current)) {
		seen.add(current);
		levels += 1;
		current = existing.find((label) => label.id === current)?.parentId ?? null;
	}
	return levels + longestDescendantChain(existing, draft.id);
}

function longestDescendantChain(existing: LabelDraft[], rootId: string): number {
	let max = 0;
	const seen = new Set<string>();

	function walk(parentId: string, chain: number) {
		for (const label of existing) {
			if (label.parentId !== parentId || label.id === rootId) continue;
			if (seen.has(label.id)) continue;
			seen.add(label.id);
			const next = chain + 1;
			max = Math.max(max, next);
			walk(label.id, next);
		}
	}

	walk(rootId, 0);
	return max;
}
