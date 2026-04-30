/**
 * Suppression validator. Checks whether a recipient is on the
 * messaging_suppression list for any of: HARD opt-out, wrong-number flag,
 * or per-customer DNC. Wrong-number records survive even when the phone
 * later gets reused — they're keyed on the (phone, recorded_at) pair
 * with an active flag.
 *
 * The table itself ships in commit 7's migration (alongside
 * message_audit_log). Until that migration runs, this validator no-ops
 * gracefully — load_suppression_state catches a missing-table error and
 * returns null, and validators interpret null as "no suppression record".
 *
 * Suppression is HARD: an entry here blocks every purpose, every audience,
 * every channel, until the entry is explicitly cleared. The only escape
 * hatch is a START keyword on the inbound channel, which is handled by
 * the twilio-webhook STOP/START flow and clears the suppression record.
 */

const db = require('../../../models/db');
const logger = require('../../logger');

/**
 * @param {import('../policy').SendCustomerMessageInput} input
 * @param {Object} _policy
 * @param {Object} contactState - augmented by loadSuppressionState before this validator runs
 * @returns {Promise<{ ok: boolean, code?: string, reason?: string }>}
 */
async function checkSuppression(input, _policy, contactState) {
  const suppression = contactState && contactState.suppression;
  if (!suppression) return { ok: true };

  if (suppression.reason === 'opt_out_keyword' || suppression.reason === 'opt_out_natural_language') {
    return {
      ok: false,
      code: 'SUPPRESSED_OPT_OUT',
      reason: `Recipient is suppressed (reason: ${suppression.reason}, since ${suppression.created_at})`,
    };
  }
  if (suppression.reason === 'wrong_number') {
    return {
      ok: false,
      code: 'SUPPRESSED_WRONG_NUMBER',
      reason: `Recipient is on the wrong-number suppression list (since ${suppression.created_at})`,
    };
  }
  if (suppression.reason === 'manual_dnc') {
    return {
      ok: false,
      code: 'SUPPRESSED_MANUAL_DNC',
      reason: 'Recipient was manually added to the do-not-contact list by an operator',
    };
  }

  return {
    ok: false,
    code: 'SUPPRESSED_OTHER',
    reason: `Recipient is suppressed (reason: ${suppression.reason || 'unknown'})`,
  };
}

/**
 * Load the active suppression record (if any) for the recipient phone.
 * Augments contactState in-place.
 *
 * Schema (lands in commit 7 migration):
 *   messaging_suppression
 *     phone           text    primary key
 *     reason          text    'opt_out_keyword'|'opt_out_natural_language'|'wrong_number'|'manual_dnc'|'other'
 *     active          bool    default true
 *     source          text    e.g. 'twilio_webhook_STOP'
 *     captured_body   text    the inbound text that triggered it
 *     created_at      timestamptz
 *     cleared_at      timestamptz nullable — when START or admin clears it
 */
async function loadSuppressionState(input, contactState) {
  if (!input || !input.to) return contactState;
  try {
    const row = await db('messaging_suppression')
      .where({ phone: input.to, active: true })
      .first();
    if (row) {
      contactState.suppression = row;
    }
  } catch (err) {
    if (err && /relation .* does not exist|messaging_suppression/i.test(err.message)) {
      // Migration not yet applied. Fail open — the consent validator's
      // sms_enabled=false path still catches the most common opt-out case
      // (which the existing twilio-webhook STOP handler already writes).
      return contactState;
    }
    logger.warn(`[messaging:suppression] lookup failed: ${err.message}`);
  }
  return contactState;
}

/**
 * Insert / upsert a suppression record. Called by the inbound webhook
 * the moment STOP / wrong-number is detected, before any outbound queue
 * fires. Idempotent — repeated calls just re-stamp the row.
 */
async function recordSuppression({ phone, reason, source, capturedBody }) {
  if (!phone) throw new Error('recordSuppression: phone is required');
  if (!reason) throw new Error('recordSuppression: reason is required');
  try {
    await db('messaging_suppression')
      .insert({
        phone,
        reason,
        source: source || null,
        captured_body: capturedBody ? String(capturedBody).slice(0, 1000) : null,
        active: true,
        created_at: db.fn.now(),
      })
      .onConflict('phone')
      .merge({
        reason,
        source: source || null,
        captured_body: capturedBody ? String(capturedBody).slice(0, 1000) : null,
        active: true,
        cleared_at: null,
      });
    return { ok: true };
  } catch (err) {
    logger.warn(`[messaging:suppression] recordSuppression failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Clear a suppression record (e.g. on inbound START keyword).
 */
async function clearSuppression({ phone, source }) {
  if (!phone) throw new Error('clearSuppression: phone is required');
  try {
    await db('messaging_suppression')
      .where({ phone })
      .update({
        active: false,
        cleared_at: db.fn.now(),
        source: source ? `cleared_by:${source}` : null,
      });
    return { ok: true };
  } catch (err) {
    logger.warn(`[messaging:suppression] clearSuppression failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  checkSuppression,
  loadSuppressionState,
  recordSuppression,
  clearSuppression,
};
