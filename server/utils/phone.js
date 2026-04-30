/**
 * Normalize a phone string to canonical E.164 (+countrycodeXXXXXXXXXX).
 *
 * PR1 consolidates the two divergent implementations called out in the
 * call-triage strategy doc (§9 of docs/call-triage-discovery.md):
 *   - server/services/lead-attribution.js:normalizePhone
 *   - server/routes/twilio-voice-webhook.js:toE164
 *
 * Four other variants exist elsewhere in the codebase
 * (public-quote.js, public-property-lookup.js, referral-engine.js,
 * twilio.js); those have subtly different contracts (strict null on
 * garbage, 10-digit-bare for SET membership, etc.) and stay as-is for
 * this PR. Tracked in TODO.md as follow-up consolidation.
 *
 * Rules (preserves existing toE164 behavior exactly):
 *   1. `+` prefix → strip formatting characters but PRESERVE country
 *      code. Critical for non-NANP callers (e.g. UK +44, Brazil +55)
 *      that Twilio's Lookup-enriched Caller ID sometimes surfaces —
 *      assuming NANP would silently rewrite +442079460958 to
 *      +12079460958 and break dashboard JOINs against lead_sources.
 *   2. `+` prefix that fails E.164 length validation (8..15 digits) →
 *      return raw input for debugging rather than fabricate.
 *   3. No `+` prefix → assume NANP/US, take the LAST 10 digits.
 *      Handles "(941) 555-1234", "1-941-555-1234", "9415551234".
 *   4. Garbage (<10 digits and no +) → return raw input for debugging.
 *
 * The previous lead-attribution.js variant returned `+${digits}` for
 * unparseable input, which silently fabricated an invalid E.164. The
 * toE164 contract (return raw on garbage) is safer and is what we
 * preserve here.
 */
function toE164(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  if (s.startsWith('+')) {
    const stripped = '+' + s.slice(1).replace(/\D/g, '');
    return /^\+\d{8,15}$/.test(stripped) ? stripped : raw;
  }

  const digits = s.replace(/\D/g, '');
  if (digits.length < 10) return raw;
  return '+1' + digits.slice(-10);
}

module.exports = { toE164, normalizePhone: toE164 };
