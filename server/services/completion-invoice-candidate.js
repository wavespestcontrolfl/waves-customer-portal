/**
 * Completion invoice-candidate resolution — the lookups and reconciliation the
 * completion route uses to decide which existing invoice (if any) a visit
 * REUSES, which one PARKS it (refunded), and which are simply dropped.
 * Shared with the card-expiry exemption so its invoice-state mirror reads the
 * same rows through the same rules. Read-only: no writes here.
 */
// Completion invoice-suppressor lookup. Finds the invoice already attached
// to this visit that the completion should REUSE (existingCompletionInvoice /
// preMintedInvoice) instead of minting a fresh one. Only an invoice that can
// still settle counts: the Stripe webhook writes 'refunded' on a full refund
// and 'canceled' on a PaymentIntent cancel, and admins cancel invoices by
// hand — none of those collect anything, so a `whereNot('status', 'void')`
// filter let a pre-minted/prepaid one-time invoice that was later fully
// refunded (dispute, rain-out then rebook, goodwill) suppress the completion
// mint, flip invoiceCreated, and send the customer a pay link to the REFUNDED
// invoice while shouldAutoInvoiceCompletion saw "invoice exists" and never
// raised the bill-manually alert — the visit completed unbilled. Same
// vocabulary as the setup-fee proof and voidOpenInvoicesForCancelledService.
function completionSuppressorInvoiceLookup(conn, where) {
  const InvoiceService = require('./invoice');
  return conn('invoices')
    .where(where)
    .whereNotIn('status', InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES)
    .orderBy('created_at', 'desc')
    .first();
}

// Terminal status that BLOCKS the completion mint instead of being
// re-billed (codex #3456): a refunded invoice's money may still come back
// (refund.failed at the bank), and a replacement minted in that window can
// never be reconciled safely against the restored original. So the
// completion mints NOTHING for a visit that carries one and reuses NOTHING
// either (no pay link to a dead invoice) — it parks the visit on the admin
// billing bell for a human to bill once the refund is final. ONLY
// 'refunded': a canceled/cancelled invoice collected nothing and nothing
// can restore it (a canceled PaymentIntent is terminal), so it is merely
// excluded from reuse (CANCELLED_SERVICE_RESOLVED_STATUSES) and the
// completion mints its replacement normally; 'void' likewise.
const COMPLETION_TERMINAL_INVOICE_STATUSES = ['refunded'];

// The refunded invoice on THIS visit (its own service_record_id /
// scheduled_service_id — never the sibling first-application lookup), or
// null. Newest wins across both identifiers in one ordered query.
async function completionTerminalInvoiceLookup(conn, { serviceRecordId = null, scheduledServiceId = null }) {
  if (!serviceRecordId && !scheduledServiceId) return null;
  return (await conn('invoices')
    .where((qb) => {
      if (serviceRecordId) qb.orWhere({ service_record_id: serviceRecordId });
      if (scheduledServiceId) qb.orWhere({ scheduled_service_id: scheduledServiceId });
    })
    .whereIn('status', COMPLETION_TERMINAL_INVOICE_STATUSES)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .first('id', 'invoice_number', 'status', 'created_at')) || null;
}

// The newest LIVE (collectible-or-settled) invoice on THIS visit across
// both identifiers in one ordered query — the comparison row for the
// refunded reconciliation below. The suppressor chain itself checks
// service_record_id first and scheduled_service_id only as a fallback, so
// the row it hands back is not necessarily the newest live row.
async function completionNewestLiveInvoiceLookup(conn, { serviceRecordId = null, scheduledServiceId = null }) {
  if (!serviceRecordId && !scheduledServiceId) return null;
  const InvoiceService = require('./invoice');
  return (await conn('invoices')
    .where((qb) => {
      if (serviceRecordId) qb.orWhere({ service_record_id: serviceRecordId });
      if (scheduledServiceId) qb.orWhere({ scheduled_service_id: scheduledServiceId });
    })
    .whereNotIn('status', InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    // FULL row — when live wins the reconciliation the NEWEST live row IS
    // the row the completion reuses (pay link/token, alreadyPaid status),
    // never the chain's possibly-stale one (pre-push P0 round 3).
    .first()) || null;
}

// Invoices are not unique per visit (pre-push P0): a refunded invoice can
// coexist with a live one, in either mint order — and there is NO reliable
// refund-event clock to order them by (invoices carry no refunded_at;
// created_at is the MINT time, not the refund; updated_at moves on
// unrelated edits — pre-push P0 rounds 2–6 walked every timestamp option
// and each one mis-orders some real sequence). So the reconciliation never
// auto-picks: whenever a refunded row exists beside a live row, the visit
// goes to the MANUAL path — nothing is reused (no pay link while the
// refund could still bounce and restore the refunded row to paid), nothing
// is minted, and the parked alert names the live row (`liveBeside`) so the
// office collects THAT invoice once the refund is final instead of cutting
// a duplicate. `newestLive` (completionNewestLiveInvoiceLookup, full row)
// beats the chain's `existing` as the named row — the chain may hold an
// OLDER row via service_record_id while a newer live row hangs off
// scheduled_service_id. A refunded row alone (no live row) parks exactly
// as before; no refunded row → the chain's row stands untouched.
function reconcileLiveVsRefunded(existing, refunded, newestLive = null) {
  if (!refunded) return { existing, terminal: null, liveBeside: null };
  return { existing: null, terminal: refunded, liveBeside: newestLive || existing || null };
}

// The sibling first-application lookup (services/estimate-first-application-
// invoice.js) deliberately keeps its void-only filter, so it can return a
// refunded/canceled row — a SIBLING visit's, or (same customer/estimate/
// date) this visit's own. Such a row must never become the completion
// invoice / pay link (pre-push P0): a REFUNDED row goes to the terminal
// path (suppress + manual-billing alert) exactly like an own-visit refunded
// invoice; a canceled/cancelled row is simply dropped from reuse (same
// vocabulary as the direct suppressors) so the completion mints normally.
// A live row stays the existing invoice, as before.
function splitTerminalCompletionInvoice(row) {
  if (!row) return { existing: null, terminal: null };
  if (COMPLETION_TERMINAL_INVOICE_STATUSES.includes(row.status)) {
    return { existing: null, terminal: { id: row.id, invoice_number: row.invoice_number, status: row.status } };
  }
  const InvoiceService = require('./invoice');
  if (InvoiceService.CANCELLED_SERVICE_RESOLVED_STATUSES.includes(row.status)) {
    return { existing: null, terminal: null };
  }
  return { existing: row, terminal: null };
}

module.exports = {
  completionSuppressorInvoiceLookup,
  completionTerminalInvoiceLookup,
  completionNewestLiveInvoiceLookup,
  reconcileLiveVsRefunded,
  splitTerminalCompletionInvoice,
  COMPLETION_TERMINAL_INVOICE_STATUSES,
};
