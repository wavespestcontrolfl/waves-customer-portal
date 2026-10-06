/**
 * Spoken-phone guard for the V2 caller. A NANP area code cannot
 * start with 0 or 1, so a spoken caller number that does ("173-303-8616") is a
 * mishearing, never a line. Called right after V2 extraction, BEFORE
 * ai_extraction_enriched is serialized, so the persisted blob and the
 * booking-link sweep never see it; a caller left with no dialable number files
 * caller_phone_missing through the deterministic flags. The V1 record is
 * cleaned by its intake normalizer (utils/intake-normalize.js); a secondary
 * contact's impossible number is refused at the slot writer
 * (persistCallSecondaryContact).
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

module.exports = { rejectImpossibleSpokenPhones };
