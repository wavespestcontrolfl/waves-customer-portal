const { validate: isUuid } = require('uuid');

// An off-session authentication decline closes the local claim, but its
// PaymentIntent can still settle. Both checkout and Billing use this predicate.
function whereAwaitingAuthentication(query, table) {
  return query.where({
    [`${table}.status`]: 'failed',
    [`${table}.decline_code`]: 'authentication_required',
  }).whereNotNull(`${table}.resolved_at`).where(function withoutMatchingCancellation() {
    this.whereNull(`${table}.authentication_canceled_intent_id`)
      .orWhereNull(`${table}.stripe_payment_intent_id`)
      .orWhereColumn(`${table}.authentication_canceled_intent_id`, '<>', `${table}.stripe_payment_intent_id`);
  });
}

// Both the signed webhook and the operator's server-side Stripe retrieval
// must identify the same saved-card attempt, invoice, owner and tender.
function matchingSavedCardIntent(intent, database, { lockInvoice = false, settled = false } = {}) {
  const meta = intent.metadata || {};
  if (!intent.id || meta.source !== 'admin_card_on_file') return;
  if (![meta.waves_invoice_id, meta.waves_customer_id, meta.saved_card_attempt_id].every(isUuid)) return;
  const methodId = (typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method?.id)
    || intent.last_payment_error?.payment_method?.id || null;
  const invoice = database('invoices').select('id')
    .where({ id: meta.waves_invoice_id, customer_id: meta.waves_customer_id });
  if (settled) invoice.where({ status: 'paid', stripe_payment_intent_id: intent.id });
  if (lockInvoice) invoice.forShare();
  const query = database('stripe_invoice_charge_attempts')
    .where({ id: meta.saved_card_attempt_id, invoice_id: meta.waves_invoice_id })
    .whereIn('invoice_id', invoice)
    .where(function compatibleIntent() {
      this.whereNull('stripe_payment_intent_id').orWhere('stripe_payment_intent_id', intent.id);
    });
  if (methodId) query.where({ stripe_payment_method_id: methodId });
  return { query, methodId };
}

function matchingCancellation(intent, database, lockInvoice = false) {
  if (intent.status !== 'canceled') return;
  const match = matchingSavedCardIntent(intent, database, { lockInvoice });
  if (!match) return;
  const { query, methodId } = match;
  query.where(function relevantAttempt() {
    this.whereIn('status', ['claimed', 'ambiguous']).orWhere({ status: 'failed', decline_code: 'authentication_required' });
  });
  const evidence = {
    authentication_canceled_intent_id: intent.id,
    ...(methodId ? { stripe_payment_intent_id: intent.id } : {}),
  };
  return { query, evidence };
}

// A webhook can arrive before the worker records the decline. Without a
// method, its candidate clears the hold only if the worker binds the same PI.
async function recordAuthenticationCancellation(intent, database) {
  const match = matchingCancellation(intent, database);
  if (match) await match.query.update(match.evidence);
}

// Run inside the transaction that pays the invoice. A signed success alone
// cannot release a hold when the payment was quarantined or linked elsewhere.
async function recordAuthenticationSettlement(intent, trx) {
  if (intent.status !== 'succeeded') return;
  const match = matchingSavedCardIntent(intent, trx, { settled: true });
  if (!match) return;
  const { query, methodId } = match;
  if (!methodId) query.where({ stripe_payment_intent_id: intent.id });
  await query.where({ status: 'failed', decline_code: 'authentication_required' }).whereNotNull('resolved_at')
    .whereExists(trx('payments').select('id').where({
      customer_id: intent.metadata.waves_customer_id, stripe_payment_intent_id: intent.id, status: 'paid',
    }))
    .update({
      status: 'succeeded', stripe_payment_intent_id: intent.id, decline_code: null, error_message: null,
      resolved_at: trx.fn.now(), updated_at: trx.fn.now(),
    });
}

async function verifySavedCardCancellation({ attemptId, intentId, stripe, database, execute = false }) {
  if (!isUuid(attemptId) || !/^pi_[A-Za-z0-9]+$/.test(intentId || '')) {
    throw new Error('Supply a saved-card attempt UUID and a Stripe PaymentIntent ID.');
  }
  const intent = await stripe.paymentIntents.retrieve(intentId);
  if (intent?.id !== intentId || intent.metadata?.saved_card_attempt_id !== attemptId.toLowerCase()) {
    throw new Error('Stripe did not return the requested PaymentIntent for this saved-card attempt.');
  }
  const match = matchingCancellation(intent, database, execute);
  if (!match) throw new Error('Stripe did not verify a canceled saved-card payment for this invoice.');

  // Historical recovery is for a finished authentication decline only. The
  // UPDATE repeats every identity check, including any intervening binding.
  const { query, evidence } = match;
  query.where({ status: 'failed', decline_code: 'authentication_required' }).whereNotNull('resolved_at')
    .where(function compatibleEvidence() {
      this.whereNull('authentication_canceled_intent_id').orWhere('authentication_canceled_intent_id', intentId);
    });
  if (!evidence.stripe_payment_intent_id) query.where({ stripe_payment_intent_id: intentId });

  const verified = execute ? await query.update(evidence) : await query.first('id');
  if (!verified) throw new Error('The local authentication decline or its payment identity does not match the Stripe cancellation.');
  return { attemptId, intentId, result: execute ? 'cancellation_recorded' : 'cancellation_verified' };
}

module.exports = { whereAwaitingAuthentication, recordAuthenticationCancellation, recordAuthenticationSettlement, verifySavedCardCancellation };
