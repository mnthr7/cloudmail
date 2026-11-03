import { parseEmailAddress } from '../email-address';

export type ReplyInput = {
	direction: 'inbound' | 'outbound';
	from: string;
	replyTo: string | null;
	to: string | null;
	cc: string | null;
	bcc: string | null;
	own: string[];
};

export function replyRecipients(input: ReplyInput): {
	reply: string[];
	replyAll: string[];
	showReplyAll: boolean;
} {
	const own = new Set(input.own.map((address) => parseEmailAddress(address)));
	const seeds =
		input.direction === 'outbound'
			? [input.to]
			: input.replyTo?.trim()
				? [input.replyTo]
				: [input.from];
	const reply = unique(seeds, own);
	const replyAll = unique([...seeds, input.to, input.cc], own);
	const same =
		reply.length === replyAll.length && reply.every((address, index) => address === replyAll[index]);
	return { reply, replyAll, showReplyAll: replyAll.length > 0 && !same };
}

function unique(parts: Array<string | null | undefined>, own: Set<string>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const part of parts) {
		if (!part) continue;
		for (const piece of part.split(',')) {
			const bare = parseEmailAddress(piece);
			if (!bare.includes('@') || seen.has(bare) || own.has(bare)) continue;
			seen.add(bare);
			result.push(bare);
		}
	}
	return result;
}
