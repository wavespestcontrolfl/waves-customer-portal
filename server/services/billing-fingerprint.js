'use strict';
// "Has anything in this customer's billing changed since the full recheck?" (Codex round-48/49 P1, PR #5331.)
//
// A billing reply (an amount, a payment-status sentence, a Zelle offer or denial) is fully rechecked before provider entry - the
// context aggregator, the renderer, the Zelle eligibility reads - but each send path still awaits more steps (link / claim / consent
// / policy, the re-service handoff) before Twilio. Repeating the full recheck at the provider boundary would need a second pool
// connection while the handoff holds one (a pool of 2 can deadlock). Instead the fingerprint of every row the recheck reads is taken
// BEFORE that recheck, and re-read at the boundary in ONE query on the handoff's own connection: any change in between (a payment
// landing, an invoice settling or being withdrawn, a plan, a payer assignment, account credit that would cover it, the dues authority:
// billing mode / rate / tier, the saved methods a surcharge is computed from, annual-prepay terms, the visits of a prepaid plan: the rows its
// "visits left" sentence counts, the customer's open estimates: the rows its price sentence is read from, the call, lead and move rows that
// decide whether a call-drafted or new-home estimate is on the customer's own page, the live plan an open estimate is priced and billed
// against, and the tax exemption certificates a tax-free pay-for-the-year total stands on) refuses the send as RETRYABLE - the retry
// reruns the full recheck on the new state. Content-based (md5 of the rows), so a write that does not bump updated_at still counts.
const db = require('../models/db');

// Codex round-55 P1 - WHOLE ROWS, not a column list: every round named one more column the recheck reads (dues eligibility, pause /
// deactivation, ACH health, card expiry, ...). Each of the customer's billing rows is hashed in full (md5 of the row text), so any
// change to a row the full recheck could have read refuses the send at the boundary - a new column can never be missed. The cost is a
// retryable refusal when an unrelated column of one of these rows changes in the seconds between the recheck and the provider call.
// The customer's open estimates: the rows the estimate sentences are rendered from.
const OPEN_ESTIMATES = "FROM estimates t WHERE t.customer_id = ? AND t.status IN ('sent', 'viewed') AND t.archived_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now())";
// The uuid a JSON text field holds, NULL for any other text: a bare ::uuid cast of other text would fail the whole read, for every send.
const uuidOf = (field) => `CASE WHEN (${field}) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (${field})::uuid END`;
// A call-drafted or new-home estimate is on the customer's own page only while the call-side verdict passes (estimate-claim-sql
// callSideBlockForEstimateData), so every row that verdict reads is hashed too: the call the draft was written from
// (estimate_data.estimatorEngine.callLogId), the leads its linkage step resolves (each lead on that call's sid, and the lead the estimate
// names: the only lead a passing verdict can resolve to) and the move a new-home estimate stands on (estimate_data.move.moveId).
const LINKED_CALL_IDS = `SELECT ${uuidOf("t.estimate_data #>> '{estimatorEngine,callLogId}'")} ${OPEN_ESTIMATES}`;
// The live plan of a customer with an open estimate: the recurring visits not yet finished. The estimate sentences stand on it: member
// pricing reads those rows (the strict member reconcile, waveguard-existing-services), and the pay-for-the-year total is stated only to a
// customer with no live plan (estimate-manual-acceptance customerHasLiveRecurringPlan). A plan that starts, ends or changes refuses the send.
const NOT_LIVE_STATUSES = require('./waveguard-existing-services').TERMINAL_STATUSES.map((status) => `'${status}'`).join(', ');
const LIVE_PLAN_VISITS = `FROM scheduled_services v WHERE v.customer_id = ? AND v.is_recurring IS TRUE AND v.status NOT IN (${NOT_LIVE_STATUSES}) AND EXISTS (SELECT 1 ${OPEN_ESTIMATES})`;
// The customer's tax exemption certificates: the pay-for-the-year total is stated only when the invoice module's dry run adds no tax
// (sms-staff-facts prepayTotalFact, InvoiceService.previewInvoiceTotals), and for an account classed commercial that dry run reads these
// rows (TaxCalculator.findVerifiedExemption). A certificate revoked, expired by an edit or unverified since the recheck refuses the send.
const BILLING_FINGERPRINT_SQL = `SELECT md5(concat_ws('#',
  (SELECT string_agg(md5(t::text), ',' ORDER BY t.id) FROM payments t WHERE t.customer_id = ?),
  (SELECT string_agg(md5(t::text), ',' ORDER BY t.id) FROM invoices t WHERE t.customer_id = ?),
  (SELECT string_agg(md5(a::text), ',' ORDER BY a.id) FROM stripe_invoice_charge_attempts a JOIN invoices i ON i.id = a.invoice_id WHERE i.customer_id = ?),
  (SELECT string_agg(md5(t::text), ',' ORDER BY t.id) FROM payment_plans t WHERE t.customer_id = ?),
  (SELECT string_agg(md5(t::text), ',' ORDER BY t.id) FROM scheduled_services t
   WHERE t.customer_id = ? AND (t.payer_id IS NOT NULL OR t.self_pay_override IS TRUE)),
  (SELECT string_agg(md5(t::text), ',' ORDER BY t.id) FROM scheduled_services t
   WHERE t.customer_id = ? AND (t.prepaid_amount > 0 OR t.annual_prepay_term_id IS NOT NULL OR t.prepaid_method = 'annual_prepay_invoice' OR COALESCE(t.recurring_parent_id, t.id) IN
     (SELECT COALESCE(s.recurring_parent_id, s.id) FROM scheduled_services s WHERE s.customer_id = ? AND (s.prepaid_amount > 0 OR s.annual_prepay_term_id IS NOT NULL OR s.prepaid_method = 'annual_prepay_invoice')))),
  (SELECT string_agg(md5(t::text), ',' ORDER BY t.id) ${OPEN_ESTIMATES}),
  (SELECT string_agg(md5(k::text), ',' ORDER BY k.id) FROM call_log k WHERE k.id IN (${LINKED_CALL_IDS})),
  (SELECT string_agg(md5(l::text), ',' ORDER BY l.id) FROM leads l WHERE l.id IN (
     SELECT s.id FROM call_log k JOIN leads s ON s.twilio_call_sid = k.twilio_call_sid WHERE k.id IN (${LINKED_CALL_IDS})
     UNION SELECT ${uuidOf("t.estimate_data ->> 'lead_id'")} ${OPEN_ESTIMATES})),
  (SELECT string_agg(md5(m::text), ',' ORDER BY m.id) FROM customer_moves m WHERE m.id IN (SELECT ${uuidOf("t.estimate_data #>> '{move,moveId}'")} ${OPEN_ESTIMATES})),
  (SELECT string_agg(md5(v::text), ',' ORDER BY v.id) ${LIVE_PLAN_VISITS}),
  (SELECT string_agg(md5(p::text), ',' ORDER BY p.id) FROM payers p
   WHERE p.id IN (SELECT payer_id FROM customers WHERE id = ? UNION SELECT payer_id FROM scheduled_services WHERE customer_id = ?)),
  (SELECT string_agg(md5(d::text), ',' ORDER BY d.id) FROM estimate_deposits d
   WHERE d.customer_id = ? OR d.estimate_id IN (SELECT id FROM estimates WHERE customer_id = ?)),
  (SELECT md5(c::text) FROM customers c WHERE c.id = ?),
  (SELECT string_agg(md5(t::text), ',' ORDER BY t.id) FROM payment_methods t WHERE t.customer_id = ?),
  (SELECT string_agg(md5(t::text), ',' ORDER BY t.id) FROM annual_prepay_terms t WHERE t.customer_id = ?),
  (SELECT string_agg(md5(x::text), ',' ORDER BY x.id) FROM tax_exemptions x WHERE x.customer_id = ?)
)) AS fingerprint`;

