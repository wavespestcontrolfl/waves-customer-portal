/**
 * waves-phones.js — the ONE list of Waves' own phone numbers for content
 * gating. FULL 10 digits (all 941 today, from server/config/locations.js):
 * 318-7612 LWR/Bradenton, 297-2817 Parrish, 297-2606 Sarasota, 297-3337
 * Venice, 240-2066 NP, 297-5749 main (PC + Palmetto).
 *
 * Keyed on the full number: a last-7 key let any customer number sharing a
 * Waves line's last seven digits in a DIFFERENT area code pass as "the
 * business phone". Anything not on the list is treated as customer PII.
 *
 * Consumed by content-quality-gate (redaction + NAP), seo-completion-gate
 * (PII detector), and content-guardrails (tel: link destinations) — the
 * three copies had already drifted once (last-7 vs full-10), so this is the
 * single source.
 */

const WAVES_PHONES = new Set([
  '9413187612', '9412972817', '9412972606', '9412973337', '9412402066', '9412975749',
]);

function isWavesPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  // Normalize to last 10 digits (drops a leading 1 / +1).
  const last10 = digits.length >= 10 ? digits.slice(-10) : null;
  return !!last10 && WAVES_PHONES.has(last10);
}

module.exports = { WAVES_PHONES, isWavesPhone };
