// Pure copy formatting for `billingLane.siblingCoverage` — the ONE
// canonical per-visit collection verdict the server computes
// (server/services/billing-lane.js siblingCoverageForSchedule), attached to
// every schedule payload. Owner decision (narrow + fail closed, after 8
// Codex rounds of the schedule preview, Charge Now, completion, and six
// client surfaces each re-deriving "is this visit covered by another
// invoice?" separately): this module NEVER classifies collect vs. settled
// vs. review itself any more — the server already decided that from its own
// gates (the shared sibling-invoice lookup, invoiceWithdrawnFromCustomer,
// payer ownership, credit-applied netting, terminal statuses). Every
// surface renders `siblingCoverage.state` and nothing else.
//
// `siblingCoverage` shape: { state: 'none' | 'settled' | 'collect_on_combined_invoice' | 'review',
//   invoiceId, invoiceNumber, amountDue, reason }.

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : null;
}

/**
 * Copy + affordance for a `billingLane.siblingCoverage` verdict. Returns
 * null for a missing verdict or `state: 'none'` so a caller can chain it
 * straight off `service.billingLane?.siblingCoverage` without a state check
 * first.
 */
export function siblingCoverageCopy(siblingCoverage, { siblingServiceType = null } = {}) {
  if (!siblingCoverage || siblingCoverage.state === 'none') return null;
  const { state, invoiceId = null, invoiceNumber = null, amountDue = null } = siblingCoverage;
  const collectible = state === 'collect_on_combined_invoice';
  const needsReview = state === 'review';
  const invoiceRef = invoiceNumber ? `invoice ${invoiceNumber}` : 'the combined trip invoice';
  const siblingSuffix = siblingServiceType ? ` on the ${siblingServiceType} visit` : '';
  const dueAmount = Number(amountDue);
  const hasDueAmount = collectible && Number.isFinite(dueAmount) && dueAmount > 0;
  const dueText = hasDueAmount ? ` (${money(dueAmount)} due)` : '';
  // Deep link into the invoice's own row — AdminInvoicesPage reads /invoice
  // from the URL and expands/fetches that exact row (its own deep-link
  // effect), and /admin/invoices/:id (AdminDetailRedirect) is the canonical
  // route INTO that shape from anywhere else in the app.
  const invoiceHref = invoiceId ? `/admin/invoices/${encodeURIComponent(invoiceId)}` : null;
  return {
    state,
    collectible,
    needsReview,
    settled: state === 'settled',
    invoiceId,
    invoiceNumber,
    amountDue: hasDueAmount ? dueAmount : null,
    invoiceHref,
    // One-line detail — BillingLaneCard, ScheduleCustomerSidebar, the
    // detail-sheet CTA note.
    detail: needsReview
      ? 'This visit’s combined-trip invoice needs a human look — reconcile it from Customer 360.'
      : collectible
        ? `Covered by the combined trip invoice — ${invoiceRef}${dueText}${siblingSuffix} is still due. Collect on that invoice, not this visit.`
        : `Covered by ${invoiceRef}${siblingSuffix} (same trip) — nothing to collect.`,
    // Short label — visitBrief / CompletionPricingCard headlines.
    short: needsReview
      ? 'Needs review — see Customer 360'
      : (collectible ? `Collect on ${invoiceRef}${dueText}` : 'Covered — nothing to collect'),
  };
}
