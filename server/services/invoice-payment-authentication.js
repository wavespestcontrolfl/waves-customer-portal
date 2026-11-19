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

// Called only with a verified payment_intent.canceled webhook. The same
// cancellation may arrive before the saved-card worker records the decline.
// Store its identity on the attempt without changing the claim's lifecycle.
async function recordAuthenticationCancellation(intent, database) {
  const meta = intent.metadata || {};
  if (intent.status !== 'canceled' || !intent.id || meta.source !== 'admin_card_on_file') return;
  const uuid = require('uuid').validate;
  if (![meta.waves_invoice_id, meta.waves_customer_id, meta.saved_card_attempt_id].every(uuid)) return;
  const methodId = (typeof intent.payment_method === 'string' ? intent.payment_method : intent.payment_method?.id)
    || intent.last_payment_error?.payment_method?.id || null;
  const query = database('stripe_invoice_charge_attempts')
    .where({ id: meta.saved_card_attempt_id, invoice_id: meta.waves_invoice_id })
    .whereIn('invoice_id', database('invoices').select('id')
      .where({ id: meta.waves_invoice_id, customer_id: meta.waves_customer_id }))
    .where(function relevantAttempt() {
      this.whereIn('status', ['claimed', 'ambiguous']).orWhere({ status: 'failed', decline_code: 'authentication_required' });
    })
    .where(function compatibleIntent() {
      this.whereNull('stripe_payment_intent_id').orWhere('stripe_payment_intent_id', intent.id);
    });
  if (methodId) query.where({ stripe_payment_method_id: methodId });
  // With no method on the event, retain its PI id as a candidate. It clears
  // the hold only once the saved-card worker independently names that PI.
  await query.update({
    authentication_canceled_intent_id: intent.id,
    ...(methodId ? { stripe_payment_intent_id: intent.id } : {}),
  });
}

module.exports = { whereAwaitingAuthentication, recordAuthenticationCancellation };
