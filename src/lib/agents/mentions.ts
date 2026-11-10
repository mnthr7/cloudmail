/**
 * @mentions in a note a human writes on a thread (A5). "@Sam chase this on
 * Friday" hands the thread to Sam with the note as the request;
 * "@Sam remember: Globex pays on the 15th" adds a fact to Sam's memory.
 */

export type Mention =
	| { agentId: string; kind: 'request' }
	| { agentId: string; kind: 'remember'; fact: string };

/**
 * Agents named in the note, in order, each once. Longer names match first, so
 * "@Sam Billing" isn't read as "@Sam". A name must end at a word boundary.
 */
export function findMentions(note: string, agents: Array<{ id: string; name: string }>): Mention[] {
	const byLength = [...agents].filter((agent) => agent.name.trim()).sort((a, b) => b.name.length - a.name.length);
	const found: Mention[] = [];
	const seen = new Set<string>();
	for (const match of note.matchAll(/(^|[^\w@])@/g)) {
		const start = (match.index ?? 0) + match[0].length;
		const rest = note.slice(start);
		const agent = byLength.find((candidate) => {
			const name = candidate.name.trim();
			return rest.slice(0, name.length).toLowerCase() === name.toLowerCase() && !/^\w/.test(rest.slice(name.length));
		});
		if (!agent || seen.has(agent.id)) continue;
		seen.add(agent.id);
		const after = rest.slice(agent.name.trim().length);
		const remember = after.match(/^[\s,:-]*remember(?:\s+that)?\s*[:,-]?\s*([\s\S]+)$/i);
		const fact = remember?.[1]?.split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim();
		found.push(fact ? { agentId: agent.id, kind: 'remember', fact } : { agentId: agent.id, kind: 'request' });
	}
	return found;
}
