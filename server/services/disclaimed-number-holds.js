/**
 * Disclaimed-number SMS hold (callback_number_needed, PR #4807 codex
 * round 6 — structural).
 *
 * A caller who says "this number isn't mine" and gives no callback of their
 * own leaves us exactly one number on file that we now KNOW is wrong to
 * text. Rounds 2–6 kept that promise per appointment (scheduled_services.
 * callback_number_hold_at) and each round found another sender the
 * appointment key could not see (estimate/invoice follow-ups text
 * customers.phone with no visit id at all). The invariant is about the
 * DESTINATION NUMBER, so the durable state is a row per (number, call) in
 * disclaimed_number_holds and the one predicate below is checked by
 * sendCustomerMessage for EVERY SMS — at the pipeline and again at the
 * provider boundary — whatever metadata the sender carries.
 *
 * Active = cleared_at IS NULL. Not customer-scoped (see the migration,
 * 20260925000200_disclaimed_number_holds.js): a duplicate/merged customer
 * record or a lead carrying the same ANI must not route around it.
 */
const db = require('../models/db');
const logger = require('./logger');
const { toE164, isLikelyE164 } = require('../utils/phone');

const TABLE = 'disclaimed_number_holds';

// Canonical key for a hold row / a send's `to`. null for anything that is
// not a dialable number (the send can't reach a disclaimed number with it,
// and a hold on it could never match a real send either).
function holdPhoneKey(raw) {
  if (!raw) return null;
  const e164 = toE164(raw);
  return typeof e164 === 'string' && isLikelyE164(e164) ? e164 : null;
}

// Postgres 42P01: the table does not exist (migration not applied). Nothing
// can ever have been written to a table that isn't there — so, unlike every
// other read error, this one PROVES there is no hold (the same reasoning
// messaging/validators/suppression.js applies to its own table). Treating
// it as "held" would block every SMS in the system for no recorded reason.
function isMissingTable(err) {
  return !!err && (err.code === '42P01' || /relation .*disclaimed_number_holds.* does not exist/i.test(err.message || ''));
}

/**
 * Record (or re-arm) the hold for one disclaimed number from one call.
 * Idempotent per (number, call): a second write in the same processing
 * pass is a no-op on an active row (it only fills customer_id when the
 * earlier write didn't know it). A write against a CLEARED row re-arms it —
 * the processor only writes when THIS pass raised callback_number_needed
 * again (a force-reprocess), and a stale clearance must never satisfy a
 * freshly raised flag (the round-5 P1 re-arm rule, now on the number row).
 * Throws on DB error — the caller decides whether that aborts (the booking
 * transaction) or is logged (the non-booking write).
 */
async function recordDisclaimedNumberHold({ phone, customerId = null, callLogId, conn = db }) {
  const phoneE164 = holdPhoneKey(phone);
  if (!phoneE164 || !callLogId) return { recorded: false, reason: phoneE164 ? 'no_call' : 'no_phone' };
  await conn.raw(
    `INSERT INTO ${TABLE} (phone_e164, customer_id, source_call_log_id, held_at)
     VALUES (?, ?, ?, now())
     ON CONFLICT (phone_e164, source_call_log_id) DO UPDATE SET
       customer_id = COALESCE(EXCLUDED.customer_id, ${TABLE}.customer_id),
       held_at = CASE WHEN ${TABLE}.cleared_at IS NULL THEN ${TABLE}.held_at ELSE now() END,
       cleared_at = NULL,
       cleared_by = NULL,
       clear_reason = NULL,
       updated_at = now()`,
    [phoneE164, customerId || null, callLogId],
  );
  return { recorded: true, phoneE164 };
}

/**
 * Lift every active hold a call placed. The office resolving the
 * callback_number_needed card is the ONE clearance (a verified number);
 * a customer phone edit clears nothing — the old number was never
 * verified, and the new number simply has no row.
 */
async function clearDisclaimedNumberHoldsForCall({ callLogId, clearedBy = null, reason, conn = db }) {
  if (!callLogId) return 0;
  const now = new Date();
  return conn(TABLE)
    .where({ source_call_log_id: callLogId })
    .whereNull('cleared_at')
    .update({
      cleared_at: now,
      cleared_by: clearedBy ? String(clearedBy).slice(0, 100) : null,
      clear_reason: reason ? String(reason).slice(0, 100) : null,
      updated_at: now,
    });
}

