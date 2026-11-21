const { invoiceDepositCreditCents } = require('./invoice-helpers');

const ACTIVE = new Set(['succeeded', 'pending', 'requires_action']);
const FAILED = new Set(['failed', 'canceled']);
const CARD_TENDERS = new Set(['card', 'card_present', 'credit_card', 'debit_card', 'apple_pay', 'google_pay']);
const SETTLED = new Set(['paid', 'refunded']);

function settledCardRefundsLive() {
  return process.env.GATE_SETTLED_CARD_REFUND_IDS === 'true';
}

function stripeId(value) {
  return typeof value === 'string' ? value : value?.id;
}

function differentStripeIds(first, second) {
  return first && second && stripeId(first) !== stripeId(second);
}

function refundMetadata(payment) {
  const value = payment.metadata;
  if (value == null) return {};
  const meta = typeof value === 'string' ? JSON.parse(value) : value;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('Invalid payment refund metadata');
  return meta;
}

function refundIds(meta, key) {
  const ids = meta[key] ?? [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id)) {
    throw new Error(`Invalid payment ${key}`);
  }
  return ids;
}

function invoicePaidByThisCharge(invoice, row, linkedInvoiceId) {
  if (!invoice) return !linkedInvoiceId;
  return SETTLED.has(invoice.status)
    && (!linkedInvoiceId || linkedInvoiceId === invoice.id)
    && invoice.customer_id === row.customer_id
    && invoice.stripe_charge_id === row.stripe_charge_id
    && !differentStripeIds(invoice.stripe_payment_intent_id, row.stripe_payment_intent_id)
    && Number(invoice.total) === Number(row.amount)
    && [invoice.credit_applied, invoice.amount_paid, invoiceDepositCreditCents(invoice)].every(value => Number(value ?? 0) === 0);
}

// An enrollment is durable so switching off new enrollments cannot change the
// identity of a refund already sent to Stripe. Unknown or mixed tenders never
// enroll. The invoice total still contains credit and hand payments after
// settlement even when the separate balance columns were reset.
async function usesSettledCardRefundLedger(db, row) {
  if (!row || row.processor !== 'stripe' || !row.stripe_charge_id) return false;
  const meta = refundMetadata(row);
  const enrolled = meta.settled_card_refund_ledger === 1;
  if (!enrolled && !settledCardRefundsLive()) return false;
  const excluded = [
    !SETTLED.has(row.status), row.statement_id, meta.statement_id, meta.combined_payment,
    meta.purpose, meta.partial_payment, meta.payment_state === 'processing',
  ].some(Boolean);
  if (excluded) {
    if (enrolled) throw new Error('Settled card refund enrollment conflicts with the payment state');
    return false;
  }
  // Previously confirmed on the locked row, including its sole charge and
  // funding. Subsequent invoice ownership changes cannot change its refund IDs.
  if (enrolled) return true;

  const matchingIdentity = (query) => {
    query.where({ stripe_charge_id: row.stripe_charge_id });
    if (row.stripe_payment_intent_id) query.orWhere({ stripe_payment_intent_id: row.stripe_payment_intent_id });
  };
  const invoices = await db('invoices').where(matchingIdentity).limit(2);
  const invoice = invoices[0];
  if (invoices.length > 1 || !invoicePaidByThisCharge(invoice, row, meta.invoice_id)) return false;
  const saved = row.payment_method_id
    ? await db('payment_methods').where({ id: row.payment_method_id, customer_id: row.customer_id }).first('method_type')
    : null;
  const paymentTenders = [row.payment_method_type, saved?.method_type].filter(Boolean);
  // The invoice's method alone can come from a multi-method PI's first allowed
  // type. Require a payment-method snapshot, card funding or an actual brand.
  const cardEvidence = [paymentTenders.length, row.card_brand, ['credit', 'debit', 'prepaid'].includes(row.card_funding)].some(Boolean);
  const tenders = [...paymentTenders, meta.payment_method, invoice?.payment_method].filter(Boolean);
  if (!cardEvidence || !tenders.every(type => CARD_TENDERS.has(type))) return false;
  const duplicate = await db('payments').where({ stripe_charge_id: row.stripe_charge_id }).whereNot({ id: row.id }).first('id');
  if (duplicate) throw new Error('Multiple payment rows share the settled card charge. Reconcile the charge before refunding.');
  return true;
}

