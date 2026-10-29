/**
 * "A staff action answers a text" (GATE_SMS_STAFF_ACTION_ANSWERS; owner
 * 2026-10-29, decision page "Stuck Alert Fixes" F1).
 *
 * A customer texts "please remove that spot" or "I will Zelle you $108"; the
 * office does the thing (books the visit, records the payment) and the system
 * texts the customer a confirmation or a receipt. Those texts are automatic
 * types, so the Messages reader never counted them as an answer and the text
 * stayed "needs reply". This module is the ONE definition of the actions that
 * count, shared by the admin-alert witness (admin-alert-contact-witnesses.js)
 * and, in `true` mode only, the Messages reader (sms-pending-conversations.js).
 *
 * A staff action answers a text when it is for the text's customer (by
 * customer id only, never by phone), happened after the text and within
 * STAFF_ACTION_WINDOW_HOURS of it, and is one of:
 *   - a visit a person created in the admin (visitFacts below);
 *   - a payment a person recorded (paymentFacts below).
 * Pure definitions and SQL fragments: nothing here reads the gate or the db.
 */

const { VISIT_NEVER_RAN_STATUSES } = require('./invoice-helpers');

const STAFF_ACTION_WINDOW_HOURS = 24;

// scheduled_services.source_action values that mean a PERSON booked the visit
// in the admin. Every other value is automatic or customer-driven and is NOT a
// staff action: voice_agent, ai_call_pipeline*, ai_call_outbound_review,
// package_followup_auto, the booking pages and estimate acceptance (no
// source_action or their own), auto-dispatch and series top-ups.
//   - admin_manual: the admin create-visit route (routes/admin-schedule.js) and
//     the Dispatch follow-up button (services/completion-followup-booking.js
//     default). The real case: the office booked a re-service for a customer
//     who had just texted.
//   - admin_ib: the Intelligence Bar close-out repair booking the follow-up
//     visit a person approved on a card (services/intelligence-bar/
//     closeout-repair-tools.js).
//   - admin_new_caller: the office booked a visit for a new caller while on the
//     call (services/booking/new-caller-visit.js); the customer is linked to
//     it later, so only a visit already linked to this customer counts.
const STAFF_VISIT_SOURCE_ACTIONS = Object.freeze(['admin_manual', 'admin_ib', 'admin_new_caller']);

// invoices.payment_recorded_by values written by a SYSTEM recorder, not a
// person. The Zelle notice reconciler (services/zelle-notice-reconciler.js
// RECORDED_BY, asserted equal in the tests) settles an invoice from a bank or
// email notice with nobody in the admin; a person's recording stores their name,
// email, technician id or the 'admin' fallback. A card or Auto Pay payment
// stores no payment_recorded_by at all.
const SYSTEM_PAYMENT_RECORDERS = Object.freeze(['zelle-notice-reconciler']);

const KIND_VISIT = 'visit';
const KIND_PAYMENT = 'payment';

// What the admin alert and the digest say, in plain words.
const STAFF_ACTION_REASONS = Object.freeze({
  [KIND_VISIT]: 'A visit was booked',
  [KIND_PAYMENT]: 'A payment was recorded',
});

const literal = (list) => list.map((value) => `'${String(value).replace(/'/g, "''")}'`).join(', ');

// Visit and payment rows, as the knex queries of the alert witness read them.
// `visitFilter(query)` / `paymentFilter(query)` narrow a scheduled_services
// (alias ss) / invoices (alias inv) query to the rows that are a staff action;
// the caller adds the customer, the time window and the select.
function visitFilter(query) {
  return query
    .whereNull('ss.recurring_parent_id')
    .whereIn('ss.source_action', STAFF_VISIT_SOURCE_ACTIONS)
    .where((w) => w.whereNull('ss.status').orWhereNotIn('ss.status', VISIT_NEVER_RAN_STATUSES));
}

function paymentFilter(query) {
  return query
    .whereRaw("NULLIF(BTRIM(inv.payment_recorded_by), '') IS NOT NULL")
    .whereNotIn('inv.payment_recorded_by', SYSTEM_PAYMENT_RECORDERS)
    .whereNotNull('inv.payment_recorded_at');
}

// SQL for the Messages reader: is there a staff action for `customerSql` in the
// 24 hours after `afterSql` (an inbound text's created_at)? No "?" and no
// ":word" in the text, so db.raw reads no binding in it.
function staffActionExistsSql(customerSql, afterSql) {
  const within = (column) => `${column} > ${afterSql} AND ${column} <= ${afterSql} + INTERVAL '${STAFF_ACTION_WINDOW_HOURS} hours'`;
  return `(EXISTS (
      SELECT 1 FROM scheduled_services staff_visit
      WHERE staff_visit.customer_id = ${customerSql}
        AND ${within('staff_visit.created_at')}
        AND staff_visit.recurring_parent_id IS NULL
        AND staff_visit.source_action IN (${literal(STAFF_VISIT_SOURCE_ACTIONS)})
        AND (staff_visit.status IS NULL OR staff_visit.status NOT IN (${literal(VISIT_NEVER_RAN_STATUSES)}))
    ) OR EXISTS (
      SELECT 1 FROM invoices staff_payment
      WHERE staff_payment.customer_id = ${customerSql}
        AND ${within('staff_payment.payment_recorded_at')}
        AND NULLIF(BTRIM(staff_payment.payment_recorded_by), '') IS NOT NULL
        AND staff_payment.payment_recorded_by NOT IN (${literal(SYSTEM_PAYMENT_RECORDERS)})
    ))`;
}

module.exports = {
  STAFF_ACTION_WINDOW_HOURS,
  STAFF_VISIT_SOURCE_ACTIONS,
  SYSTEM_PAYMENT_RECORDERS,
  KIND_VISIT,
  KIND_PAYMENT,
  STAFF_ACTION_REASONS,
  visitFilter,
  paymentFilter,
  staffActionExistsSql,
};
