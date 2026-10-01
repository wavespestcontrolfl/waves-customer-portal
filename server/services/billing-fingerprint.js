'use strict';
// "Has anything in this customer's billing changed since the full recheck?" (Codex round-48/49 P1, PR #5331.)
//
// A billing reply (an amount, a payment-status sentence, a Zelle offer or denial) is fully rechecked before provider entry - the
// context aggregator, the renderer, the Zelle eligibility reads - but each send path still awaits more steps (link / claim / consent
// / policy, the re-service handoff) before Twilio. Repeating the full recheck at the provider boundary would need a second pool
// connection while the handoff holds one (a pool of 2 can deadlock). Instead the fingerprint of every row the recheck reads is taken
// BEFORE that recheck, and re-read at the boundary in ONE query on the handoff's own connection: any change in between (a payment
// landing, an invoice settling or being withdrawn, a plan, a payer assignment, account credit that would cover it, the dues authority:
// billing mode / rate / tier, the saved methods a surcharge is computed from, annual-prepay terms) refuses the send as RETRYABLE - the retry reruns the
// full recheck on the new state. Content-based (md5 of the rows), so a write that does not bump updated_at still counts.
const db = require('../models/db');

const BILLING_FINGERPRINT_SQL = `SELECT md5(concat_ws('#',
  (SELECT string_agg(concat_ws('|', id, status, amount, refund_status, refund_amount, payer_id, stripe_payment_intent_id, retry_count, next_retry_at,
     superseded_by_payment_id, payment_date, md5(COALESCE(metadata::text, ''))), ',' ORDER BY id)
   FROM payments WHERE customer_id = ?),
  (SELECT string_agg(concat_ws('|', id, status, total, credit_applied, payer_id, payer_statement_id, scheduled_send_error, due_date,
     stripe_payment_intent_id), ',' ORDER BY id)
   FROM invoices WHERE customer_id = ?),
  (SELECT string_agg(concat_ws('|', a.id, a.status, a.stripe_payment_intent_id, a.resolved_at), ',' ORDER BY a.id)
   FROM stripe_invoice_charge_attempts a JOIN invoices i ON i.id = a.invoice_id WHERE i.customer_id = ?),
  (SELECT string_agg(concat_ws('|', id, status), ',' ORDER BY id) FROM payment_plans WHERE customer_id = ?),
  (SELECT string_agg(concat_ws('|', id, payer_id, self_pay_override), ',' ORDER BY id) FROM scheduled_services
   WHERE customer_id = ? AND (payer_id IS NOT NULL OR self_pay_override IS TRUE)),
  (SELECT string_agg(concat_ws('|', p.id, p.active), ',' ORDER BY p.id) FROM payers p
   WHERE p.id IN (SELECT payer_id FROM customers WHERE id = ? UNION SELECT payer_id FROM scheduled_services WHERE customer_id = ?)),
  (SELECT string_agg(concat_ws('|', d.id, d.status, d.credited_amount, d.refunded_amount), ',' ORDER BY d.id) FROM estimate_deposits d
   WHERE d.customer_id = ? OR d.estimate_id IN (SELECT id FROM estimates WHERE customer_id = ?)),
  (SELECT concat_ws('|', 'c', payer_id, account_credits, auto_apply_account_credit, billing_mode, monthly_rate, waveguard_tier,
     autopay_enabled, autopay_payment_method_id) FROM customers WHERE id = ?),
  (SELECT string_agg(concat_ws('|', id, processor, is_default, autopay_enabled, method_type, card_funding, stripe_payment_method_id), ',' ORDER BY id)
   FROM payment_methods WHERE customer_id = ?),
  (SELECT string_agg(concat_ws('|', id, status, term_start, term_end, monthly_rate), ',' ORDER BY id) FROM annual_prepay_terms WHERE customer_id = ?)
)) AS fingerprint`;

const BILLING_FINGERPRINT_PARAMS = (BILLING_FINGERPRINT_SQL.match(/\?/g) || []).length;

// The fingerprint string, or null when it cannot be read (callers fail closed).
async function billingFingerprint(customerId, dbh = db) {
  if (!customerId) return null;
  try {
    const res = await dbh.raw(BILLING_FINGERPRINT_SQL, Array(BILLING_FINGERPRINT_PARAMS).fill(customerId));
    const row = (res && (res.rows || (Array.isArray(res) ? res : [])))[0];
    return typeof row?.fingerprint === 'string' ? row.fingerprint : null;
  } catch {
    return null;
  }
}

