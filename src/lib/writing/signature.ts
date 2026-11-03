const OPEN = '<div data-qm-signature="';

export function applySignature(html: string, signatureHtml: string | null): string {
	const next = signatureHtml?.trim() ?? '';
	const block = next ? `<div data-qm-signature="1">${next}</div>` : '';
	const start = html.indexOf(OPEN);
	if (start !== -1) {
		const attrEnd = html.indexOf('">', start);
		if (attrEnd !== -1) {
			const kind = html.slice(start + OPEN.length, attrEnd);
			if (kind === 'edited') return html;
			if (kind === '1') {
				const end = matchingDivEnd(html, attrEnd + 2);
				if (end !== -1) return html.slice(0, start) + block + html.slice(end);
			}
		}
	}
	const quoteAt = html.indexOf('<blockquote');
	if (quoteAt === -1) return `${html}${block}`;
	return `${html.slice(0, quoteAt)}${block}${html.slice(quoteAt)}`;
}

function matchingDivEnd(html: string, contentStart: number): number {
	const tag = /<\/?div\b[^>]*>/gi;
	tag.lastIndex = contentStart;
	let depth = 1;
	let match: RegExpExecArray | null;
	while ((match = tag.exec(html)) !== null) {
		const token = match[0];
		if (/^<\//.test(token)) {
			depth--;
			if (depth === 0) return match.index + token.length;
		} else if (!/\/\s*>$/.test(token)) {
			depth++;
		}
	}
	return -1;
}
