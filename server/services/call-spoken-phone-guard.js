/**
 * Spoken-phone guard. NANP area and exchange codes cannot start with 0 or 1, so
 * a spoken number that does ("173-303-8616") is a mishearing, never a line.
 * Saved as a contact number it sends texts to a stranger (audited call
 * 2026-10-01). Called right after extraction, BEFORE ai_extraction_enriched is
 * serialized and before any customer, slot or SMS decision reads the fields, so
 * the persisted V2 blob and the asynchronous booking-link sweep never see the
 * impossible number.
 *
 * Nulls the number on the caller (V1 view and V2) and on every secondary
 * contact. The call keeps its existing advisory cards: a dropped secondary
 * number files secondary_contact_captured ("ask again"), and a caller left with
 * no dialable number files caller_phone_missing.
 */
const { isImpossibleNanpPhone } = require('../utils/phone');

function secondaryPeople(extracted, v2Extraction) {
  const people = [extracted && extracted.secondary_contact];
  if (v2Extraction) {
    people.push(v2Extraction.secondary_contact);
    if (Array.isArray(v2Extraction.secondary_contacts)) people.push(...v2Extraction.secondary_contacts);
  }
  return people.filter((p) => p && typeof p === 'object');
}

// Returns { rejectedSecondary, rejectedCaller }; mutates its arguments.
function rejectImpossibleSpokenPhones({ extracted, v2Extraction = null } = {}) {
  let rejectedSecondary = 0;
  for (const person of secondaryPeople(extracted, v2Extraction)) {
    for (const key of ['phone', 'phone_e164']) {
      if (person[key] && isImpossibleNanpPhone(person[key])) {
        person[key] = null;
        rejectedSecondary += 1;
      }
    }
  }
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
  return { rejectedSecondary, rejectedCaller };
}

module.exports = { rejectImpossibleSpokenPhones };
