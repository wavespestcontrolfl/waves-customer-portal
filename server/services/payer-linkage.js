'use strict';
// ONE definition of "this payments row belongs to a third-party PAYER, not the homeowner" — extracted verbatim
// from routes/billing-v2.js (GET /api/billing, Codex #4311 r36 / pre-push P0) so the customer portal history
// and the SMS facts / authoritative payment history can never disagree about whose money a row is.
//
// A payment is payer-linked when ANY linkage the receipt resolution understands ties it to a payer-billed (or
// payer-WITHDRAWN) invoice of the customer:
//   1. metadata.invoice_id, or the legacy aliases metadata.dispute_invoice_id / metadata.waves_invoice_id
//   2. the row's Stripe PaymentIntent id  = the payer invoice's stripe_payment_intent_id
//   3. the row's Stripe charge id         = the payer invoice's stripe_charge_id
//   4. the "Invoice <number> —" description = the payer invoice's invoice_number
// where a "payer invoice" is an invoice with payer_id set OR the packet-withdrawal stamp
// (scheduled_send_error LIKE 'payer_billed:%' — a withdrawn combined-visit invoice keeps payer_id NULL).
const db = require('../models/db');

function metadataOf(p) {
  try {
    return typeof p.metadata === 'string' ? JSON.parse(p.metadata) : p.metadata;
  } catch {
    return null;
  }
}
const invoiceIdOf = (p) => {
  const m = metadataOf(p);
  return m && m.invoice_id != null ? String(m.invoice_id) : null;
};
const aliasInvoiceIdOf = (p) => {
  const m = metadataOf(p);
  const alias = m?.dispute_invoice_id || m?.waves_invoice_id;
  return alias != null ? String(alias) : null;
};
const descriptionInvoiceNumberOf = (p) => {
  const m = /^Invoice\s+([A-Za-z0-9-]+)\s+—/.exec(String(p.description || ''));
  return m ? m[1] : null;
};

// Build the predicate from the customer's payer-owned invoice rows
// ({ id, stripe_payment_intent_id, stripe_charge_id, invoice_number }).
function buildPayerLinkage(payerInvRows, { failed = false } = {}) {
  const payerInvoiceIds = new Set(payerInvRows.map((r) => String(r.id)));
  const payerIntentIds = new Set(payerInvRows.map((r) => r.stripe_payment_intent_id).filter(Boolean));
  const payerChargeIds = new Set(payerInvRows.map((r) => r.stripe_charge_id).filter(Boolean));
  const payerInvoiceNumbers = new Set(payerInvRows.map((r) => r.invoice_number).filter(Boolean));
  const isPayerLinked = (p) => {
    const invId = invoiceIdOf(p) || aliasInvoiceIdOf(p);
    if (invId && payerInvoiceIds.has(invId)) return true;
    if (p.stripe_payment_intent_id && payerIntentIds.has(p.stripe_payment_intent_id)) return true;
    if (p.stripe_charge_id && payerChargeIds.has(p.stripe_charge_id)) return true;
    const num = descriptionInvoiceNumberOf(p);
    return !!(num && payerInvoiceNumbers.has(num));
  };
  return { failed, payerInvRows, payerInvoiceIds, isPayerLinked };
}

// Same query billing-v2 has always run (moved here unchanged). `failed` = the lookup errored: the caller must
// treat payer ownership as UNKNOWN.
async function loadPayerLinkage(customerId, dbh = db) {
  let failed = false;
  const payerInvRows = await dbh('invoices')
    .where({ customer_id: customerId })
    // payer_id OR the withdrawal stamp (Codex #4311 r36 P1): a withdrawn
    // combined-visit invoice keeps payer_id NULL, so an id-only test let
    // its failed attempts and receipts read as the homeowner's own.
    .where(function payerOwned() {
      this.whereNotNull('payer_id').orWhere('scheduled_send_error', 'like', 'payer_billed:%');
    })
    .select('id', 'stripe_payment_intent_id', 'stripe_charge_id', 'invoice_number')
    .catch(() => { failed = true; return []; });
  return buildPayerLinkage(payerInvRows, { failed });
}

// LIVE form (Codex round-41 P1, PR #5331): the stamped linkage above only knows invoices whose payer_id / withdrawal stamp was
// written at creation. An invoice that RESOLVES to a payer today (through its scheduled service or the customer's default) while
// its own payer_id is still NULL is the payer's too, and so is every payment against it. This asks the ONE shared live verdict
// (services/invoice-payer-ownership.liveInvoiceOwnership) for each of the customer's remaining invoices and folds the owned ones
// into the linkage, so authoritative payment history and the in-flight probe judge a payment exactly like the invoice facts do.
// Unverifiable ownership (a lookup / resolver failure) => `failed` (callers fail closed). `liveOwnedIds` = invoice ids the live
// resolver named (payer_id NULL, not stamped), so SQL can drop their payments BEFORE a row cap.
async function loadLivePayerLinkage(customerId, dbh = db) {
  const base = await loadPayerLinkage(customerId, dbh);
  if (base.failed) return { ...base, liveOwnedIds: new Set(), liveOwnedRows: [] };
  let failed = false;
  const rows = await dbh('invoices')
    .where({ customer_id: customerId })
    .whereNull('payer_id')
    .whereNull('payer_statement_id')
    .where(function notWithdrawn() {
      this.whereNull('scheduled_send_error').orWhere('scheduled_send_error', 'not like', 'payer_billed:%');
    })
    .select('id', 'customer_id', 'scheduled_service_id', 'stripe_payment_intent_id', 'stripe_charge_id', 'invoice_number')
    .catch(() => { failed = true; return []; });
  if (failed) return { ...base, failed: true, liveOwnedIds: new Set(), liveOwnedRows: [] };
  let verdict;
  try {
    verdict = await require('./invoice-payer-ownership').liveInvoiceOwnership(customerId, rows, dbh);
  } catch {
    return { ...base, failed: true, liveOwnedIds: new Set(), liveOwnedRows: [] };
  }
  if (verdict.unverifiable) return { ...base, failed: true, liveOwnedIds: new Set(), liveOwnedRows: [] };
  const liveOwned = rows.filter((r) => verdict.ownedIds.has(String(r.id)));
  const linkage = buildPayerLinkage([...base.payerInvRows, ...liveOwned]);
  return { ...linkage, liveOwnedIds: verdict.ownedIds, liveOwnedRows: liveOwned };
}

module.exports = {
  invoiceIdOf, aliasInvoiceIdOf, descriptionInvoiceNumberOf, buildPayerLinkage, loadPayerLinkage, loadLivePayerLinkage,
};
