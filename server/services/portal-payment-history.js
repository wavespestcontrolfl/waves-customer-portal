// The portal's payment history: the customer-visible payments, newest first,
// with their receipt links. One read for every surface that shows a customer
// their own payments (GET /api/billing and the portal assistant's payment
// card), so the third-party-payer exclusions, hold-deferral placeholders and
// receipt rules below can never differ between them.
const db = require('../models/db');
const { excludeHoldDeferralPlaceholders } = require('./collections/collection-hold');
const StripeService = require('./stripe');
const logger = require('./logger');
const { loadPayerLinkage, invoiceIdOf, aliasInvoiceIdOf, descriptionInvoiceNumberOf } = require('./payer-linkage');

// Receipt links per payment row. Two sources, in preference order:
//   1. The Waves receipt — invoice.token drives the permanent
//      /receipt/:token page + its PDF (receipt-v2). Only for invoices the
//      PDF route will actually serve (paid/refunded), so the portal never
//      offers a download that 409s.
//   2. Stripe's hosted receipt — recurring autopay rows carry no
//      invoice_id but do stamp metadata.stripe_receipt_url (the same link
//      the payment-success SMS/email uses). View-only, no PDF.
// Customer-scoped lookup: a token is only ever returned for an invoice
// belonging to the requesting customer.
const stripeReceiptOf = (p) => {
  try {
    const m = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata;
    return m?.stripe_receipt_url || p.receipt_url || null;
  } catch { return p.receipt_url || null; }
};
// Invoice resolution mirrors the canonical webhook resolver
// (stripe-webhook.js): metadata.invoice_id, then the dispute/legacy
// aliases, then the payment's Stripe PaymentIntent matched against
// invoices.stripe_payment_intent_id — the last one is what rescues
// self-pay cash/check/Zelle rows, which admin-invoices.js writes with no
// metadata at all and which would otherwise show no Waves receipt.
const anyInvoiceIdOf = (p) => invoiceIdOf(p) || aliasInvoiceIdOf(p);
// Manual self-pay rows (cash/check/Zelle) are written with NEITHER
// metadata nor a PaymentIntent — admin-invoices.js only stamps metadata
// for payer-billed or credit-applied invoices. Their description is
// deterministic though: `Invoice <number> — <method>`, so the invoice
// number is the only link back and the receipt would otherwise never
// appear on a cash/check payment (codex r2 P1).
const invoiceNumberOf = descriptionInvoiceNumberOf;

// The Waves receipt (token) for each visible payment's invoice, indexed by
// every linkage a payment row can carry.
async function receiptIndexFor(customerId, visiblePayments, database = db) {
  // Same UUID shape-filter the balance path already applies below: historic
  // rows can carry a non-UUID metadata.invoice_id, and invoices.id is a uuid
  // column — an unfiltered whereIn makes Postgres throw on the cast, and the
  // catch would then leave EVERY receipt link null (codex r3 P2).
  const RECEIPT_UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const invoiceIds = [...new Set(visiblePayments.map(anyInvoiceIdOf).filter(Boolean))]
    .filter((id) => RECEIPT_UUID_SHAPE.test(id));
  const intentIds = [...new Set(visiblePayments.map(p => p.stripe_payment_intent_id).filter(Boolean))];
  // Historical reconciled rows can be bound to their invoice ONLY through
  // payments.stripe_charge_id ↔ invoices.stripe_charge_id — the canonical
  // webhook resolver and receipt-v2's payment lookup both honor it, so the
  // billing history must too or those rows show a Stripe link (or nothing)
  // instead of the permanent Waves receipt (codex r7 P1).
  const chargeIds = [...new Set(visiblePayments.map(p => p.stripe_charge_id).filter(Boolean))];
  const invoiceNumbers = [...new Set(visiblePayments.map(invoiceNumberOf).filter(Boolean))];
  const receiptTokenByInvoiceId = new Map();
  const receiptTokenByIntentId = new Map();
  const receiptTokenByChargeId = new Map();
  const receiptTokenByNumber = new Map();
  if (invoiceIds.length || intentIds.length || chargeIds.length || invoiceNumbers.length) {
    try {
      const invoiceRows = await database('invoices')
        .where({ customer_id: customerId })
        // A payer-billed invoice still hangs off the homeowner's customer
        // row, and its receipt is a PERMANENT bearer token exposing the AP
        // payer's billing identity. The payment-history payer filter above
        // only catches rows linked by metadata.invoice_id, so the alias /
        // PaymentIntent / invoice-number paths added here would slip past
        // it — exclude payer-billed invoices outright (pre-push P0).
        .whereNull('payer_id')
        .whereIn('status', ['paid', 'refunded'])
        .where((qb) => {
          if (invoiceIds.length) qb.orWhereIn('id', invoiceIds);
          if (intentIds.length) qb.orWhereIn('stripe_payment_intent_id', intentIds);
          if (chargeIds.length) qb.orWhereIn('stripe_charge_id', chargeIds);
          if (invoiceNumbers.length) qb.orWhereIn('invoice_number', invoiceNumbers);
        })
        .select('id', 'token', 'invoice_number', 'stripe_payment_intent_id', 'stripe_charge_id');
      invoiceRows.forEach((row) => {
        if (!row.token) return;
        const entry = { token: row.token, invoiceNumber: row.invoice_number };
        receiptTokenByInvoiceId.set(row.id, entry);
        if (row.stripe_payment_intent_id) receiptTokenByIntentId.set(row.stripe_payment_intent_id, entry);
        if (row.stripe_charge_id) receiptTokenByChargeId.set(row.stripe_charge_id, entry);
        if (row.invoice_number) receiptTokenByNumber.set(row.invoice_number, entry);
      });
    } catch (err) {
      // Best-effort: a receipt-link lookup failure must not break the
      // payment history itself.
      logger.warn(`[billing] receipt token lookup failed for customer ${customerId}: ${err.message}`);
    }
  }
  return { receiptTokenByInvoiceId, receiptTokenByIntentId, receiptTokenByChargeId, receiptTokenByNumber };
}

