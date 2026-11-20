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
// A pay action needs to check every stored invoice reference for agreement.
function paymentInvoiceIds(payment) {
  const metadata = metadataOf(payment);
  return [metadata?.invoice_id, metadata?.dispute_invoice_id, metadata?.waves_invoice_id]
    .filter((value) => value != null)
    .map((value) => String(value).toLowerCase());
}
function isCombinedPayment(payment) {
  const value = metadataOf(payment)?.combined_payment;
  return value === true || value === 'true';
}
const descriptionInvoiceNumberOf = (p) => {
  const m = /^Invoice\s+([A-Za-z0-9-]+)\s+—/.exec(String(p.description || ''));
  return m ? m[1] : null;
};

// Build the predicate from the customer's payer-owned invoice rows
// ({ id, stripe_payment_intent_id, stripe_charge_id, invoice_number }).
function buildPayerLinkage(payerInvRows, { failed = false } = {}) {
  // invoices.id is a UUID, so PostgreSQL's canonical form is lowercase even
  // when a historical payment stamp preserved uppercase input. Compare every
  // invoice reference on the payment after the same normalization: one stale
  // self-pay alias must not hide a second alias that names payer-owned debt.
  const payerInvoiceIds = new Set(payerInvRows.map((r) => String(r.id).toLowerCase()));
  const payerIntentIds = new Set(payerInvRows.map((r) => r.stripe_payment_intent_id).filter(Boolean));
  const payerChargeIds = new Set(payerInvRows.map((r) => r.stripe_charge_id).filter(Boolean));
  const payerInvoiceNumbers = new Set(payerInvRows.map((r) => r.invoice_number).filter(Boolean));
  const isPayerLinked = (p) => {
    // A row the ledger stamps as the payer's directly (payments.payer_id, or metadata.payer_id on statement refunds and
    // disputes) is the payer's whatever it links to.
    if (p.payer_id != null || metadataOf(p)?.payer_id != null) return true;
    if (paymentInvoiceIds(p).some((invId) => payerInvoiceIds.has(invId))) return true;
    if (p.stripe_payment_intent_id && payerIntentIds.has(p.stripe_payment_intent_id)) return true;
    if (p.stripe_charge_id && payerChargeIds.has(p.stripe_charge_id)) return true;
    const num = descriptionInvoiceNumberOf(p);
    return !!(num && payerInvoiceNumbers.has(num));
  };
  return { failed, payerInvRows, payerInvoiceIds, isPayerLinked };
}

// Older payment writers stored a JSON string inside their JSONB column.
// PostgreSQL 16 validates that inner string before the cast (even malformed
// historical text cannot abort the balance query). Keep the whole-object form
// shared too: writers that add a key must normalize the legacy string first,
// or jsonb concatenation turns it into ["{...}", {"new_key": ...}].
function paymentMetadataObjectSql(alias) {
  const column = `${alias}.metadata`;
  return `(CASE WHEN jsonb_typeof(${column}) = 'string' AND pg_input_is_valid(${column} #>> '{}', 'jsonb')
    THEN CASE WHEN jsonb_typeof((${column} #>> '{}')::jsonb) = 'object'
      THEN (${column} #>> '{}')::jsonb ELSE '{}'::jsonb END
    WHEN jsonb_typeof(${column}) = 'object' THEN ${column} ELSE '{}'::jsonb END)`;
}

// Values keep the compact reader used by bounded filters. Keys are internal
// literals.
function paymentMetadataValueSql(alias, key) {
  const column = `${alias}.metadata`;
  return `(CASE WHEN jsonb_typeof(${column}) = 'string' AND pg_input_is_valid(${column} #>> '{}', 'jsonb')
    THEN ((${column} #>> '{}')::jsonb)->>'${key}' ELSE ${column}->>'${key}' END)`;
}

