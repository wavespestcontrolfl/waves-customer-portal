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
    // A row the ledger stamps as the payer's directly (payments.payer_id, or metadata.payer_id on statement refunds and
    // disputes) is the payer's whatever it links to.
    if (p.payer_id != null || metadataOf(p)?.payer_id != null) return true;
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
async function loadPayerLinkage(customerId, dbh = db, { propagateCancellation = false } = {}) {
  let failed = false;
  const payerInvRows = await dbh('invoices')
    .where({ customer_id: customerId })
    // payer_id OR the withdrawal stamp (Codex #4311 r36 P1): a withdrawn
    // combined-visit invoice keeps payer_id NULL, so an id-only test let
    // its failed attempts and receipts read as the homeowner's own.
    .where(function payerOwned() {
      // Codex round-51 P2: a statement-accrued child (payer_statement_id, payer_id NULL) is the payer's too
      this.whereNotNull('payer_id').orWhereNotNull('payer_statement_id').orWhere('scheduled_send_error', 'like', 'payer_billed:%');
    })
    .select('id', 'stripe_payment_intent_id', 'stripe_charge_id', 'invoice_number')
    .catch((err) => {
      if (propagateCancellation && (['PORTAL_CHAT_DEADLINE', 'ABORT_ERR', '57014'].includes(err?.code)
        || ['AbortError', 'KnexTimeoutError'].includes(err?.name))) throw err;
      failed = true;
      return [];
    });
  return buildPayerLinkage(payerInvRows, { failed });
}

// LIVE form (Codex round-41 P1, PR #5331): the stamped linkage above only knows invoices whose payer_id / withdrawal stamp was
// written at creation. An invoice that RESOLVES to a payer today (through its scheduled service or the customer's default) while
// its own payer_id is still NULL is the payer's too, and so is every payment against it. This asks the ONE shared live verdict
// (services/invoice-payer-ownership.liveInvoiceOwnership) for each of the customer's remaining invoices and folds the owned ones
// into the linkage, so authoritative payment history and the in-flight probe judge a payment exactly like the invoice facts do.
// Unverifiable ownership (a lookup / resolver failure) => `failed` (callers fail closed). `liveOwnedIds` = invoice ids the live
// resolver named (payer_id NULL, not stamped), so SQL can drop their payments BEFORE a row cap.
// Codex round-43 P1: the scan is BOUNDED. At most LIVE_SCAN_MAX_INVOICES unstamped invoices are read (newest first) and at most
// LIVE_SCAN_MAX_RESOLUTIONS live resolver lookups are made; an account with more is UNVERIFIABLE (`failed`, callers fail closed).
// Codex round-47 P2: lookups are memoized per CANDIDATE PAYER (byCandidatePayer), not per visit, so a long monthly history costs two
// batched reads plus one lookup per distinct payer - the cap now bounds distinct payers, which no ordinary account approaches.
// Codex round-50 P2: a customer with a DEFAULT payer makes every unstamped invoice a candidate; lookups are memoized per candidate
// payer (byCandidatePayer), so each row costs only its read - the row bound is a sanity bound (1000 ≈ 80 years of monthly visits),
// and LIVE_SCAN_MAX_RESOLUTIONS bounds the actual resolver lookups (distinct payers).
const LIVE_SCAN_MAX_INVOICES = 1000;
const LIVE_CANDIDATE_PAYER_SQL = `(EXISTS (SELECT 1 FROM customers c WHERE c.id = invoices.customer_id AND c.payer_id IS NOT NULL)
  OR EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.id = invoices.scheduled_service_id AND ss.customer_id = invoices.customer_id AND ss.payer_id IS NOT NULL))`;
