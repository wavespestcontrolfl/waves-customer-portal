/**
 * Disputed estimate phone (B18).
 *
 * A public accept whose staff-typed estimate phone belongs to ANOTHER customer (a lone phone hit the
 * estimate's email and address both contradict) mints the accepter a fresh profile saved WITHOUT that
 * number, and writes a marker note into the profile's internal_notes. estimates.customer_phone still
 * holds the typed (disputed) number, so every sender that texts "the estimate's phone" after the
 * accept would reach the stranger. This module is the ONE definition of that quarantine: the marker,
 * the persisted-state predicates the accept's own text suppression uses, and the check every
 * estimate-based SMS sender calls before texting estimate.customer_phone.
 */

const db = require('../models/db');
const logger = require('./logger');

// The durable marker a contradicted accept writes into the new profile's internal_notes.
const CONTRADICTED_PHONE_NOTE_MARK = 'belongs to another customer, so it was not saved on this profile';

// What an operator sees when a manual send is refused.
const ESTIMATE_PHONE_QUARANTINED_MESSAGE = 'This estimate’s phone number belongs to another customer, so nothing was texted. '
  + 'Add this customer’s real number on their profile first, then send from there.';

// THE predicates for a contradicted-phone profile, from persisted state only (the marker note plus
// the phone on the row), so a profile reached by ANY route is treated the same.
//   marked      = the marker is on the profile: the estimate's staff-typed phone is the DISPUTED
//                 number (another customer's), so no accept text may use it, ever.
//   quarantined = marked AND still phone-less (login and texts resolve nothing until a real number is
//                 added; the office alert replays only while this holds).
function customerHasContradictedPhoneMarker(row) {
  return !!row && String(row.internal_notes || '').includes(CONTRADICTED_PHONE_NOTE_MARK);
}
function customerIsContradictedPhoneQuarantine(row) {
  return customerHasContradictedPhoneMarker(row) && String(row.phone || '').trim() === '';
}

function last10(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

// True when texting estimate.customer_phone would reach a number a contradicted accept quarantined
// for the estimate's customer: the customer carries the marker and the estimate's phone is not the
// customer's OWN number (once the office adds the real one, the customer row's phone differs from the
// disputed one on the estimate, so the estimate's number stays blocked - texts to the real number go
// through the customer's own phone, never this one). An estimate with no customer or no phone is never
// quarantined. FAILS CLOSED: an unreadable customer row reads as quarantined, because a wrong text to
// a stranger cannot be taken back. `dbh` lets a caller inside a transaction read on its own handle.
async function estimatePhoneQuarantined(estimate, dbh = db) {
  if (!estimate?.customer_id || !String(estimate.customer_phone || '').trim()) return false;
  try {
    const row = await dbh('customers').where({ id: estimate.customer_id }).first('id', 'phone', 'internal_notes');
    if (!customerHasContradictedPhoneMarker(row)) return false;
    const own = last10(row.phone);
    return !(own && own === last10(estimate.customer_phone));
  } catch (err) {
    logger.warn(`[estimate-phone-quarantine] marker check failed for estimate ${estimate.id} (customer ${estimate.customer_id}) - treating the phone as quarantined: ${err.message}`);
    return true;
  }
}

module.exports = {
  CONTRADICTED_PHONE_NOTE_MARK,
  ESTIMATE_PHONE_QUARANTINED_MESSAGE,
  customerHasContradictedPhoneMarker,
  customerIsContradictedPhoneQuarantine,
  estimatePhoneQuarantined,
};