function excludeDirectPayerPayments(query) {
  return query.whereNull('payments.payer_id')
    .whereRaw(`COALESCE(${paymentMetadataValueSql('payments', 'payer_id')}, '') = ''`);
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
// A combined-visit invoice is always a candidate: its representative visit can be self-pay while another BILLED packet member has
// a per-job payer. The packet's saved billing snapshot, member overrides and customer fallback are judged only by the canonical
// liveThirdPartyPayerForPacket reader. LIVE_PACKET_SCAN_MAX_PACKETS bounds those additional packet reads; crossing it is UNKNOWN.
const LIVE_SCAN_MAX_INVOICES = 1000;
const LIVE_CANDIDATE_PAYER_SQL = `(EXISTS (SELECT 1 FROM customers c WHERE c.id = invoices.customer_id AND c.payer_id IS NOT NULL)
  OR EXISTS (SELECT 1 FROM scheduled_services ss WHERE ss.id = invoices.scheduled_service_id AND ss.customer_id = invoices.customer_id AND ss.payer_id IS NOT NULL)
  OR EXISTS (SELECT 1 FROM service_records sr JOIN scheduled_services ss ON ss.id = sr.scheduled_service_id
    WHERE invoices.scheduled_service_id IS NULL AND sr.id = invoices.service_record_id AND ss.customer_id = invoices.customer_id AND ss.payer_id IS NOT NULL)
  OR invoices.visit_completion_packet_id IS NOT NULL)`;
const LIVE_SCAN_MAX_RESOLUTIONS = 30;
const LIVE_PACKET_SCAN_MAX_PACKETS = 30;
const LIVE_SETTLED_EXCLUSION_SQL = "lower(coalesce(invoices.status, '')) NOT IN ('paid', 'prepaid', 'refunded', 'partially_refunded', 'void', 'voided', 'canceled', 'cancelled', 'written_off')";
const LIVE_ANNUAL_PREPAY_MARKER_SQL = 'EXISTS (SELECT 1 FROM annual_prepay_terms apt WHERE apt.prepay_invoice_id = invoices.id) AS annual_prepay_linked';
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
    // Codex round-48 P2: only invoices that CAN resolve to a payer count against the bound - the account has a default payer, the
    // invoice's own visit names one, or a combined packet can name one on another billed member. Every other row is self-pay for
    // certain, so a long self-pay history never makes the account unverifiable.
    .whereRaw(LIVE_CANDIDATE_PAYER_SQL)
    // Codex round-76 P2: only UNSETTLED invoices are re-resolved live - a settled self-pay invoice keeps the ownership it was paid under
    // (a payer assigned to the account later must not take the customer's own payment history with it)
    .whereRaw(LIVE_SETTLED_EXCLUSION_SQL)
    .select('id', 'customer_id', 'scheduled_service_id', 'service_record_id', 'visit_completion_packet_id', 'stripe_payment_intent_id', 'stripe_charge_id', 'invoice_number',
      typeof dbh.client?.raw === 'function' ? dbh.client.raw(LIVE_ANNUAL_PREPAY_MARKER_SQL) : LIVE_ANNUAL_PREPAY_MARKER_SQL)
    .orderBy('created_at', 'desc')
    .limit(LIVE_SCAN_MAX_INVOICES + 1)
    .catch(() => { failed = true; return []; });
  if (rows.length > LIVE_SCAN_MAX_INVOICES) failed = true; // more history than the bounded scan can judge => unknown
  if (failed) return { ...base, failed: true, liveOwnedIds: new Set(), liveOwnedRows: [] };
  // Annual-prepay invoices obey the TERM's Bill-To scope, not a visit link
  // the invoice may also carry. Some legacy/renewal rows have no
  // invoices.annual_prepay_term_id and are identifiable only through
  // annual_prepay_terms.prepay_invoice_id. The bounded invoice read above
  // projects that indexed EXISTS marker, so no extra round trip or per-row
  // lookup is needed. Remove visit/record scope before asking the canonical
  // live resolver. The customer default payer still applies; a payer assigned
  // only to the linked visit does not take ownership of the homeowner's year.
  const annualPrepayIds = new Set(rows.filter((row) => row.annual_prepay_linked).map((row) => String(row.id)));
  const ownershipRows = rows.map((row) => (annualPrepayIds.has(String(row.id))
    ? { ...row, scheduled_service_id: null, service_record_id: null }
    : row));
  let verdict;
  try {
    verdict = await require('./invoice-payer-ownership').liveInvoiceOwnership(customerId, ownershipRows, dbh, { maxResolutions: LIVE_SCAN_MAX_RESOLUTIONS, byCandidatePayer: true });
  } catch {
    return { ...base, failed: true, liveOwnedIds: new Set(), liveOwnedRows: [] };
  }
  if (verdict.unverifiable) return { ...base, failed: true, liveOwnedIds: new Set(), liveOwnedRows: [] };

  // A packet's representative invoice link is not its whole Bill-To verdict.
  // Check each still-unowned packet once through the canonical packet reader;
  // it consults only the saved billed-member snapshot and applies each
  // member's payer/self-pay override before the customer fallback. `dbh` is
  // the caller's read-only repeatable-read transaction on the Billing route,
  // so the packet, members and later balance/token queries share one snapshot.
  const packetRows = rows.filter((row) => !annualPrepayIds.has(String(row.id)) && row.visit_completion_packet_id
    && !verdict.ownedIds.has(String(row.id)));
  const packetIds = [...new Set(packetRows.map((row) => String(row.visit_completion_packet_id)))];
  if (packetIds.length > LIVE_PACKET_SCAN_MAX_PACKETS) {
    return { ...base, failed: true, liveOwnedIds: new Set(), liveOwnedRows: [] };
  }
  try {
    const ownedPacketIds = new Set();
    const Packets = require('./visit-completion-packets');
    for (const packetId of packetIds) {
      if (await Packets.liveThirdPartyPayerForPacket(packetId, dbh)) ownedPacketIds.add(packetId);
    }
    for (const row of packetRows) {
      if (ownedPacketIds.has(String(row.visit_completion_packet_id))) verdict.ownedIds.add(String(row.id));
    }
  } catch {
    return { ...base, failed: true, liveOwnedIds: new Set(), liveOwnedRows: [] };
  }
  const liveOwned = rows.filter((r) => verdict.ownedIds.has(String(r.id)));
  const linkage = buildPayerLinkage([...base.payerInvRows, ...liveOwned]);
  return { ...linkage, liveOwnedIds: verdict.ownedIds, liveOwnedRows: liveOwned };
}

