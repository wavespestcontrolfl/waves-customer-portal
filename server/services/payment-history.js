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
      .orderBy('payments.created_at', 'desc') // deterministic tie-break for same-day attempts (Codex round-27 P1)
      .orderBy('payments.id', 'desc')
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
// Does the reply make ANY payment claim the drafter would validate (a recognized status / receipt claim or an
// unrecognized payment assertion)? Lazy require; a stub without the export = no trigger.
function makesPaymentClaim(text) {
  try {
    const drafter = require('./sms-shadow-drafter');
    return typeof drafter.paymentClauseNeedsValidation === 'function' && drafter.paymentClauseNeedsValidation(String(text || ''), {});
  } catch { return false; }
}
async function ensureAbsenceHistory(context, replyText, dbh = db) {
  const billing = context?.billing;
  if (!billing || typeof billing !== 'object' || billing.paymentHistory !== undefined) return context;
  // Codex round-27 P1: when the 3-row display window is truncated, ANY status / receipt claim binds against
  // incomplete rows (hidden same-day attempts) — load the authoritative history before binding, at draft AND
  // send (both call this). Absence phrases and negated acks were the original triggers.
  if (!billing.recentPaymentsTruncated || !(containsAbsencePhrase(replyText) || claimsNegatedAck(replyText) || makesPaymentClaim(replyText))) return context;
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

// Codex round-18 P2: for a customer message that asks about a payment with a NAMED identity (amount, date
// and/or tender), pull the matching rows out of the authoritative history into billing.recentPayments
// BEFORE the facts are built — a payment older than the 3-row display window would otherwise be absent
// from the facts and the model would (correctly, per its rules) answer "not showing". Reads history
// only when the window was truncated and the message names an identity; never throws (a failed read
// leaves the context as it was — the post-draft absence check still fails closed).
async function surfaceReferencedPayments(context, inboundMessage, dbh = db) {
  try {
    const billing = context?.billing;
    if (!billing || typeof billing !== 'object' || !billing.recentPaymentsTruncated) return context;
    const { inboundNamesPayment } = require('./payment-receipt-vocabulary');
    if (!inboundNamesPayment(inboundMessage)) return context;
    const drafter = require('./sms-shadow-drafter');
    if (typeof drafter.paymentIdentityFromText !== 'function') return context;
    const identity = drafter.paymentIdentityFromText(inboundMessage);
    if (!identity.amounts.length && !identity.date && !identity.tender) return context;
    if (billing.paymentHistory === undefined) billing.paymentHistory = await loadPaymentHistory(context.customer?.id, dbh);
    const rows = billing.paymentHistory?.rows;
    if (!Array.isArray(rows)) return context;
    const shown = new Set((billing.recentPayments || []).map((p) => p && p.id).filter(Boolean));
    const extra = rows.filter((p) => p && !(p.id && shown.has(p.id)) && drafter.paymentRowMatchesIdentity(p, identity));
    if (extra.length) billing.recentPayments = [...(billing.recentPayments || []), ...extra];
  } catch (err) {
    logger.warn(`[payment-history] could not surface referenced payments: ${err.message}`);
  }
  return context;
}

module.exports = { loadPaymentHistory, ensureAbsenceHistory, surfaceReferencedPayments, hasInFlightMoney, IN_FLIGHT_SQL, PAYMENT_HISTORY_CAP };
