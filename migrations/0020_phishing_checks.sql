-- Phishing checks on inbound mail: sender authentication (SPF, DKIM, DMARC),
-- lookalike domains, impersonated names, and strangers asking for money.
-- Worked out once when the message arrives and shown above it when read.

-- { auth: {spf, dkim, dmarc}, verdict: 'phishing' | 'suspicious' | null, reasons: [...] }.
-- Null on mail that arrived before the checks existed.
ALTER TABLE emails ADD COLUMN security_json TEXT;

-- Move mail that looks like phishing straight to Spam. Off by default: it is
-- still flagged in the inbox either way.
ALTER TABLE user_preferences ADD COLUMN phishing_to_spam INTEGER NOT NULL DEFAULT 0;