// A repeatable provider-boundary predicate: the billing rows are still exactly as they were when `fingerprint` was taken (before the
// full recheck). `dbi` = the handoff's connection. Any change or read failure => retryable refusal.
// ZELLE (owner ruling 2026-10-01, "rerun full check"): a Zelle offer or denial also depends on state no hashed row records (the
// recipient env, a PaymentIntent, a deposit, payer activation, ...). Rather than a hand-kept dependency list, the boundary reruns the
// SAME checks the full recheck ran: the recipient (outgoingZelleStale) and the invoice's live eligibility (zelleInvoiceStillEligible) for
// the invoice the recheck resolved. Parts of that read go through the pool (a second connection for a moment, the cron-lock pattern).
function billingUnchangedProviderPreSendCheck({ customerId, fingerprint, zelleInvoiceId = null, zelleDenial = null, getBody = null }) {
  const check = async ({ dbi } = {}) => {
    const dbh = dbi || db;
    const now = fingerprint ? await billingFingerprint(customerId, dbh) : null;
    if (!now || now !== fingerprint) {
      return {
        ok: false,
        code: 'BILLING_CHANGED_AT_BOUNDARY',
        reason: now ? 'billing changed since the payment recheck' : 'billing state could not be re-read at send',
        retryable: true,
      };
    }
    const body = String((typeof getBody === 'function' ? getBody() : getBody) || '');
    const recheck = require('./sms-amount-recheck');
    if (recheck.hasAffirmativeZelleMention(body)) {
      const offer = await zelleOfferStillEligible({ recheck, customerId, zelleInvoiceId, body, dbh });
      if (!offer.ok) return offer;
    }
    if (zelleDenial && recheck.hasNegativeZelleAvailabilityClaim(body)) {
      // a recipient configured (or removed) since the recheck changes every denial's premise (Codex round-53 P2)
      const configured = !!require('../routes/pay-v2-helpers').manualPayOptionsFromEnv()?.zelle?.recipient;
      if (configured !== (zelleDenial.recipientConfigured !== false)) {
        return { ok: false, code: 'ZELLE_DENIAL_UNSENDABLE_AT_BOUNDARY', reason: 'Zelle setup changed since the recheck', retryable: true };
      }
    }
    if (zelleDenial?.invoiceId && recheck.hasNegativeZelleAvailabilityClaim(body)) {
      return zelleDenialStillStands({ recheck, customerId, invoiceId: zelleDenial.invoiceId, dbh });
    }
    return { ok: true };
  };
  check.afterMarker = check;
  return check;
}

async function zelleOfferStillEligible({ recheck, customerId, zelleInvoiceId, body, dbh }) {
  const recipient = recheck.outgoingZelleStale(body);
  if (recipient.stale) return { ok: false, code: 'ZELLE_OFFER_UNSENDABLE_AT_BOUNDARY', reason: `the Zelle offer is no longer valid (${recipient.reason})` };
  const eligibility = await recheck.zelleInvoiceStillEligible({ customerId, zelleInvoiceId, dbh });
  return eligibility.eligible
    ? { ok: true }
    : { ok: false, code: 'ZELLE_OFFER_UNSENDABLE_AT_BOUNDARY', reason: `the Zelle offer is no longer valid (${eligibility.reason})`, retryable: true };
}

// A scoped denial stands only while its invoice is still confirmed ineligible (same rule as the full recheck's zelleDenialVerdict).
async function zelleDenialStillStands({ recheck, customerId, invoiceId, dbh }) {
  const eligibility = await recheck.zelleInvoiceStillEligible({ customerId, zelleInvoiceId: invoiceId, dbh });
  if (eligibility.eligible) return { ok: false, code: 'ZELLE_DENIAL_UNSENDABLE_AT_BOUNDARY', reason: 'Zelle became available for the invoice', retryable: true };
  if (recheck.ZELLE_DENIAL_UNVERIFIABLE.has(eligibility.reason)) {
    return { ok: false, code: 'ZELLE_DENIAL_UNSENDABLE_AT_BOUNDARY', reason: `Zelle availability could not be confirmed (${eligibility.reason})`, retryable: true };
  }
  return { ok: true };
}

module.exports = { billingFingerprint, billingUnchangedProviderPreSendCheck, BILLING_FINGERPRINT_SQL, BILLING_FINGERPRINT_PARAMS };