// The newest-first order comes from Stripe. Consume every page before deciding
// which refunds exist, including when reconciling an expired idempotency key.
async function listPaymentRefunds(stripe, selector) {
  const refunds = new Map();
  const params = { ...selector, limit: 100 };
  let cursor;
  do {
    const page = await stripe.refunds.list(cursor ? { ...params, starting_after: cursor } : params);
    if (!Array.isArray(page?.data) || typeof page.has_more !== 'boolean' || (page.has_more && !page.data.length)) {
      throw new Error('Incomplete Stripe refund history');
    }
    for (const item of page.data) {
      if (refunds.size >= 1000 || typeof item?.id !== 'string' || !item.id || refunds.has(item.id) || !Number.isSafeInteger(item.amount) || item.amount <= 0) {
        throw new Error('Invalid or duplicate Stripe refund in history');
      }
      if (!ACTIVE.has(item.status) && !FAILED.has(item.status)) throw new Error(`Unrecognized Stripe status for refund ${item.id}`);
      refunds.set(item.id, item);
    }
    cursor = page.has_more ? page.data[page.data.length - 1].id : null;
  } while (cursor);
  return refunds;
}

async function verifySettledCardCharge(stripe, { chargeId, paymentIntentId, expectedAmountCents }) {
  const id = stripeId(chargeId);
  if (!id) throw new Error('Cannot verify a settled card refund without its original charge');
  const live = await stripe.charges.retrieve(id);
  const capturedCents = live?.amount_captured ?? (live?.captured === true ? live.amount : 0);
  if (live?.id !== id || (paymentIntentId && stripeId(live.payment_intent) !== stripeId(paymentIntentId))
    || live.status !== 'succeeded' || live.paid !== true || live.captured === false
    || !Number.isSafeInteger(capturedCents) || capturedCents <= 0
    || !['card', 'card_present'].includes(live.payment_method_details?.type)) {
    throw new Error('Stripe did not confirm the original charge as a settled card payment');
  }
  if (expectedAmountCents != null && expectedAmountCents !== capturedCents) {
    throw new Error('The captured card amount does not match the payment. Reconcile the charge before refunding.');
  }
  return live;
}

// Two different sets of refunds can have the same total, including after a
// bank failure. Verify the individual IDs and their sum outside the row lock.
async function readSinglePaymentRefunds(stripe, { chargeId, paymentIntentId }) {
  const charge = stripeId(chargeId);
  const pi = stripeId(paymentIntentId);
  if (!charge) throw new Error('Cannot reconcile card refunds without an exact charge');
  const refunds = await listPaymentRefunds(stripe, { charge });
  const activeIds = [];
  let totalCents = 0;
  for (const item of refunds.values()) {
    const itemCharge = stripeId(item.charge);
    const itemPi = stripeId(item.payment_intent);
    if (differentStripeIds(charge, itemCharge) || differentStripeIds(pi, itemPi)) {
      throw new Error('Refund history contains a different Stripe payment');
    }
    if (ACTIVE.has(item.status)) {
      activeIds.push(item.id);
      totalCents += item.amount;
    }
  }
  const live = await verifySettledCardCharge(stripe, { chargeId: charge, paymentIntentId: pi });
  if (live.amount_refunded !== totalCents || typeof live.refunded !== 'boolean') throw new Error('Stripe charge and refund history disagree');
  return { chargeId: charge, paymentIntentId: pi, refunds, activeIds, totalCents, chargeRefunded: live.refunded, capturedCents: live.amount_captured ?? live.amount };
}

