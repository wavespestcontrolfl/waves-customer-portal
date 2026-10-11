// client/src/lib/completion-invoice-prediction.js
//
// Will this completion mint an invoice, and does an unpaid invoice hold the
// review ask? Moved out of the Complete Service form (pages/admin/SchedulePage.jsx)
// unchanged so the Fast Complete Wrap-up section (components/tech/FastCompleteWrapUp.jsx)
// shows the pay-link and review controls on the same prediction. `service` is a
// schedule row, or a sheet's service carrying the same billing keys
// (lib/completion-billing-facts.js).

/** A re-service or callback visit. */
export function isCallbackVisit(service) {
  const svcTypeLower = (service.serviceType || "").toLowerCase();
  return (
    svcTypeLower.includes("re-service") ||
    svcTypeLower.includes("callback") ||
    service.isCallback
  );
}

/**
 * `visitPrice`: the price the completion bills (the reviewed pricing's amount while
 * discounts apply, else the row's estimatedPrice).
 * Returns { willInvoice, reviewAwaitsPayment }.
 */
export function completionInvoicePrediction({
  service,
  visitPrice,
  applyingDiscounts = false,
  isCallback = isCallbackVisit(service),
  oneTimeRecapOnly = false,
  visitOutcome = "completed",
}) {
  const completionVisitPrice = visitPrice;
  const applyingCompletionDiscounts = applyingDiscounts;
  const hasVisitPrice = applyingCompletionDiscounts
    || (completionVisitPrice != null && Number(completionVisitPrice) > 0);
  // Callbacks (re-services) are free by definition for recurring/WaveGuard
  // customers — the server suppresses the monthly_rate fallback for them
  // (admin-dispatch completion + Charge-now). Mirror that here so the tech UI's
  // willInvoice / pay-link prediction, AI recap framing, and review suppression
  // match the report-only/no-invoice completion the server actually performs.
  // For an unpriced visit, monthlyRate is only ever the right fallback for a
  // monthly-membership customer — everywhere else (per_application's own
  // acceptance fee, a plain per_visit/one_time lane, sibling-covered
  // first-application visits…) the AUTHORITATIVE amount is the schedule
  // payload's own billingLane.prediction, computed server-side by the exact
  // same predictCompletionBilling / completionInvoiceAmount (billing-lane.js)
  // completion itself uses — never re-derived locally, so this can't drift
  // from what completion actually bills (codex pre-push P1: a local
  // tier/lane guard either showed the wrong monthlyRate for a legacy
  // inferred lane, or zeroed a real per-application fee).
  //
  // The prediction's `amount` is ALREADY net of prepaidAmount for an
  // 'invoice'/'auto_charge' kind (predictCompletionBilling subtracts it
  // server-side), and a 'prepaid' kind's amount is what was ALREADY
  // collected, not a new balance — so `usingUnpricedPrediction` keeps
  // prepaidCovered below from netting the SAME prepayment a second time
  // against a figure that's already final (codex pre-push P1: double-
  // netting misclassified a partially-prepaid visit as fully covered and
  // suppressed the invoice for its real remaining balance).
  const predictionKind = service.billingLane?.prediction?.kind || null;
  const usingUnpricedPrediction = !hasVisitPrice && !isCallback;
  // Round-8 P1: `billingLane.siblingCoverage` (the server's ONE canonical
  // per-visit collection verdict — owner decision, narrow + fail closed) in
  // state 'collect_on_combined_invoice' means completion REUSES that
  // sibling invoice (complete-scheduled-service.js) exactly like an
  // existing outstanding invoice — never a fresh mint, but still a real
  // amount due, a pay link, and a held review — so this panel must not
  // treat it as `usingUnpricedPrediction`'s ordinary $0/no-invoice path.
  const siblingCoverage = service.billingLane?.siblingCoverage || null;
  const collectOnSiblingInvoice = siblingCoverage?.state === 'collect_on_combined_invoice';
  // Codex pre-push P2: a covering sibling invoice reads `state: 'settled'`
  // for FIVE distinct reasons (billing-lane.js siblingCoverageForSchedule) —
  // 'invoice_settled' (literal paid/prepaid), 'invoice_processing' (money in
  // flight, e.g. a pending ACH debit), 'withdrawn_from_customer' /
  // 'payer_billed' (draft/sent, but not collectible from this homeowner at
  // all), and 'credit_applied' (draft/sent, covered by account credit, never
  // marked literally paid). A technician collects nothing at the door for
  // any of the five — but complete-scheduled-service.js's own
  // invoiceBlocksReview holds the review ask for every invoice status
  // EXCEPT literal 'paid'/'prepaid', which only 'invoice_settled' actually
  // is. This used to recognize 'invoice_processing' alone (codex round-9
  // P2's own fix), which correctly held the ask for THAT one reason but
  // missed the other three draft/sent-but-not-collectible reasons — the
  // panel promised an immediate review request the server still withheld
  // pending manual reconciliation. Every reason except the literal
  // paid/prepaid one now holds the preview the same way.
  const siblingInvoiceNotYetSettled = siblingCoverage?.state === 'settled'
    && siblingCoverage?.reason !== 'invoice_settled';
  const invoiceAmount = hasVisitPrice
    ? Number(completionVisitPrice)
    : isCallback
      ? 0
      : collectOnSiblingInvoice
        ? Number(siblingCoverage.amountDue) || 0
        : (predictionKind === 'prepaid' ? 0 : Number(service.billingLane?.prediction?.amount) || 0);
  // Codex round-2 P1 (sweep): this used to infer "dues cover it" from
  // autopayActive + a tier + a positive monthlyRate + no stamped visit
  // price — the SAME shape as MobileAppointmentDetailSheet's
  // coveredByMembership bug. A tiered per_application (or per_visit)
  // customer can have autopay on AND carry a real, positive invoice/
  // auto_charge prediction for an unpriced row (e.g. the $97.20
  // acceptance-fee case in this file's own billing-lane-amount test) —
  // that heuristic never looked at the prediction at all, so it would
  // report-only a visit completion (and the schedule sheet's own Charge
  // Now mint) actually bills. `covered_membership` is the ONLY signal
  // this panel may treat as "dues cover it, no invoice."
  const autopayCoversVisit = predictionKind === 'covered_membership';
  const prepaidCovered = usingUnpricedPrediction
    ? predictionKind === 'prepaid'
    : (service.prepaidAmount != null &&
      Number(service.prepaidAmount) > 0 &&
      Number(service.prepaidAmount) >= invoiceAmount);
  // paid and prepaid are both settled to the server (invoiceBlocksReview,
  // report-only completion) — codex #4140 r15 P2.
  const invoiceAlreadyPaid =
    ["paid", "prepaid"].includes(service.checkoutInvoiceStatus) ||
    ["paid", "prepaid"].includes(service.invoiceStatus);
  const reportOnlyCompletion =
    prepaidCovered ||
    invoiceAlreadyPaid ||
    autopayCoversVisit ||
    !!service.completionInvoiceAlreadySent;
  // Typed one-time completions bill by PROFILE: since the billing pre-gate
  // removal (2026-07-27) the server mints the completion invoice at the row
  // price for a billingType 'one_time' profile even without the scheduler
  // flag or a tier. Mirror that conjunction here (row-priced, performed,
  // non-callback, not an included follow-up) so the SMS preview, pay-link
  // toggle, and review controls show the completion the server actually
  // performs.
  const typedOneTimeBilling =
    String(service.completionProfile?.billingType || "").toLowerCase() ===
      "one_time" &&
    service.followupIncluded !== true &&
    hasVisitPrice &&
    !isCallback &&
    visitOutcome !== "inspection_only" &&
    visitOutcome !== "customer_declined";
  const willInvoice =
    !oneTimeRecapOnly &&
    !reportOnlyCompletion &&
    (collectOnSiblingInvoice ||
      !!service.createInvoiceOnComplete ||
      !!service.waveguardTier ||
      typedOneTimeBilling) &&
    invoiceAmount > 0;
  // The server's invoiceBlocksReview: an UNPAID invoice after completion —
  // one minted now (willInvoice) or one already sent from dispatch and still
  // open (completionInvoiceAlreadySent, codex #4140 r12 P2). Prepaid and
  // paid invoices never hold the ask. A covering sibling invoice awaiting
  // payment or reconciliation holds it too (siblingInvoiceNotYetSettled
  // above) — the reused invoice completion actually checks is the
  // SIBLING's, and invoiceBlocksReview clears only on its literal
  // 'paid'/'prepaid' status, not this row's own.
  const reviewAwaitsPayment = willInvoice || siblingInvoiceNotYetSettled
    || (!!service.completionInvoiceAlreadySent && !invoiceAlreadyPaid);
  return { willInvoice, reviewAwaitsPayment };
}
