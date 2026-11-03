import type { MailCategory } from './categories';

export type FilterRule = {
	matchFrom?: string | null;
	matchTo?: string | null;
	matchSubject?: string | null;
	matchWords?: string | null;
	matchHasAttachment?: boolean;
	actionCategory?: MailCategory | null;
};

export type FilterMail = {
	from: string;
	to: string;
	subject: string;
	bodyText: string;
	hasAttachment: boolean;
};

export function filterMatches(rule: FilterRule, mail: FilterMail): boolean {
	const checks: boolean[] = [];
	pushText(checks, rule.matchFrom, mail.from);
	pushText(checks, rule.matchTo, mail.to);
	pushText(checks, rule.matchSubject, mail.subject);
	if (rule.matchWords?.trim()) {
		const needle = rule.matchWords.trim().toLowerCase();
		checks.push(
			mail.subject.toLowerCase().includes(needle) || mail.bodyText.toLowerCase().includes(needle)
		);
	}
	if (rule.matchHasAttachment) checks.push(mail.hasAttachment);
	return checks.length > 0 && checks.every(Boolean);
}

export function winningCategory(rules: FilterRule[], mail: FilterMail): MailCategory | null {
	let category: MailCategory | null = null;
	for (const rule of rules) {
		if (rule.actionCategory && filterMatches(rule, mail)) category = rule.actionCategory;
	}
	return category;
}

function pushText(checks: boolean[], needle: string | null | undefined, haystack: string) {
	const term = needle?.trim().toLowerCase();
	if (!term) return;
	checks.push(haystack.toLowerCase().includes(term));
}
