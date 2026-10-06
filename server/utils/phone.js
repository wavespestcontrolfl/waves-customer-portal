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

// NANP numbers can never start an area code or an exchange code with 0 or 1
// (NANP numbering plan: NXX-NXX-XXXX, N = 2-9). A spoken "173-303-8616" or
// "941-155-0123" is therefore a mishearing or a mis-recital, never a real
// line, and a text sent to it reaches a stranger (audited call 2026-10-01: a
// household member's phone was saved as +1 173-303-8616 and texts went to the
// wrong person). True ONLY for a value that is clearly a NANP number (bare 10
// digits, 1+10 digits, or +1 + 10 digits) whose area or exchange code
// is impossible. Anything else (international numbers, short fragments,
// non-phone text) returns false: "not impossible NANP" is not "valid", and
// callers that need "dialable" keep their own length checks.
function isImpossibleNanpPhone(raw) {
  const text = typeof raw === 'string' ? raw.trim() : String(raw ?? '').trim();
  if (!text) return false;
  const digits = text.replace(/\D/g, '');
  let national = null;
  if (text.startsWith('+')) {
    if (digits.length === 11 && digits[0] === '1') national = digits.slice(1);
  } else if (digits.length === 10) {
    national = digits;
  } else if (digits.length === 11 && digits[0] === '1') {
    national = digits.slice(1);
  }
  if (!national) return false;
  return national[0] === '0' || national[0] === '1' || national[3] === '0' || national[3] === '1';
}

module.exports = {
  toE164, normalizePhone: toE164, isLikelyE164, phoneMatchDigits, phoneIdentityKey, isImpossibleNanpPhone,
};