/**
 * Raw read: true/false, THROWS on a read error (other than a missing
 * table). The two wrappers below decide what an error means.
 */
async function disclaimedNumberHeld(to, conn = db) {
  const phoneE164 = holdPhoneKey(to);
  if (!phoneE164) return false;
  try {
    const row = await conn(TABLE).where({ phone_e164: phoneE164 }).whereNull('cleared_at').first('id');
    return !!row;
  } catch (err) {
    // Inside a caller's transaction the failed statement has already
    // aborted it — rethrow (the wrapper fails closed) rather than claim a
    // clean answer on a poisoned connection.
    if (!conn.isTransaction && isMissingTable(err)) {
      logger.warn('[disclaimed-number-hold] table missing — no hold can exist; not holding');
      return false;
    }
    throw err;
  }
}

/**
 * THE predicate every SMS passes (sendCustomerMessage step 6.45 and its
 * providerPreparationCheck / withSmsHandoff rechecks). FAILS CLOSED: this
 * decides whether we may text a number at all, so an unreadable answer is
 * "held", never "safe" — the send comes back retryable (and senders with an
 * email leg fall back to it), so a blip costs a delayed text, never a text
 * to a number the caller disclaimed.
 */
async function disclaimedNumberBlocksSend({ to, conn = db } = {}) {
  try {
    return await disclaimedNumberHeld(to, conn);
  } catch (err) {
    logger.warn(`[disclaimed-number-hold] read failed — failing CLOSED (treating as held): ${err.code || err.name || 'db_error'}`);
    return true;
  }
}

/**
 * Visit-level read for the PRE-checks (appointment-reminders.js's
 * callbackNumberHoldActiveForVisit / ...ConfirmedForVisit, which decide up
 * front to route a visit's notice to email instead of attempting SMS): is
 * the phone on file for the customer(s) of this visit an actively held
 * number? Same rows as the send predicate, so the pre-check and the
 * boundary can never disagree about a number — and nothing here reads a
 * per-visit hold column, so a terminal member kept in a frozen visit group
 * cannot strand its live siblings (round-6 P2).
 *
 * Accepts a bare scheduledServiceId or { scheduledServiceId, visitId }.
 * Every member of a grouped occurrence is resolved (a pre-existing sibling
 * can be the notification owner). A caller that already resolved visitId —
 * even to null, "confirmed ungrouped" — passes the key and it is trusted;
 * a caller with no visitId KEY at all gets it resolved from the row
 * (round-3 finding #4: a plain `undefined` never reads as "no group").
 * No visit context at all → false. THROWS on a read error — both callers
 * map that to their own posture (fail-closed boolean vs. tri-state null).
 */
async function disclaimedNumberHeldForVisit(idsOrScheduledServiceId, conn = db) {
  const isPlainId = typeof idsOrScheduledServiceId === 'string' || idsOrScheduledServiceId == null;
  const scheduledServiceId = isPlainId ? idsOrScheduledServiceId : idsOrScheduledServiceId.scheduledServiceId;
  const visitIdSupplied = !isPlainId && Object.prototype.hasOwnProperty.call(idsOrScheduledServiceId, 'visitId');
  let visitId = visitIdSupplied ? idsOrScheduledServiceId.visitId : null;
  if (!scheduledServiceId && !visitId) return false;
  if (!visitIdSupplied && scheduledServiceId) {
    const owner = await conn('scheduled_services').where({ id: scheduledServiceId }).first('visit_id');
    visitId = owner?.visit_id || null;
  }
  const rows = await conn('scheduled_services')
    .where(function idOrVisitId() {
      if (scheduledServiceId) this.orWhere('id', scheduledServiceId);
      if (visitId) this.orWhere('visit_id', visitId);
    })
    .select('customer_id');
  const customerIds = [...new Set(rows.map((row) => row.customer_id).filter(Boolean))];
  if (!customerIds.length) return false;
  const customers = await conn('customers').whereIn('id', customerIds).select('phone');
  const phones = [...new Set(customers.map((c) => holdPhoneKey(c.phone)).filter(Boolean))];
  for (const phone of phones) {
    if (await disclaimedNumberHeld(phone, conn)) return true;
  }
  return false;
}

module.exports = {
  holdPhoneKey,
  recordDisclaimedNumberHold,
  clearDisclaimedNumberHoldsForCall,
  disclaimedNumberHeld,
  disclaimedNumberBlocksSend,
  disclaimedNumberHeldForVisit,
  TABLE,
};
