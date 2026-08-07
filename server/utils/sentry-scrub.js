'use strict';

// Scrubs exception text before it reaches Sentry (a third-party system).
// Handler/provider/Knex error messages can embed customer PII: Twilio errors
// echo phone numbers, Stripe messages can quote a receipt email, and Knex
// prefixes its failing SQL onto err.message — where raw/interpolated queries
// carry customer names and emails as quoted string literals. Same masking
// discipline as cron-lock's sanitizeJobError and stripe-webhook-health's
// sanitizeErrorSnippet (AGENTS.md: no customer PII in logs/third-party
// sinks), plus quoted-SQL-literal redaction and a hard length cap.
//
// Used at PII-risky captureException call sites (scrub message+stack, then
// capture the scrubbed synthetic error) AND as the defense-in-depth backstop
// on exception values inside instrument.js's beforeSend.

const MAX_SCRUBBED_LENGTH = 2000;

const EMAIL_PATTERN = /[\w.+-]+@[\w.-]+\.\w+/g;
// Same digit-run shape as cron-lock's sanitizeJobError — phone numbers in
// any common format, without eating short ids or ports.
const NUMBER_PATTERN = /\+?\d[\d\s().-]{5,}\d/g;
// Single-quoted SQL string literals ('Jane Doe') — bounded and single-line
// so an apostrophe in prose can never swallow half a stack trace. Deliberate
// over-redaction (two apostrophes in one line pair up) is the fail-closed
// direction here.
const SQL_LITERAL_PATTERN = /'[^'\n]{0,200}'/g;
// Currency amounts ($36.33) are customer billing data; too short for the
// digit-run pattern, so they get their own.
const CURRENCY_PATTERN = /\$\s?\d[\d,.]*/g;

function scrubSentryText(text) {
  return String(text || '')
    .replace(EMAIL_PATTERN, '[redacted-email]')
    .replace(SQL_LITERAL_PATTERN, "'[redacted]'")
    .replace(CURRENCY_PATTERN, '[redacted-amount]')
    .replace(NUMBER_PATTERN, '[redacted-number]')
    .slice(0, MAX_SCRUBBED_LENGTH);
}

module.exports = { scrubSentryText, MAX_SCRUBBED_LENGTH };
