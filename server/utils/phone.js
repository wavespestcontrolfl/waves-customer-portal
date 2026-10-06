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

// NANP validity. toE164 keeps the LAST ten digits and never judges them, so a
// ten-digit number whose area code or exchange starts with 0 or 1 (never
// assignable; Twilio refuses it with 21211) used to come out as a well-formed
// "+1..." string and fail only at the provider. toE164's contract stays (many
// callers rely on a string); writers and senders gate on these two instead.
//
// nanpNationalDigits: the ten national digits when the input is NANP-shaped
// (ten digits, 1 + ten digits, or +1 + ten digits), else null.
function nanpNationalDigits(raw) {
  const text = typeof raw === 'string' ? raw.trim() : (typeof raw === 'number' ? String(raw) : '');
  if (!text) return null;
  const digits = text.replace(/\D/g, '');
  if (text.startsWith('+')) return digits.length === 11 && digits[0] === '1' ? digits.slice(1) : null;
  if (digits.length === 10) return digits;
  return digits.length === 11 && digits[0] === '1' ? digits.slice(1) : null;
}

// True only for a NANP number whose area code and exchange start with 2-9.
function isValidNanpNumber(raw) {
  const ten = nanpNationalDigits(raw);
  return !!ten && /^[2-9]\d{2}[2-9]\d{6}$/.test(ten);
}

// A readable reason when the input LOOKS like a US/Canada number but cannot be
// one; null when it is valid, empty, or not NANP-shaped (international and
// short junk are other validators' business, so they stay accepted here).
// A "+1" prefix with the wrong digit count is NANP-shaped and counts as bad.
function nanpPhoneProblem(raw) {
  const text = typeof raw === 'string' ? raw.trim() : (typeof raw === 'number' ? String(raw) : '');
  if (!text) return null;
  const digits = text.replace(/\D/g, '');
  const plusOne = text.startsWith('+') && digits[0] === '1';
  if (!plusOne && nanpNationalDigits(text) === null) return null;
  if (isValidNanpNumber(text)) return null;
  return `${text} is not a valid US phone number. The area code and the next three digits cannot start with 0 or 1, and a US number has ten digits.`;
}

// toE164 returns the raw input on garbage (e.g. "anonymous", "client:foo"), so
// callers that must NOT act on a non-phone value (set a Dial callerId, create a
// lead) should gate on this: optional leading +, then 10–15 digits.
function isLikelyE164(value) {
  const s = String(value || '');
  if (!/^\+?[0-9]/.test(s)) return false;
  const digits = s.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

// Complete digit strings that may identify this contact in mixed stored
// E.164 / domestic formats. International numbers never use suffix matching.
function phoneMatchDigits(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const digits = text.replace(/\D/g, '');
  const normalized = toE164(text);
  if (!/^\+[1-9]\d{7,14}$/.test(normalized || '') || (!text.startsWith('+') && !/^(?:1)?\d{10}$/.test(digits))) return [];
  const full = normalized.slice(1);
  return /^1\d{10}$/.test(full) ? [full, full.slice(1)] : [full];
}

// NANP-vs-international grouping key: same identity rule as smsThreadKey in
// client/src/pages/admin/CommunicationsPageV2.jsx and the both-NANP
// predicate in the inbound-sms-read blocked-numbers query — a NANP number
// (bare 10 digits, 1+10 digits, or +1-prefixed) collapses to its last 10
// digits so '+19415551234', '9415551234', and '(941) 555-1234' share one
// bucket; any other country code keeps its full digits so it can never
// collide with an unrelated NANP number that merely shares the same last
// ten digits (codex #4213 — attaching the wrong customer to a shared-suffix
// international number caused a real wrong-customer incident). Returns null
// only for input with no digits at all.
function phoneIdentityKey(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const digits = text.replace(/\D/g, '');
  if (!digits) return null;
  const isNanp = /^1\d{10}$/.test(digits) || (!text.startsWith('+') && digits.length === 10);
  return isNanp ? digits.slice(-10) : `+${digits}`;
}

module.exports = {
  toE164, normalizePhone: toE164, isLikelyE164, phoneMatchDigits, phoneIdentityKey,
  nanpNationalDigits, isValidNanpNumber, nanpPhoneProblem,
};
