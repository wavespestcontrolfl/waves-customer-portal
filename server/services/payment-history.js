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
const { loadPayerLinkage } = require('./payer-linkage');
const logger = require('./logger');
const { excludeNeverAttemptedDeferrals } = require('./failed-payments');
const { containsAbsencePhrase } = require('./payment-receipt-vocabulary');

const PAYMENT_HISTORY_CAP = 200;
// most rows surfaceReferencedPayments adds to the model-facing window
const SURFACED_PAYMENTS_MAX = 5;

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
    // ONE shared payer-linkage predicate (services/payer-linkage.js — the one billing-v2 uses for the customer's
    // own history): metadata invoice_id + aliases, PaymentIntent, charge, "Invoice <n> —" description, and the
    // payer_billed: withdrawal stamp. Unknown ownership (lookup failed) => unknown history (null) — Codex round-28 P1.
    const linkage = await loadPayerLinkage(customerId, dbh);
    if (linkage.failed) return null;
    const fetched = await dbh('payments')
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
      // A never-attempted placeholder (collection_hold OR lock_contention deferral) is not a payment the customer made: it neither
      // contradicts "your payment isn't showing" nor grounds "your payment failed". ONE shared SQL exclusion for every placeholder
      // kind (services/failed-payments.js), applied BEFORE the cap (Codex round-37/38 P1).
      .modify((qb) => excludeNeverAttemptedDeferrals(qb, 'payments'))
      .orderBy('payments.payment_date', 'desc')
      .orderBy('payments.created_at', 'desc') // deterministic tie-break for same-day attempts (Codex round-27 P1)
      .orderBy('payments.id', 'desc')
      .limit(PAYMENT_HISTORY_CAP + 1);
    // `complete` reflects the RAW read (payer-linked rows dropped below must not make a truncated read look whole)
    return {
      rows: fetched.filter((p) => !linkage.isPayerLinked(p)).slice(0, PAYMENT_HISTORY_CAP),
      complete: fetched.length <= PAYMENT_HISTORY_CAP,
    };
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
// Codex round-29 P2: "own" money is judged by the SAME shared payer-linkage predicate as the history (services/
// payer-linkage.js) — not just metadata.invoice_id: candidate in-flight payments come back from SQL (payer_id NULL,
// pending / processing / requires_action, capped) and are filtered in JS through every linkage; a processing INVOICE
// counts only if it is the homeowner's (payer_id NULL and not withdrawn to a payer by stamp).
const IN_FLIGHT_PAYMENTS_LIMIT = 200;
const IN_FLIGHT_PAYMENTS_SQL = `SELECT id, metadata, stripe_payment_intent_id, stripe_charge_id, description
  FROM payments
  WHERE customer_id = ? AND payer_id IS NULL
    AND lower(status) IN ('pending', 'processing', 'requires_action')
  LIMIT ${IN_FLIGHT_PAYMENTS_LIMIT}`;
const IN_FLIGHT_INVOICE_SQL = `SELECT 1 AS in_flight FROM invoices
  WHERE customer_id = ? AND payer_id IS NULL AND lower(status) = 'processing'
    AND (scheduled_send_error IS NULL OR scheduled_send_error NOT LIKE 'payer_billed:%')
  LIMIT 1`;
const rowsOf = (res) => (res && (res.rows || (Array.isArray(res) ? res : []))) || [];
async function hasInFlightMoney(customerId, dbh = db) {
  if (!customerId) return null;
  try {
    const linkage = await loadPayerLinkage(customerId, dbh);
    if (linkage.failed) return null; // ownership unknown => unknown (callers read null as in flight)
    const candidates = rowsOf(await dbh.raw(IN_FLIGHT_PAYMENTS_SQL, [customerId]));
    if (candidates.some((p) => !linkage.isPayerLinked(p))) return true;
    // every candidate was payer-linked but the read was FULL: rows beyond the cap are unseen => unknown, not "clear"
    if (candidates.length >= IN_FLIGHT_PAYMENTS_LIMIT) return null;
    return rowsOf(await dbh.raw(IN_FLIGHT_INVOICE_SQL, [customerId])).length > 0;
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
    // The FULL history stays on billing.paymentHistory (validation binds against it); only a handful of the
    // best matches — most recent first (history rows are date-desc) — join the MODEL-FACING recent payments, so a
    // broad identity (e.g. just a tender) can never push ~200 rows into the prompt (Codex round-28 P2).
    const extra = rows.filter((p) => p && !(p.id && shown.has(p.id)) && drafter.paymentRowMatchesIdentity(p, identity)).slice(0, SURFACED_PAYMENTS_MAX);
    if (extra.length) billing.recentPayments = [...(billing.recentPayments || []), ...extra];
  } catch (err) {
    logger.warn(`[payment-history] could not surface referenced payments: ${err.message}`);
  }
  return context;
}

module.exports = { loadPaymentHistory, ensureAbsenceHistory, surfaceReferencedPayments, hasInFlightMoney, IN_FLIGHT_PAYMENTS_SQL, IN_FLIGHT_INVOICE_SQL, PAYMENT_HISTORY_CAP };