// payments.metadata->>'invoice_id' as a uuid, or NULL when it is not one. invoices.id is a
// uuid PRIMARY KEY (20260401000082_invoices), so comparing the uuid directly lets the planner
// use the key instead of casting the indexed column to text; the CASE guarantees the cast is
// only evaluated for a well-formed value (a malformed metadata string can never throw).
function uuidFromMetadata(alias, key = 'invoice_id') {
  const v = paymentMetadataValueSql(alias, key);
  return `(CASE WHEN ${v} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (${v})::uuid END)`;
}

function excludeLiveOwnedPayerPayments(qb, linkage) {
  // SQL twin of buildPayerLinkage/isPayerLinked for rows whose invoice is
  // already known. loadLivePayerLinkage folds stamped and live-owned invoices
  // into payerInvRows, so filtering all of them here keeps row limits/order
  // from being consumed by AP history. Direct payer stamps are handled by
  // excludeDirectPayerPayments before this helper is called.
  const rows = linkage.payerInvRows?.length ? linkage.payerInvRows : (linkage.liveOwnedRows || []);
  if (!rows.length) return qb;
  const ids = rows.map((r) => String(r.id));
  for (const key of ['invoice_id', 'dispute_invoice_id', 'waves_invoice_id']) {
    const mdId = uuidFromMetadata('payments', key);
    qb.whereRaw(`COALESCE(${mdId}::text <> ALL(?::text[]), TRUE)`, [ids]);
  }
  const pis = rows.map((r) => r.stripe_payment_intent_id).filter(Boolean);
  if (pis.length) qb.whereRaw(`(payments.stripe_payment_intent_id IS NULL OR payments.stripe_payment_intent_id <> ALL(?::text[]))`, [pis]);
  const chs = rows.map((r) => r.stripe_charge_id).filter(Boolean);
  if (chs.length) qb.whereRaw(`(payments.stripe_charge_id IS NULL OR payments.stripe_charge_id <> ALL(?::text[]))`, [chs]);
  const nums = rows.map((r) => r.invoice_number).filter(Boolean);
  if (nums.length) {
    qb.whereRaw(`COALESCE(substring(payments.description from '^Invoice\\s+([A-Za-z0-9-]+)\\s+—'), '') <> ALL(?::text[])`, [nums]);
  }
  return qb;
}

module.exports = {
  LIVE_CANDIDATE_PAYER_SQL, LIVE_SETTLED_EXCLUSION_SQL, LIVE_ANNUAL_PREPAY_MARKER_SQL,
  LIVE_SCAN_MAX_INVOICES, LIVE_SCAN_MAX_RESOLUTIONS, LIVE_PACKET_SCAN_MAX_PACKETS,
  paymentMetadataObjectSql, paymentMetadataValueSql, uuidFromMetadata, excludeLiveOwnedPayerPayments,
  invoiceIdOf, aliasInvoiceIdOf, paymentInvoiceIds, isCombinedPayment, descriptionInvoiceNumberOf, buildPayerLinkage, loadPayerLinkage, loadLivePayerLinkage, excludeDirectPayerPayments,
};
