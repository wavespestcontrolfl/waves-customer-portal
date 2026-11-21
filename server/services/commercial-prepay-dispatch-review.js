'use strict';

const { createAlert, resolveAlert } = require('./dispatch-alerts');
const { readReceiptState } = require('./commercial-prepay-receipt-proof');

const REVIEW_TYPE = 'commercial_prepay_setup_review';

async function updateReview(conn, context, state) {
  if (state !== 'active' && state !== 'cancelled') return null;
  const current = await conn('dispatch_alerts')
    .where({ type: REVIEW_TYPE })
    .whereRaw("payload->>'sourceInvoiceId' = ? AND payload->>'superseded_at' IS NULL", [
      String(context.sourceInvoiceId),
    ])
    .orderBy('created_at', 'desc')
    .forUpdate()
    .first('id', 'resolved_at', 'payload');
  const paymentRestored = state === 'active';

  // A collected original invoice is the normal starting state, not an alert.
  if (!current && paymentRestored) return null;
  // Replays of the same money state never reopen a dispatcher-acknowledged
  // episode and never create a second open card.
  if (current && Boolean(current.payload?.paymentRestored) === paymentRestored) return current;

  if (current?.resolved_at) {
    // Staff acknowledgement is retained; superseded_at only says a later
    // money episode replaced the conclusion they acknowledged.
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
    payload: paymentRestored ? { ...context, paymentRestored: true } : context,
  });
}

async function reconcileOriginalInvoice(conn, invoiceId) {
  const original = await require('./commercial-prepay-sale-record').findUnbookedSale(conn, invoiceId);
  if (!original) return null;
  const { invoice, estimateId, amount } = original;
  const state = await readReceiptState(conn, invoice);
  await updateReview(conn, {
    sourceInvoiceId: invoice.id,
    customerId: invoice.customer_id,
    estimateId, amount,
  }, state);
  return state;
}

async function reconcileInvoice(conn, invoiceId) {
  if (typeof conn.transaction !== 'function') return reconcileOriginalInvoice(conn, invoiceId);
  try {
    return await conn.transaction((trx) => reconcileOriginalInvoice(trx, invoiceId));
  } catch (err) {
    // A schema without the sale-event table cannot own a recorded setup.
    // The savepoint lets ordinary invoice collection continue in that schema.
    if (err.code === '42P01' && !(await conn.schema.hasTable('audit_log'))) return null;
    throw err;
  }
}

module.exports = {
  REVIEW_TYPE,
  readReceiptState,
  reconcileInvoice,
};
