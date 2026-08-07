'use strict';

// Best-effort masking of exception text. Handler/provider/Knex error
// messages can embed customer PII: Twilio errors echo phone numbers, Stripe
// messages can quote a receipt email, and Knex prefixes its failing SQL onto
// err.message — where raw/interpolated queries carry customer names and
// emails as quoted string literals. Same masking discipline as cron-lock's
// sanitizeJobError (AGENTS.md: no customer PII in logs/third-party sinks),
// plus quoted-SQL-literal redaction and a hard length cap.
//
// ⚠️ This pattern allowlist is NOT sufficient as the primary rail to a
// third-party sink: an UNQUOTED customer name or street address matches
// none of these patterns and passes through (codex on #3268). Egress sites
// must therefore send FIXED generic text + allowlisted identifiers (see
// stripe-webhook.js's handler catch and stripe-webhook-health's digest) —
// this scrubber is only the defense-in-depth backstop on exception values
// inside instrument.js's beforeSend.

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

// Strict allowlist for error names/codes bound for a third-party sink: one
// machine token ('ECONNRESET', '23505', 'KnexTimeoutError'), no whitespace,
// no '@', bounded length — a value that fails this is arbitrary prose and
// is DROPPED, never scrubbed-and-forwarded. Numbers (Postgres error codes
// arrive numeric-ish, HTTP statuses numeric) stringify first.
const ERROR_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
function safeErrorToken(value) {
  const str = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  return typeof str === 'string' && ERROR_TOKEN_PATTERN.test(str) ? str : null;
}

module.exports = { scrubSentryText, safeErrorToken, MAX_SCRUBBED_LENGTH };