const LIVE_SCAN_MAX_RESOLUTIONS = 30;
const LIVE_SETTLED_EXCLUSION_SQL = "lower(coalesce(invoices.status, '')) NOT IN ('paid', 'prepaid', 'refunded', 'partially_refunded', 'void', 'voided', 'canceled', 'cancelled', 'written_off')";
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
    // Codex round-48 P2: only invoices that CAN resolve to a payer count against the bound - the account has a default payer, or the
    // invoice's own visit names one (payer.resolveForInvoice's only two sources). Every other row is self-pay for certain, so a long
    // self-pay history never makes the account unverifiable.
    .whereRaw(LIVE_CANDIDATE_PAYER_SQL)
    // Codex round-76 P2: only UNSETTLED invoices are re-resolved live - a settled self-pay invoice keeps the ownership it was paid under
    // (a payer assigned to the account later must not take the customer's own payment history with it)
    .whereRaw(LIVE_SETTLED_EXCLUSION_SQL)
    .select('id', 'customer_id', 'scheduled_service_id', 'stripe_payment_intent_id', 'stripe_charge_id', 'invoice_number')
    .orderBy('created_at', 'desc')
    .limit(LIVE_SCAN_MAX_INVOICES + 1)
    .catch(() => { failed = true; return []; });
  if (rows.length > LIVE_SCAN_MAX_INVOICES) failed = true; // more history than the bounded scan can judge => unknown
  if (failed) return { ...base, failed: true, liveOwnedIds: new Set(), liveOwnedRows: [] };
  let verdict;
  try {
    verdict = await require('./invoice-payer-ownership').liveInvoiceOwnership(customerId, rows, dbh, { maxResolutions: LIVE_SCAN_MAX_RESOLUTIONS, byCandidatePayer: true });
  } catch {
    return { ...base, failed: true, liveOwnedIds: new Set(), liveOwnedRows: [] };
  }
  if (verdict.unverifiable) return { ...base, failed: true, liveOwnedIds: new Set(), liveOwnedRows: [] };
  const liveOwned = rows.filter((r) => verdict.ownedIds.has(String(r.id)));
  const linkage = buildPayerLinkage([...base.payerInvRows, ...liveOwned]);
  return { ...linkage, liveOwnedIds: verdict.ownedIds, liveOwnedRows: liveOwned };
}

// payments.metadata->>'invoice_id' as a uuid, or NULL when it is not one. invoices.id is a
// uuid PRIMARY KEY (20260401000082_invoices), so comparing the uuid directly lets the planner
// use the key instead of casting the indexed column to text; the CASE guarantees the cast is
// only evaluated for a well-formed value (a malformed metadata string can never throw).
function uuidFromMetadata(alias) {
  const v = `${alias}.metadata->>'invoice_id'`;
  return `(CASE WHEN ${v} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (${v})::uuid END)`;
}

function excludeLiveOwnedPayerPayments(qb, linkage) {
  const rows = linkage.liveOwnedRows || [];
  if (!rows.length) return qb;
  const ph = (n) => Array.from({ length: n }, () => '?').join(', ');
  const ids = rows.map((r) => String(r.id));
  const mdId = uuidFromMetadata('payments');
  qb.whereRaw(`(${mdId} IS NULL OR ${mdId}::text NOT IN (${ph(ids.length)}))`, ids);
  const pis = rows.map((r) => r.stripe_payment_intent_id).filter(Boolean);
  if (pis.length) qb.whereRaw(`(payments.stripe_payment_intent_id IS NULL OR payments.stripe_payment_intent_id NOT IN (${ph(pis.length)}))`, pis);
  const chs = rows.map((r) => r.stripe_charge_id).filter(Boolean);
  if (chs.length) qb.whereRaw(`(payments.stripe_charge_id IS NULL OR payments.stripe_charge_id NOT IN (${ph(chs.length)}))`, chs);
  return qb;
}

module.exports = {
  LIVE_CANDIDATE_PAYER_SQL, LIVE_SETTLED_EXCLUSION_SQL,
  LIVE_SCAN_MAX_INVOICES, LIVE_SCAN_MAX_RESOLUTIONS, uuidFromMetadata, excludeLiveOwnedPayerPayments,
  invoiceIdOf, aliasInvoiceIdOf, descriptionInvoiceNumberOf, buildPayerLinkage, loadPayerLinkage, loadLivePayerLinkage,
};