async function listPortalPayments(customerId, {
  limit: requestedLimit = 50,
  cursor: requestedCursor = 0,
  database = db,
} = {}) {
  const service = await StripeService;

  // Third-party Bill-To: a payment against a payer-billed invoice belongs to
  // the payer (AP contact), not the homeowner — drop those rows so the
  // logged-in customer never sees the payer's card brand / last4 / Stripe
  // PaymentIntent id in their own history. Over-fetch first so excluding those
  // rows still returns up to `requestedLimit` customer-visible payments (the
  // exclusion can't be a SQL filter without casting arbitrary payment metadata
  // to jsonb table-wide). Payer payments are a small minority, so a padded
  // buffer fills the page in realistic cases.
  // ONE shared payer predicate (services/payer-linkage.js, also used by the SMS payment facts): every linkage the receipt
  // resolution below understands, the payer_billed withdrawal stamp, statement-accrued children, and the direct ledger stamps
  // (payments.payer_id / metadata.payer_id).
  const { failed: payerLookupFailed, payerInvoiceIds, isPayerLinked } = await loadPayerLinkage(customerId, database);
  // `total` counts exactly the rows pagination will serve: the same
  // hold-deferral exclusion and the same payer predicate. The direct payer
  // stamps (payments.payer_id, metadata.payer_id) are SQL, so the common
  // case (no payer invoice on file) stays one COUNT(*) per page; only an
  // account with payer invoices scans its rows for the invoice-linked ones.
  const notDirectlyPayerOwned = (q) => q
    .whereNull('payments.payer_id')
    .whereRaw("COALESCE(payments.metadata->>'payer_id', '') = ''");
  let total;
  if (payerInvoiceIds.size === 0) {
    const countRow = await notDirectlyPayerOwned(excludeHoldDeferralPlaceholders(database('payments')
      .where({ customer_id: customerId }), 'payments'))
      .count('* as count')
      .first();
    total = Number(countRow?.count || 0);
  } else {
    const rows = await notDirectlyPayerOwned(excludeHoldDeferralPlaceholders(database('payments')
      .where({ customer_id: customerId }), 'payments'))
      .select('metadata', 'stripe_payment_intent_id', 'stripe_charge_id', 'description', 'payer_id');
    total = rows.reduce((count, payment) => count + (isPayerLinked(payment) ? 0 : 1), 0);
  }

  // `cursor` is the raw payment-history offset. Scan bounded chunks so a
  // page still contains up to `limit` customer-visible rows when third-party
  // payer rows are interspersed. The cursor points at (not beyond) the first
  // visible look-ahead row, so no payment is lost between pages.
  const visiblePayments = [];
  const batchSize = 100;
  let rawCursor = requestedCursor;
  let nextCursor = null;
  let exhausted = false;
  for (let scan = 0; scan < 10 && !exhausted && nextCursor == null; scan += 1) {
    const batch = await service.getPaymentHistory(customerId, batchSize, rawCursor, database);
    if (!batch.length) {
      exhausted = true;
      break;
    }
    for (let index = 0; index < batch.length; index += 1) {
      const payment = batch[index];
      if (isPayerLinked(payment)) continue;
      if (visiblePayments.length < requestedLimit) visiblePayments.push(payment);
      else {
        nextCursor = rawCursor + index;
        break;
      }
    }
    if (nextCursor != null) break;
    rawCursor += batch.length;
    if (batch.length < batchSize) exhausted = true;
  }
  if (nextCursor == null && !exhausted) {
    // The bounded scan may encounter an unusually long run of payer-only
    // rows. Continue from the raw position on the next request rather than
    // scanning without limit or claiming the history is complete.
    nextCursor = rawCursor;
  }

  // Recurring = the monthly WaveGuard plan obligation. Metadata-first, same
  // rule as billing-cron's dedupe: every monthly-autopay row (chargeMonthly,
  // retry rungs, admin charge-now) carries a metadata.billed_month stamp.
  // The canonical "<tier> WaveGuard Monthly" description marker stays as the
  // legacy fallback for rows written before the stamp existed. Description
  // wording alone (e.g. a row that merely says "Monthly") is NOT a signal.
  const isRecurringPayment = (p) => {
    try {
      const m = typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata;
      if (m && m.billed_month) return true;
    } catch { /* unparseable metadata — fall through to the marker */ }
    return (p.description || '').includes('WaveGuard Monthly');
  };

  const { receiptTokenByInvoiceId, receiptTokenByIntentId, receiptTokenByChargeId, receiptTokenByNumber } = await receiptIndexFor(customerId, visiblePayments, database);

  return {
    payments: visiblePayments.map(p => ({
      id: p.id,
      date: p.payment_date,
      amount: parseFloat(p.amount),
      status: p.status,
      description: p.description,
      // The client's Recurring/One-Time filter and YTD split read this —
      // it was previously never serialized (always $0.00).
      type: isRecurringPayment(p) ? 'recurring' : 'one_time',
      cardBrand: p.card_brand,
      lastFour: p.last_four,
      processor: 'stripe',
      methodType: p.method_type || 'card',
      bankName: p.bank_name || null,
      stripePaymentIntentId: p.stripe_payment_intent_id || null,
      refundAmount: p.refund_amount ? parseFloat(p.refund_amount) : null,
      refundStatus: p.refund_status || null,
      // Receipt surfaces (see the resolution block above). All three are
      // null when this payment has no retrievable receipt — the row simply
      // renders no receipt action.
      ...(() => {
        // A FAILED attempt can carry the same metadata.invoice_id as the
        // retry that later succeeded (stripe.js persists failed saved-card
        // attempts with it). Attaching the invoice receipt to that row would
        // show a receipt beside a FAILED badge for money this row never
        // took — only settled rows get one (codex r2 P1).
        // Fail closed: if payer ownership couldn't be resolved we cannot
        // prove this row is self-pay, so no receipt link is emitted.
        const settled = !payerLookupFailed
          && ['paid', 'processing', 'refunded'].includes(String(p.status || '').toLowerCase());
        const inv = !settled ? null : (
          receiptTokenByInvoiceId.get(anyInvoiceIdOf(p))
          || (p.stripe_payment_intent_id ? receiptTokenByIntentId.get(p.stripe_payment_intent_id) : null)
          || (p.stripe_charge_id ? receiptTokenByChargeId.get(p.stripe_charge_id) : null)
          || receiptTokenByNumber.get(invoiceNumberOf(p))
        );
        const stripeReceiptUrl = stripeReceiptOf(p);
        return {
          receiptUrl: inv ? `/receipt/${inv.token}` : null,
          receiptPdfUrl: inv ? `/api/receipt/${inv.token}/pdf` : null,
          receiptNumber: inv?.invoiceNumber || null,
          stripeReceiptUrl: (inv || !settled) ? null : stripeReceiptUrl,
        };
      })(),
    })),
    total,
    limit: requestedLimit,
    cursor: requestedCursor,
    hasMore: nextCursor != null,
    nextCursor,
    // True when third-party-payer ownership could not be read: the rows
    // above may then include a payer's payments. The Billing tab keeps its
    // prior behavior (receipt links withheld); a consumer that would show
    // the figures elsewhere must show nothing.
    payerLookupFailed,
  };
}

module.exports = { listPortalPayments };
