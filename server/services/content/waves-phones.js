/**
 * waves-phones.js — the ONE "is this Waves' own phone number?" check for
 * content gating. Consumed by content-quality-gate (redaction + NAP),
 * seo-completion-gate (PII detector), and content-guardrails (tel: link
 * destinations) — the per-file copies had already drifted once (last-7 vs
 * full-10 keys).
 *
 * Delegates to config/twilio-numbers.js isOwnedNumber(), which covers EVERY
 * owned line — office/GBP locations, main line, spoke/lawn domain tracking,
 * paid + GBP tracking, van wrap, toll-free — so refresh/spoke copy that
 * legitimately carries a tracking number is never classified as customer
 * PII or a disallowed tel: link. The hardcoded office-line floor below is
 * the fail-safe if the config can't load: those six numbers stay
 * recognized no matter what (and anything else then fails CLOSED as
 * not-Waves, which only ever blocks, never leaks).
 */

// Office/GBP + main lines (from server/config/locations.js) — the minimum
// recognizable set when twilio-numbers.js is unavailable.
const CORE_WAVES_PHONES = new Set([
  '9413187612', '9412972817', '9412972606', '9412973337', '9412402066', '9412975749',
]);

function isWavesPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  // Normalize to last 10 digits (drops a leading 1 / +1).
  const last10 = digits.length >= 10 ? digits.slice(-10) : null;
  if (!last10) return false;
  if (CORE_WAVES_PHONES.has(last10)) return true;
  try {
    return require('../../config/twilio-numbers').isOwnedNumber(last10) === true;
  } catch (_) {
    return false;
  }
}

module.exports = { WAVES_PHONES: CORE_WAVES_PHONES, isWavesPhone };
