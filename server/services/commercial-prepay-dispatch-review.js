'use strict';

const { createAlert, resolveAlert } = require('./dispatch-alerts');

const REVIEW_TYPE = 'commercial_prepay_setup_review';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function updateReviewInTransaction(conn, context, state) {
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
  if (current && Boolean(current.payload?.paymentRestored) === paymentRestored) {
    return {
      ...current,
      payload: { ...current.payload, customerId: original.invoice.customer_id },
    };
  }

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

// This is deliberately an observation seam, not a receipt classifier. The
// stacked payment PR may call it only after its own exact receipt proof has
// produced `state`; this service re-verifies the immutable sale identity and
// context, serializes the current card episode, and never infers money state.
// A plain Knex caller is wrapped so verification, supersession and replacement
// are one atomic write. A caller already inside a transaction retains its lock
// order and transaction ownership.
async function updateReview(conn, context, state) {
  if (conn?.isTransaction || typeof conn?.transaction !== 'function') {
    return updateReviewInTransaction(conn, context, state);
  }
  return conn.transaction((trx) => updateReviewInTransaction(trx, context, state));
}

// Persisted episode payloads remain immutable history. At read time, only the
// current (not superseded) episode receives the invoice's live owner so its
// customer link follows an audited merge and a later undo. Superseded episodes
// keep the customer identity that staff saw during that historical episode.
async function hydrateCurrentCustomerLinks(conn, alerts) {
  const rows = Array.isArray(alerts) ? alerts : [];
  const invoiceIds = [...new Set(rows
    .filter((row) => row?.type === REVIEW_TYPE && row.payload?.superseded_at == null)
    .map((row) => String(row.payload?.sourceInvoiceId || ''))
    .filter((id) => UUID_RE.test(id)))];
  if (!invoiceIds.length) return rows;

  const invoices = await conn('invoices').whereIn('id', invoiceIds).select('id', 'customer_id');
  const ownerByInvoice = new Map(invoices.map((invoice) => [String(invoice.id), invoice.customer_id]));
  return rows.map((row) => {
    if (row?.type !== REVIEW_TYPE || row.payload?.superseded_at != null) return row;
    const customerId = ownerByInvoice.get(String(row.payload?.sourceInvoiceId || ''));
    if (!customerId) return row;
    return { ...row, payload: { ...row.payload, customerId } };
  });
}

module.exports = {
  REVIEW_TYPE,
  updateReview,
  hydrateCurrentCustomerLinks,
  _private: { verifiedContextMatches, updateReviewInTransaction },
};
