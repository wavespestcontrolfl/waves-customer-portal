'use strict';
// "Has anything in this customer's billing changed since the full recheck?" (Codex round-48/49 P1, PR #5331.)
//
// A billing reply (an amount, a payment-status sentence, a Zelle offer or denial) is fully rechecked before provider entry - the
// context aggregator, the renderer, the Zelle eligibility reads - but each send path still awaits more steps (link / claim / consent
// / policy, the re-service handoff) before Twilio. Repeating the full recheck at the provider boundary would need a second pool
// connection while the handoff holds one (a pool of 2 can deadlock). Instead the fingerprint of every row the recheck reads is taken
// BEFORE that recheck, and re-read at the boundary in ONE query on the handoff's own connection: any change in between (a payment
// landing, an invoice settling or being withdrawn, a plan, a payer assignment) refuses the send as RETRYABLE - the retry reruns the
// full recheck on the new state. Content-based (md5 of the rows), so a write that does not bump updated_at still counts.
const db = require('../models/db');

const BILLING_FINGERPRINT_SQL = `SELECT md5(concat_ws('#',
  (SELECT string_agg(concat_ws('|', id, status, amount, refund_status, refund_amount, payer_id, stripe_payment_intent_id,
     superseded_by_payment_id, payment_date, md5(COALESCE(metadata::text, ''))), ',' ORDER BY id)
   FROM payments WHERE customer_id = ?),
  (SELECT string_agg(concat_ws('|', id, status, total, credit_applied, payer_id, payer_statement_id, scheduled_send_error, due_date),
     ',' ORDER BY id)
   FROM invoices WHERE customer_id = ?),
  (SELECT string_agg(concat_ws('|', id, status), ',' ORDER BY id) FROM payment_plans WHERE customer_id = ?),
  (SELECT string_agg(concat_ws('|', id, payer_id), ',' ORDER BY id) FROM scheduled_services WHERE customer_id = ? AND payer_id IS NOT NULL),
  (SELECT concat_ws('|', 'c', payer_id) FROM customers WHERE id = ?)
)) AS fingerprint`;

// The fingerprint string, or null when it cannot be read (callers fail closed).
async function billingFingerprint(customerId, dbh = db) {
  if (!customerId) return null;
  try {
    const res = await dbh.raw(BILLING_FINGERPRINT_SQL, [customerId, customerId, customerId, customerId, customerId]);
    const row = (res && (res.rows || (Array.isArray(res) ? res : [])))[0];
    return typeof row?.fingerprint === 'string' ? row.fingerprint : null;
  } catch {
    return null;
  }
}

// A repeatable provider-boundary predicate: the billing rows are still exactly as they were when `fingerprint` was taken (before the
// full recheck). `dbi` = the handoff's connection (one query, no second pool slot). Any change or read failure => retryable refusal.
function billingUnchangedProviderPreSendCheck({ customerId, fingerprint }) {
  const check = async ({ dbi } = {}) => {
    const now = fingerprint ? await billingFingerprint(customerId, dbi || db) : null;
    if (now && now === fingerprint) return { ok: true };
    return {
      ok: false,
      code: 'BILLING_CHANGED_AT_BOUNDARY',
      reason: now ? 'billing changed since the payment recheck' : 'billing state could not be re-read at send',
      retryable: true,
    };
  };
  check.afterMarker = check;
  return check;
}

module.exports = { billingFingerprint, billingUnchangedProviderPreSendCheck, BILLING_FINGERPRINT_SQL };
