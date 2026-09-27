// Shared status → copy decision for the `covered_sibling_invoice` prediction
// kind (billing-lane.js siblingCoveredCompletionPrediction) — a same-day
// combined per-application trip whose SIBLING visit's invoice already bills
// this one. The verdict NEVER mints a second invoice for this visit
// regardless of the sibling invoice's own payment state (that would double-
// bill the trip) — but every consumer of this prediction used to render
// "no charge needed" / "nothing to collect" no matter what, so a technician
// could walk off a job whose combined-trip invoice was still draft/sent/
// overdue — genuinely collectible (Codex round-7 P1).
//
// SETTLED (nothing left to collect on the sibling invoice): 'paid', or
// 'prepaid' (covered by account credit / an annual-prepay term), or
// 'processing' (an ACH debit already in flight — collecting again would
// double-charge). Mirrors INVOICE_UNCOLLECTIBLE_STATUSES in
// server/services/invoice-helpers.js, minus its terminal-dead statuses
// (void/refunded/canceled/cancelled) — those never reach a
// covered_sibling_invoice prediction at all: siblingInvoiceCoverageVerdict
// (billing-lane.js) routes a terminal/refunded match to 'needs_review' /
// `sibling_needs_review` before this prediction is ever built.
//
// COLLECTIBLE (still needs collecting, on the SIBLING invoice, not this
// visit): 'draft', 'scheduled', 'sent', 'viewed', 'overdue', 'sending' —
// mirrors SEND_FINALIZABLE_STATUSES in the same server module, the only
// other statuses this prediction can carry.
//
// A missing/unrecognized invoiceStatus (older cached payloads, or a test
// fixture that never set it) is NOT read as collectible — fail toward the
// quiet "nothing to collect" copy rather than inventing an action item from
// data that isn't there.
const SIBLING_INVOICE_SETTLED_STATUSES = ['paid', 'prepaid', 'processing'];
const SIBLING_INVOICE_COLLECTIBLE_STATUSES = ['draft', 'scheduled', 'sent', 'viewed', 'overdue', 'sending'];

export function isSiblingInvoiceCollectible(status) {
  return SIBLING_INVOICE_COLLECTIBLE_STATUSES.includes(String(status || '').toLowerCase());
}

export function isSiblingInvoiceSettled(status) {
  return SIBLING_INVOICE_SETTLED_STATUSES.includes(String(status || '').toLowerCase());
}

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : null;
}

/**
 * Copy + affordance for a `covered_sibling_invoice` prediction. Returns null
 * for any other kind (or a missing prediction) so a caller can chain it
 * straight off `service.billingLane.prediction` without a kind check first.
 *
 * `collectible` is the ONE branch point every consumer keys its copy/color/
 * CTA off — never invoiceStatus directly, so the settled-status list lives
 * in exactly one place.
 */
export function siblingInvoiceCoverageCopy(prediction) {
  if (!prediction || prediction.kind !== 'covered_sibling_invoice') return null;
  const collectible = isSiblingInvoiceCollectible(prediction.invoiceStatus);
  const invoiceId = prediction.invoiceId || null;
  const invoiceNumber = prediction.invoiceNumber || null;
  const invoiceRef = invoiceNumber ? `invoice ${invoiceNumber}` : 'the combined trip invoice';
  const siblingSuffix = prediction.siblingServiceType ? ` on the ${prediction.siblingServiceType} visit` : '';
  const dueAmount = Number(prediction.amountDue);
  const hasDueAmount = collectible && Number.isFinite(dueAmount) && dueAmount > 0;
  const dueText = hasDueAmount ? ` (${money(dueAmount)} due)` : '';
  // Deep link into the invoice's own row — AdminInvoicesPage reads /invoice
  // from the URL and expands/fetches that exact row (its own deep-link
  // effect), and /admin/invoices/:id (AdminDetailRedirect) is the canonical
  // route INTO that shape from anywhere else in the app.
  const invoiceHref = invoiceId ? `/admin/invoices/${encodeURIComponent(invoiceId)}` : null;
  return {
    collectible,
    invoiceId,
    invoiceNumber,
    amountDue: hasDueAmount ? dueAmount : null,
    invoiceHref,
    // One-line detail — BillingLaneCard, ScheduleCustomerSidebar, the
    // detail-sheet CTA note.
    detail: collectible
      ? `Covered by the combined trip invoice — ${invoiceRef}${dueText}${siblingSuffix} is still due. Collect on that invoice, not this visit.`
      : `Covered by ${invoiceRef}${siblingSuffix} (same trip) — nothing to collect.`,
    // Short label — visitBrief / CompletionPricingCard headlines.
    short: collectible ? `Collect on ${invoiceRef}${dueText}` : 'Covered — nothing to collect',
  };
}
