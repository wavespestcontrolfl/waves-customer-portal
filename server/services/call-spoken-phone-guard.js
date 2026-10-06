/**
 * Spoken-phone guard. A NANP area code cannot start with 0 or 1, so
 * a spoken number that does ("173-303-8616") is a mishearing, never a line.
 * Saved as a contact number it sends texts to a stranger (audited call
 * 2026-10-01). Called right after extraction, BEFORE ai_extraction_enriched is
 * serialized and before any customer, slot or SMS decision reads the fields, so
 * the persisted V2 blob and the asynchronous booking-link sweep never see the
 * impossible number.
 *
 * Two parts, each judged where identity is settled:
 * - rejectImpossibleSpokenPhones nulls the CALLER's own spoken number (V1 view
 *   and V2) right after extraction; a caller left with no dialable number
 *   files caller_phone_missing.
 * - dropImpossibleSecondaryPhones runs on the RESOLVED secondary contacts,
 *   after V1/V2 identity reconciliation, so a misheard number on one
 *   extractor never erases the evidence that the two heard different people,
 *   and "number dropped" is reported only when the number that would be
 *   saved is impossible.
 */
const { isImpossibleNanpPhone } = require('../utils/phone');

// Returns { rejectedCaller }; mutates its arguments.
function rejectImpossibleSpokenPhones({ extracted, v2Extraction = null } = {}) {
  let rejectedCaller = false;
  if (extracted && extracted.phone && isImpossibleNanpPhone(extracted.phone)) {
    extracted.phone = null;
    rejectedCaller = true;
  }
  const v2Caller = v2Extraction && v2Extraction.caller;
  if (v2Caller && v2Caller.phone_e164 && isImpossibleNanpPhone(v2Caller.phone_e164)) {
    v2Caller.phone_e164 = null;
    if (v2Caller.phone_source === 'spoken' || v2Caller.phone_source === 'both') v2Caller.phone_source = 'unknown';
    rejectedCaller = true;
  }
  return { rejectedCaller };
}

const SECONDARY_IDENTITY_KEYS = ['first_name', 'last_name', 'name_full', 'email', 'phone', 'phone_e164'];

// Nulls an impossible number on each resolved secondary contact (in place) and
// drops a contact left with nothing to identify it. Returns true when a number
// that would have been saved was dropped.
function dropImpossibleSecondaryPhones(contacts) {
  if (!Array.isArray(contacts)) return false;
  let dropped = false;
  for (let i = contacts.length - 1; i >= 0; i -= 1) {
    const c = contacts[i];
    if (!c || typeof c !== 'object') continue;
    for (const key of ['phone', 'phone_e164']) {
      if (c[key] && isImpossibleNanpPhone(c[key])) {
        c[key] = null;
        dropped = true;
      }
    }
    if (!SECONDARY_IDENTITY_KEYS.some((k) => String(c[k] || '').trim())) contacts.splice(i, 1);
  }
  return dropped;
}

module.exports = { rejectImpossibleSpokenPhones, dropImpossibleSecondaryPhones };
