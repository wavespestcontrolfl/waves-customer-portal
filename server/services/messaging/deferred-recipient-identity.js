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
 *   phone, `{ explicit_recipient: true }` when the account phone was READ
 *   and differs (or the customer row is gone — a deterministic fact, not a
 *   blip). A TRANSIENT lookup failure stamps
 *   `{ recipient_identity_unverified: true }` (codex #3259 r24): freezing
 *   on an error would assert "intentional alternate" about a number nobody
 *   verified — if the snapshot WAS the account phone and the customer
 *   changes it overnight, the frozen bearer link goes to the old number
 *   under asserted customer trust. Unverified rows re-run the decision at
 *   replay via resolveUnverifiedRecipient below.
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
    logger.warn(`[${label}] recipient identity check failed (${err.message}) — deferring the refresh-vs-freeze decision to replay`);
    return { recipient_identity_unverified: true };
  }
}

/**
 * Replay-side resolution for rows stamped `recipient_identity_unverified`.
 *
 * The enqueue-time question ("was the snapshot the account phone?") can only
 * be safely re-answered here when the LIVE account phone still matches the
 * snapshot — then refresh semantics apply and the live number is returned.
 * A mismatch is genuinely ambiguous (customer changed their phone vs the
 * snapshot was an explicit alternate all along), and either guess can hand
 * a bearer link to the wrong person — so it does NOT send: returns
 * { phone: null }, which the scheduled executor maps onto its existing
 * bounded-retry-then-terminal rail (terminal hooks release once-ever claims
 * so the backstop paths re-send fresh with a correctly classified
 * recipient). A failed lookup here is also { phone: null } — retry.
 *
 * @returns {Promise<{ phone: string|null, reason?: string }>}
 */
async function resolveUnverifiedRecipient({ customerId, snapshotPhone, label = 'deferred' }) {
  if (!customerId) return { phone: null, reason: 'no-customer' };
  try {
    const acct = await db('customers').where({ id: customerId }).first('phone');
    const live = String(acct?.phone || '').trim();
    if (live && last10(live) === last10(snapshotPhone)) {
      return { phone: live };
    }
    logger.warn(`[${label}] unverified-recipient row for customer ${customerId} cannot be resolved (live phone ${live ? 'differs from' : 'missing vs'} snapshot) — holding, not sending`);
    return { phone: null, reason: 'identity-unresolved' };
  } catch (err) {
    logger.warn(`[${label}] unverified-recipient lookup failed for customer ${customerId} (${err.message}) — holding for retry`);
    return { phone: null, reason: 'lookup-failed' };
  }
}

module.exports = { recipientRefreshStamp, resolveUnverifiedRecipient, last10 };
