const AUTO_REPLY_SUBJECT =
	/^\s*(auto(matic)?[\s-]*reply|autoreply|auto:|out of (the )?office|away:|vacation|i am out of|i'm out of|undeliverable|delivery status notification)/i;

/**
 * A subject that says a machine answered: out-of-office notes and bounces,
 * which don't always set the Auto-Submitted header. Agents never answer these (A14).
 */
export function looksLikeAutoReply(subject: string | null | undefined): boolean {
	return AUTO_REPLY_SUBJECT.test(subject ?? '');
}
