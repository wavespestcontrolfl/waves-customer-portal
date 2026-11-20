'use strict';

const { createAlert, resolveAlert } = require('./dispatch-alerts');
const { readReceiptState } = require('./commercial-prepay-receipt-proof');

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

async function writeEpisode(conn, original, state) {
  const current = await conn('dispatch_alerts')
    .where({ type: REVIEW_TYPE })
    .whereRaw("payload->>'sourceInvoiceId' = ? AND payload->>'superseded_at' IS NULL", [
      String(original.invoice.id),
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

// Collect, refund and dispute writers serialize on the invoice. Read receipt
// evidence only after taking that same lock, and hold it through the card write.
async function updateReview(conn, invoiceId, observe) {
  if (!invoiceId || typeof observe !== 'function') return null;
  async function readAndWrite(trx) {
    const original = await require('./commercial-prepay-sale-record').findUnbookedSale(trx, invoiceId, { lockInvoice: true });
    if (!original) return null;
    const observation = await observe(trx, original);
    if (!verifiedContextMatches(original, observation?.context)) return null;
    const { state } = observation;
    const alert = ['active', 'cancelled'].includes(state) ? await writeEpisode(trx, original, state) : null;
    return { state, alert };
  }
  return conn.isTransaction ? readAndWrite(conn) : conn.transaction(readAndWrite);
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
  const { verifiedCustomerLinks } = require('./commercial-prepay-sale-record');
  const ownerByInvoice = invoiceIds.length ? await verifiedCustomerLinks(conn, invoiceIds) : new Map();
  return rows.map((row) => {
    if (row?.type !== REVIEW_TYPE || row.payload?.superseded_at != null) return row;
    const customerId = ownerByInvoice.get(String(row.payload?.sourceInvoiceId || '')) || null;
    return { ...row, payload: { ...row.payload, customerId } };
  });
}

async function reconcileOriginalInvoice(conn, invoiceId) {
  // An ordinary invoice has no sale receipt and needs no Dispatch locks.
  if (!await require('./commercial-prepay-sale-record').hasRecordedUnbookedSale(conn, invoiceId)) return null;
  const observation = await updateReview(conn, invoiceId, async (trx, sale) => ({
    context: sale.reviewContext,
    state: await readReceiptState(trx, sale.invoice),
  }));
  return observation?.state ?? null;
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
  reconcileInvoice,
  readReceiptState,
  REVIEW_TYPE,
  updateReview,
  hydrateCurrentCustomerLinks,
};
