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

// Country-aware identity (utils/phone.js phoneIdentityKey): NANP numbers compare on their last ten digits,
// anything else keeps its country code, so a +44 number sharing a +1 number's suffix is NOT the same phone.
const { phoneIdentityKey } = require('../utils/phone');

// The estimate-scope stamp a contradicted accept writes into estimate_data (no migration: the column is
// jsonb). It names the DISPUTED number by identity key - not by the linked customer - so it follows the
// estimate wherever it goes: the accepted estimate, every estimate in its group (including a still-sent
// sibling the group follow-up transfer re-arms WITHOUT a customer_id) and other open estimates for the
// same person (same phone identity and same email). reviseAdminEstimate carries it across a re-save
// (REVISE_PRESERVED_ESTIMATE_DATA_KEYS / REVISE_SERVER_OWNED_ESTIMATE_DATA_KEYS).
const ESTIMATE_PHONE_DISPUTE_KEY = 'acceptPhoneDispute';

function parseEstimateData(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) || {}; } catch { return {}; }
  }
  return {};
}

// Statuses of an estimate that can still be sent to its phone.
const OPEN_ESTIMATE_STATUSES = ['draft', 'scheduled', 'sending', 'sent', 'viewed'];

// Called INSIDE the accept transaction, LAST (after the accept's own wholesale estimate_data writes, which
// would otherwise overwrite it; the stamp itself is an atomic jsonb_set merge that leaves every other key
// alone and does not touch updated_at). Stamps the accepted estimate, its group, and other open estimates
// for the same person. Returns the stamped ids. Throws on a write failure so the accept rolls back: an
// unstamped quarantine would silently reopen the disputed number.
async function stampEstimatePhoneDispute(trx, { estimate, identity = estimate, rejectedCustomerId, customerId = null }) {
  const key = phoneIdentityKey(identity.customer_phone);
  if (!key) return [];
  const stamp = {
    key,
    rejectedCustomerId: rejectedCustomerId == null ? null : String(rejectedCustomerId),
    acceptedEstimateId: String(estimate.id),
    at: new Date().toISOString(),
  };
  const ids = new Set([estimate.id]);
  if (estimate.estimate_group_id) {
    const siblings = await trx('estimates').where({ estimate_group_id: estimate.estimate_group_id }).whereNot({ id: estimate.id }).select('id');
    siblings.forEach((row) => ids.add(row.id));
  }
  const email = String(identity.customer_email || '').trim().toLowerCase();
  const digits = String(identity.customer_phone || '').replace(/\D/g, '').slice(-10);
  if (email && digits) {
    const peers = await trx('estimates')
      .whereIn('status', OPEN_ESTIMATE_STATUSES)
      .whereNot({ id: estimate.id })
      .whereRaw("regexp_replace(COALESCE(customer_phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${digits}`])
      .select('id', 'customer_phone', 'customer_email', 'customer_id');
    peers
      .filter((row) => phoneIdentityKey(row.customer_phone) === key
        && String(row.customer_email || '').trim().toLowerCase() === email
        && (!row.customer_id || (customerId && String(row.customer_id) === String(customerId))))
      .forEach((row) => ids.add(row.id));
  }
  await trx('estimates').whereIn('id', [...ids]).update({
    estimate_data: trx.raw(
      `jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{${ESTIMATE_PHONE_DISPUTE_KEY}}', ?::jsonb, true)`,
      [JSON.stringify(stamp)],
    ),
  });
  return [...ids];
}

// True when texting estimate.customer_phone would reach a number a contradicted accept disputed. Either
// source says so:
//   1. the estimate carries the stamp AND its CURRENT phone still has the stamped identity key - staff
//      fixing the estimate's phone lifts it; adding the customer's real number on the profile does not
//      (the estimate's stale number stays blocked);
//   2. the estimate's customer carries the marker note and the estimate's phone is not that customer's
//      OWN number (country-aware compare). This is the persisted state the accept's own text suppression
//      reads, and it covers an estimate linked to the profile that was never stamped.
// An estimate with no phone is never quarantined. FAILS CLOSED: unreadable data reads as quarantined, because
// a wrong text to a stranger cannot be taken back. A row without estimate_data loaded is read by id; `dbh` lets
// a caller inside a transaction read on its own handle.
async function estimatePhoneQuarantined(estimate, dbh = db) {
  const phoneKey = phoneIdentityKey(estimate?.customer_phone);
  if (!phoneKey) return false;
  try {
    let rawData = estimate.estimate_data;
    if (rawData === undefined && estimate.id) {
      const row = await dbh('estimates').where({ id: estimate.id }).first('estimate_data');
      rawData = row?.estimate_data;
    }
    const stamp = parseEstimateData(rawData)[ESTIMATE_PHONE_DISPUTE_KEY];
    if (stamp?.key && stamp.key === phoneKey) return true;
    if (!estimate.customer_id) return false;
    const row = await dbh('customers').where({ id: estimate.customer_id }).first('id', 'phone', 'internal_notes');
    if (!customerHasContradictedPhoneMarker(row)) return false;
    const own = phoneIdentityKey(row.phone);
    return !(own && own === phoneKey);
  } catch (err) {
    logger.warn(`[estimate-phone-quarantine] check failed for estimate ${estimate.id} (customer ${estimate.customer_id}) - treating the phone as quarantined: ${err.message}`);
    return true;
  }
}

// THE delivery-time backstop (called by sendCustomerMessage, the one point every text passes through -
// immediate sends, scheduled-SMS replays and retries alike, since the replay forwards the queued row's
// destination and metadata.estimate_id): true when a text about `estimateIds` is headed for the
// DISPUTED number. DESTINATION-side, so a queued item whose estimate phone was since corrected still
// cannot reach the disputed number, and one headed to the customer's real number goes through:
//   - the destination's identity equals a referenced estimate's stamped identity key, or
//   - it equals that estimate's own phone and the estimate's customer carries the marker (the estimate's
//     number is not the customer's own).
// Per-route checks stay where they give the operator a better message; this is the net under them.
// FAILS CLOSED on a read error.
async function sendToEstimatePhoneQuarantined({ estimateIds, to }, dbh = db) {
  const toKey = phoneIdentityKey(to);
  if (!toKey) return false;
  const ids = [...new Set((estimateIds || []).filter(Boolean).map(String))];
  for (const id of ids) {
    try {
      const row = await dbh('estimates').where({ id }).first('id', 'customer_id', 'customer_phone', 'estimate_data');
      if (!row) continue;
      const stamp = parseEstimateData(row.estimate_data)[ESTIMATE_PHONE_DISPUTE_KEY];
      if (stamp?.key && stamp.key === toKey) return true;
      if (phoneIdentityKey(row.customer_phone) === toKey && await estimatePhoneQuarantined(row, dbh)) return true;
    } catch (err) {
      logger.warn(`[estimate-phone-quarantine] delivery check failed for estimate ${id} - holding the text: ${err.message}`);
      return true;
    }
  }
  return false;
}

module.exports = {
  CONTRADICTED_PHONE_NOTE_MARK,
  ESTIMATE_PHONE_QUARANTINED_MESSAGE,
  customerHasContradictedPhoneMarker,
  customerIsContradictedPhoneQuarantine,
  estimatePhoneQuarantined,
  sendToEstimatePhoneQuarantined,
  stampEstimatePhoneDispute,
  ESTIMATE_PHONE_DISPUTE_KEY,
};
