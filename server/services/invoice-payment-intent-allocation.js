// Lock the target plus every collectible sibling that any supplied PaymentIntent
// can mutate, in the ascending invoice-id order used by combined checkout.
// The stable-owner advisory lock freezes combined allocation changes before
// the set is selected, so cancel + sibling-stamp cleanup cannot deadlock after
// Stripe has already accepted the cancellation.
async function lockInvoicePaymentIntentAllocation(trx, {
  id,
  piId,
  additionalPiIds = [],
  customerId,
  combinedCustomerLocked = false,
  targetForUpdate = false,
}) {
  const paymentIntentIds = [...new Set(
    [piId, ...additionalPiIds].filter(Boolean).map(String),
  )];
  if (!paymentIntentIds.length) {
    const target = trx('invoices').where({ id });
    return (targetForUpdate ? target.forUpdate() : target.forNoKeyUpdate()).first();
  }
  const PayCombined = require('./pay-combined');
  if (!combinedCustomerLocked) {
    await PayCombined.lockCombinedCustomerStable(trx, id, customerId);
  }
  const piPlaceholders = paymentIntentIds.map(() => '?').join(', ');
  const rows = await trx('invoices')
    .whereRaw(
      `id = ? OR (stripe_payment_intent_id IN (${piPlaceholders}) AND status NOT IN (?, ?, ?))`,
      [id, ...paymentIntentIds, 'paid', 'processing', 'prepaid'],
    )
    .orderBy('id', 'asc')
    .forUpdate();
  return rows.find((row) => String(row.id) === String(id)) || null;
}

module.exports = { lockInvoicePaymentIntentAllocation };
