export function replySubject(subject: string): string {
	const trimmed = subject.trim();
	if (/^re:/i.test(trimmed)) return trimmed;
	return `Re: ${trimmed}`;
}

export function forwardSubject(subject: string): string {
	const trimmed = subject.trim();
	if (/^(fwd|fw):/i.test(trimmed)) return trimmed;
	return `Fwd: ${trimmed}`;
}