// Both creation writers call this under the payment row lock. Only refund.failed
// may remove a stamped refund: it unwinds the money and notifies the office in
// its own transaction. A stale provider read must never undo that decision.
function projectSinglePaymentRefund(payment, snapshot, refundId) {
  const metadata = refundMetadata(payment);
  const failed = new Set(refundIds(metadata, 'failed_refund_ids'));
  if (failed.has(refundId)) return { bounced: true, fenced: true };
  if (differentStripeIds(payment.stripe_charge_id, snapshot.chargeId)
    || differentStripeIds(payment.stripe_payment_intent_id, snapshot.paymentIntentId)) {
    throw new Error('Refund snapshot no longer belongs to this payment');
  }
  const subject = snapshot.refunds.get(refundId);
  if (!subject) throw new Error(`Stripe history does not yet contain refund ${refundId}`);
  if (FAILED.has(subject.status)) return { bounced: true, fenced: false };
  const active = new Set(snapshot.activeIds);
  const stamped = new Set(refundIds(metadata, 'stamped_refund_ids'));
  if (payment.stripe_refund_id) stamped.add(payment.stripe_refund_id);
  for (const id of stamped) {
    if (!active.has(id)) throw new Error(`Stamped refund ${id} is awaiting reconciliation with its bank outcome`);
  }
  for (const id of failed) {
    if (active.has(id)) throw new Error(`Stripe snapshot still includes failed refund ${id}`);
  }
  const paidCents = Math.round(Number(payment.amount) * 100);
  const priorCents = Math.round(Number(payment.refund_amount || 0) * 100);
  if (!Number.isSafeInteger(paidCents) || paidCents <= 0 || snapshot.capturedCents !== paidCents || snapshot.totalCents > paidCents || snapshot.totalCents < priorCents) {
    throw new Error('Stripe refund history does not reconcile with the locked payment balance');
  }
  const isFull = snapshot.totalCents === paidCents;
  if (typeof snapshot.chargeRefunded === 'boolean' && snapshot.chargeRefunded !== isFull) {
    throw new Error('Stripe and the locked payment disagree on whether the charge was fully refunded');
  }
  const nextMetadata = { ...metadata, settled_card_refund_ledger: 1, stamped_refund_ids: [...snapshot.activeIds].reverse() };
  return {
    bounced: false,
    totalCents: snapshot.totalCents,
    isFull,
    latestRefundId: snapshot.activeIds[0],
    refundCents: subject.amount,
    metadata: nextMetadata,
  };
}

// An unexpanded charge event can describe either of two equal-dollar
// refunds. After the older ID's failure committed, the verified active refund
// supplies its own receipt facts independently of that historical event.
function projectAmbiguousCardRefund(payment, snapshot, { liveRefundId, historicalRefundId }) {
  const previous = snapshot.refunds.get(historicalRefundId);
  const receiptRefund = snapshot.refunds.get(liveRefundId);
  const failedIds = refundIds(refundMetadata(payment), 'failed_refund_ids');
  if (!FAILED.has(previous?.status) || !failedIds.includes(historicalRefundId) || !ACTIVE.has(receiptRefund?.status)) {
    throw new Error('The ambiguous refund needs the original bank failure and a verified active replacement');
  }
  const result = projectSinglePaymentRefund(payment, snapshot, liveRefundId);
  if (result.bounced) throw new Error('The replacement refund is already fenced on this payment');
  return { ...result, receiptRefund };
}

module.exports = {
  settledCardRefundsLive, usesSettledCardRefundLedger, verifySettledCardCharge,
  listPaymentRefunds, readSinglePaymentRefunds, projectSinglePaymentRefund, projectAmbiguousCardRefund,
  refundMetadata, refundIds,
};
