'use strict';
// Authoritative payment history for ABSENCE claims ("your payment isn't
// showing") — Codex round-10/11 P1 (PR #5331). context-aggregator's
// billing.recentPayments is a 3-row DISPLAY window, so a real 4th payment would
// be falsely denied. This is a separate bounded read of ALL of one customer's
// OWN payments (any status), loaded LAZILY — only when a reply actually makes an
// absence claim — at draft time (ensureAbsenceHistory in the drafter) and at
// send time (the recheck seams), the same source both times.
//
// Payer-billed rows are excluded IN SQL, before the limit (a payment against a
// payer-billed invoice is the PAYER's even though it sits under the homeowner's
// customer_id — same rule as the aggregator), so `complete` is exact:
// complete = ownRows <= cap.
const db = require('../models/db');
const logger = require('./logger');
const { containsAbsencePhrase } = require('./payment-receipt-vocabulary');

const PAYMENT_HISTORY_CAP = 200;

// payments.metadata->>'invoice_id' as a uuid, or NULL when it is not one. invoices.id is a
// uuid PRIMARY KEY (20260401000082_invoices), so comparing the uuid directly lets the planner
// use the key instead of casting the indexed column to text; the CASE guarantees the cast is
// only evaluated for a well-formed value (a malformed metadata string can never throw).
function uuidFromMetadata(alias) {
  const v = `${alias}.metadata->>'invoice_id'`;
  return `(CASE WHEN ${v} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (${v})::uuid END)`;
}

// { rows, complete } or null when the read failed (unknown => callers fail closed).
async function loadPaymentHistory(customerId, dbh = db) {
  if (!customerId) return null;
  try {
    const rows = await dbh('payments')
      .where({ 'payments.customer_id': customerId })
      // Payer-owned money (payments.payer_id — the AP party that paid) never belongs to the
      // homeowner's history, even with no metadata.invoice_id (Codex round-12 P0).
      .whereNull('payments.payer_id')
      // Codex round-15 P1: exclude only an EXPLICIT 'upcoming' row — `status <> 'upcoming'` also
      // drops NULL-status rows (legacy / imported / partially reconciled), which are
      // found-but-unknown evidence that a payment record exists.
      .where(function keepNullStatus() { this.whereNull('payments.status').orWhereNot('payments.status', 'upcoming'); })
      // payments.metadata is JSONB (initial_schema `t.jsonb('metadata')`, never altered), so
      // ->> is total (NULL metadata / missing key => NULL => the row is kept).
      .whereRaw(
        `NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = ${uuidFromMetadata('payments')} AND i.customer_id = ? AND i.payer_id IS NOT NULL)`,
        [customerId],
      )
      .orderBy('payments.payment_date', 'desc')
      .limit(PAYMENT_HISTORY_CAP + 1);
    return { rows: rows.slice(0, PAYMENT_HISTORY_CAP), complete: rows.length <= PAYMENT_HISTORY_CAP };
  } catch (err) {
    logger.warn(`[payment-history] read failed for customer ${customerId}: ${err.message}`);
    return null;
  }
}

// Attach billing.paymentHistory to `context` iff `replyText` makes an absence
// claim and the display window may be hiding history. Mutates and returns the
// context; idempotent (an existing value, including null, is kept).
// Codex round-15 P1: an amount-free negated ack ("Your payment wasn't processed") is a denial of
// receipt too — it needs the authoritative history just like an "isn't showing" claim. Lazy
// require (the drafter requires this module's siblings); a stub without the export = no trigger.
function claimsNegatedAck(text) {
  try {
    const drafter = require('./sms-shadow-drafter');
    return typeof drafter.paymentAckPolarity === 'function' && drafter.paymentAckPolarity(String(text || '')) === 'negated';
  } catch { return false; }
}
async function ensureAbsenceHistory(context, replyText, dbh = db) {
  const billing = context?.billing;
  if (!billing || typeof billing !== 'object' || billing.paymentHistory !== undefined) return context;
  if (!billing.recentPaymentsTruncated || !(containsAbsencePhrase(replyText) || claimsNegatedAck(replyText))) return context;
  billing.paymentHistory = await loadPaymentHistory(context.customer?.id, dbh);
  return context;
}

// Codex round-13 P1: is ANY of this customer's own money still IN FLIGHT? An
// EXISTENCE query over the whole table — deliberately independent of the 3/5-row
// display window (an older processing payment must still block "you're paid up"
// when five newer rows push it out of view). Own = not payer-owned: payments with
// payer_id NULL whose metadata invoice is not a payer-billed one; invoices with
// payer_id NULL. true when a payment is pending/processing/requires_action OR an
// invoice is processing. Returns null when the read fails (unknown => callers
// fail closed). payments.metadata is JSONB, so ->> is total.
const IN_FLIGHT_SQL = `SELECT (
  EXISTS (
    SELECT 1 FROM payments p
    WHERE p.customer_id = ? AND p.payer_id IS NULL
      AND lower(p.status) IN ('pending', 'processing', 'requires_action')
      AND NOT EXISTS (SELECT 1 FROM invoices pi WHERE pi.id = ${uuidFromMetadata('p')} AND pi.customer_id = ? AND pi.payer_id IS NOT NULL)
  )
  OR EXISTS (
    SELECT 1 FROM invoices i
    WHERE i.customer_id = ? AND i.payer_id IS NULL AND lower(i.status) = 'processing'
  )
) AS in_flight`;
async function hasInFlightMoney(customerId, dbh = db) {
  if (!customerId) return null;
  try {
    const res = await dbh.raw(IN_FLIGHT_SQL, [customerId, customerId, customerId]);
    const row = (res && (res.rows ? res.rows[0] : res[0])) || null;
    return row ? row.in_flight === true : null;
  } catch (err) {
    logger.warn(`[payment-history] in-flight read failed for customer ${customerId}: ${err.message}`);
    return null;
  }
}

module.exports = { loadPaymentHistory, ensureAbsenceHistory, hasInFlightMoney, IN_FLIGHT_SQL, PAYMENT_HISTORY_CAP };