const BILLING_FINGERPRINT_PARAMS = (BILLING_FINGERPRINT_SQL.match(/\?/g) || []).length;

// The fingerprint string, or null when it cannot be read (callers fail closed).
async function billingFingerprint(customerId, dbh = db) {
  if (!customerId) return null;
  try {
    const res = await dbh.raw(BILLING_FINGERPRINT_SQL, Array(BILLING_FINGERPRINT_PARAMS).fill(customerId));
    const row = (res && (res.rows || (Array.isArray(res) ? res : [])))[0];
    // + the ET calendar day (Codex round-59 P2): card expiry / monthly eligibility can flip at ET midnight with no row changing
    return typeof row?.fingerprint === 'string' ? `${row.fingerprint}@${require('../utils/datetime-et').etDateString()}` : null;
  } catch {
    return null;
  }
}

// A repeatable provider-boundary predicate (`dbi` = the handoff's connection):
//   1. ZELLE - when the send-time verdict stood on live Zelle facts (a copied Zelle sentence, or a staff-written Zelle contact), those facts
//      are re-read (the same liveZelleFacts: recipient + the invoice's live eligibility - deposits, PaymentIntents, saved-card charges,
//      credit, payer, siblings) and must be unchanged; a recipient change or an eligibility flip refuses.
//   2. the billing fingerprint, LAST (Codex round-57 P1): the rows the full recheck read are exactly as they were.
// Any change or read failure => retryable refusal (the retry reruns the full recheck).
function billingUnchangedProviderPreSendCheck({ customerId, fingerprint, zelle = null }) {
  const check = async ({ dbi } = {}) => {
    const dbh = dbi || db;
    if (zelle) {
      const live = await require('./sms-amount-recheck').liveZelleFacts({ customerId, invoiceId: zelle.invoiceId || null, dbh });
      if (live.state !== zelle.state || live.recipient !== zelle.recipient || String(live.invoiceNumber || '') !== String(zelle.invoiceNumber || '')) {
        return { ok: false, code: 'ZELLE_CHANGED_AT_BOUNDARY', reason: 'Zelle availability changed since the recheck', retryable: true };
      }
    }
    const now = fingerprint ? await billingFingerprint(customerId, dbh) : null;
    if (!now || now !== fingerprint) {
      return {
        ok: false,
        code: 'BILLING_CHANGED_AT_BOUNDARY',
        reason: now ? 'billing changed since the payment recheck' : 'billing state could not be re-read at send',
        retryable: true,
      };
    }
    return { ok: true };
  };
  check.afterMarker = check;
  return check;
}

module.exports = { billingFingerprint, billingUnchangedProviderPreSendCheck, BILLING_FINGERPRINT_SQL, BILLING_FINGERPRINT_PARAMS };
