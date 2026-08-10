// Recipient identity for send-window-deferred rows.
//
// A queued row's `to_phone` is a SNAPSHOT frozen at hold time. Two different
// things can be true of that snapshot, and they demand opposite replay
// behavior:
//
//   1. It IS the account phone → re-read the live customers row at send time
//      (`refresh_customer_phone`). The number the cron asserts
//      phone_matches_customer trust for must still come from the customer
//      row, not a snapshot the customer may have changed overnight.
//   2. It is an EXPLICIT alternate — a consented caller (Codex #2771
//      routing), or an estimate whose captured `customer_phone`
//      legitimately differs from the account phone because the linkage was
//      made on an email match (admin-estimate-persistence's contact guard
//      accepts either) → FREEZE it (`explicit_recipient`). Refreshing here
//      would hand a bearer link (secure card page, estimate/booking token)
//      to a different person than the immediate send chose.
//
// Getting this backwards is a misdelivery, not a formatting nit, which is
// why the decision lives in ONE place: every deferred enqueue whose
// recipient could be an alternate calls this instead of hardcoding a flag.
// (codex #3259 r19 → r22.)

const db = require('../../models/db');
const logger = require('../logger');

function last10(v) {
  return String(v || '').replace(/\D/g, '').slice(-10);
}

/**
 * Decide the recipient-resolution metadata for a deferred row.
 *
 * @param {object}  args
 * @param {string|number|null} args.customerId  account the row belongs to
 * @param {string|null} args.recipientPhone     the number being queued
 * @param {object|null} [args.customerRow]      pre-fetched { phone } to skip the read
 * @param {string} [args.label]                 log prefix
 * @returns {Promise<object>} metadata fragment to spread into the row's JSON:
 *   `{ refresh_customer_phone: true }` when the snapshot IS the account
 *   phone, `{ explicit_recipient: true }` otherwise. An unverifiable
 *   identity (lookup error, missing customer) FREEZES — falling back to a
 *   refresh would be a guess that can misdeliver, while freezing simply
 *   keeps the number the immediate send already used.
 */
async function recipientRefreshStamp({ customerId, recipientPhone, customerRow = null, label = 'deferred' }) {
  if (!customerId) return {};
  try {
    const acct = customerRow && customerRow.phone !== undefined
      ? customerRow
      : await db('customers').where({ id: customerId }).first('phone');
    const snapshot = last10(recipientPhone);
    if (acct && snapshot && last10(acct.phone) === snapshot) {
      return { refresh_customer_phone: true };
    }
    return { explicit_recipient: true };
  } catch (err) {
    logger.warn(`[${label}] recipient identity check failed (${err.message}) — freezing the queued number`);
    return { explicit_recipient: true };
  }
}

module.exports = { recipientRefreshStamp, last10 };
