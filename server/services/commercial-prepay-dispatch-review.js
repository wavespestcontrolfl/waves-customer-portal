'use strict';

const { createAlert, resolveAlert } = require('./dispatch-alerts');

const REVIEW_TYPE = 'commercial_prepay_setup_review';

function sameNullableId(left, right) {
  if (left == null || left === '') return right == null || right === '';
  return right != null && String(left) === String(right);
}

function verifiedContextMatches(original, context) {
  return original
    && String(original.saleId) === String(context?.saleId || '')
    && String(original.invoice.id) === String(context?.sourceInvoiceId || '')
    && String(original.invoice.customer_id) === String(context?.customerId || '')
    && sameNullableId(original.estimateId, context?.estimateId)
    && Number.isSafeInteger(context?.setupAmountCents)
    && Math.round(Number(original.amount) * 100) === context.setupAmountCents;
}

// This is deliberately an observation seam, not a receipt classifier. The
// stacked payment PR may call it only after its own exact receipt proof has
// produced `state`; this service re-verifies the immutable sale identity and
// context, serializes the current card episode, and never infers money state.
async function updateReview(conn, context, state) {
  if (!['active', 'cancelled'].includes(state)) return null;
  if (!context?.sourceInvoiceId) return null;
  const original = await require('./commercial-prepay-sale-record')
    .findUnbookedSale(conn, context.sourceInvoiceId);
  if (!verifiedContextMatches(original, context)) return null;

  const current = await conn('dispatch_alerts')
    .where({ type: REVIEW_TYPE })
    .whereRaw("payload->>'sourceInvoiceId' = ? AND payload->>'superseded_at' IS NULL", [
      String(context.sourceInvoiceId),
    ])
    .orderBy('created_at', 'desc')
    .forUpdate()
    .first('id', 'resolved_at', 'payload');
  const paymentRestored = state === 'active';

  // Collection is the ordinary starting state. Only a reversal opens the
  // first episode; restoration opens an episode after a returned one exists.
  if (!current && paymentRestored) return null;
  // Same-state replays preserve staff acknowledgement and never duplicate.
  if (current && Boolean(current.payload?.paymentRestored) === paymentRestored) return current;

  if (current?.resolved_at) {
    await conn('dispatch_alerts').where({ id: current.id }).update({
      payload: conn.raw("payload || jsonb_build_object('superseded_at', now())"),
    });
  } else if (current) {
    await resolveAlert({ trx: conn, id: current.id, auto: true });
  }

  return createAlert({
    trx: conn,
    type: REVIEW_TYPE,
    severity: 'warn',
    payload: {
      sourceInvoiceId: original.invoice.id,
      customerId: original.invoice.customer_id,
      estimateId: original.estimateId,
      amount: original.amount,
      ...(paymentRestored ? { paymentRestored: true } : {}),
    },
  });
}

module.exports = {
  REVIEW_TYPE,
  updateReview,
  _private: { verifiedContextMatches },
};
