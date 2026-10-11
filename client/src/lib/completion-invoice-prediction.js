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

const SETTLED_STATUSES = ["paid", "prepaid"];

// Stage 1: is the visit priced? A reviewed pricing that applies discounts counts as priced.
const isPriced = (visitPrice, applyingDiscounts) => applyingDiscounts
  || (visitPrice != null && Number(visitPrice) > 0);

// Stage 2: what the schedule payload's billing lane says.
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
const predictionKindOf = (service) => service.billingLane?.prediction?.kind || null;

// Stage 3: the covering sibling invoice, if any.
// Round-8 P1: `billingLane.siblingCoverage` (the server's ONE canonical
// per-visit collection verdict — owner decision, narrow + fail closed) in
// state 'collect_on_combined_invoice' means completion REUSES that
// sibling invoice (complete-scheduled-service.js) exactly like an
// existing outstanding invoice — never a fresh mint, but still a real
// amount due, a pay link, and a held review — so this panel must not
// treat it as the unpriced prediction's ordinary $0/no-invoice path.
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
// is. Every reason except the literal paid/prepaid one holds the preview.
function siblingInvoiceOf(service) {
  const coverage = service.billingLane?.siblingCoverage || null;
  return {
    coverage,
    collect: coverage?.state === 'collect_on_combined_invoice',
    notYetSettled: coverage?.state === 'settled' && coverage?.reason !== 'invoice_settled',
  };
}

// Stage 4: the amount the completion would bill.
function invoiceAmountOf({ service, hasVisitPrice, visitPrice, isCallback, sibling, predictionKind }) {
  if (hasVisitPrice) return Number(visitPrice);
  if (isCallback) return 0;
  if (sibling.collect) return Number(sibling.coverage.amountDue) || 0;
  return predictionKind === 'prepaid' ? 0 : Number(service.billingLane?.prediction?.amount) || 0;
}

// Stage 5: does a prepayment cover it?
// The prediction's `amount` is ALREADY net of prepaidAmount for an
// 'invoice'/'auto_charge' kind (predictCompletionBilling subtracts it
// server-side), and a 'prepaid' kind's amount is what was ALREADY
// collected, not a new balance — so an unpriced visit keeps this from
// netting the SAME prepayment a second time against a figure that's
// already final (codex pre-push P1: double-netting misclassified a
// partially-prepaid visit as fully covered and suppressed the invoice
// for its real remaining balance).
function prepaidCovers({ service, usingUnpricedPrediction, predictionKind, invoiceAmount }) {
  if (usingUnpricedPrediction) return predictionKind === 'prepaid';
  const prepaid = Number(service.prepaidAmount);
  return service.prepaidAmount != null && prepaid > 0 && prepaid >= invoiceAmount;
}

// paid and prepaid are both settled to the server (invoiceBlocksReview,
// report-only completion) — codex #4140 r15 P2.
const invoiceIsSettled = (service) => SETTLED_STATUSES.includes(service.checkoutInvoiceStatus)
  || SETTLED_STATUSES.includes(service.invoiceStatus);

// Stage 6: report-only completions bill nothing.
// Codex round-2 P1 (sweep): "dues cover it" used to be inferred from
// autopayActive + a tier + a positive monthlyRate — a tiered per_application
// customer can have autopay on AND carry a real, positive invoice/auto_charge
// prediction for an unpriced row. `covered_membership` is the ONLY signal
// this panel may treat as "dues cover it, no invoice."
const isReportOnly = ({ service, prepaidCovered, invoiceAlreadyPaid, predictionKind }) => prepaidCovered
  || invoiceAlreadyPaid
  || predictionKind === 'covered_membership'
  || !!service.completionInvoiceAlreadySent;

// Stage 7: typed one-time completions bill by PROFILE: since the billing pre-gate
// removal (2026-07-27) the server mints the completion invoice at the row
// price for a billingType 'one_time' profile even without the scheduler
// flag or a tier. Mirror that conjunction here (row-priced, performed,
// non-callback, not an included follow-up) so the SMS preview, pay-link
// toggle, and review controls show the completion the server actually performs.
const NOT_PERFORMED_OUTCOMES = ["inspection_only", "customer_declined"];
const isTypedOneTimeBilling = ({ service, hasVisitPrice, isCallback, visitOutcome }) => (
  String(service.completionProfile?.billingType || "").toLowerCase() === "one_time"
  && service.followupIncluded !== true
  && hasVisitPrice
  && !isCallback
  && !NOT_PERFORMED_OUTCOMES.includes(visitOutcome)
);

// Stage 8: something makes the visit bill.
const hasBillingSignal = ({ service, sibling, typedOneTimeBilling }) => sibling.collect
  || !!service.createInvoiceOnComplete
  || !!service.waveguardTier
  || typedOneTimeBilling;

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
  const hasVisitPrice = isPriced(visitPrice, applyingDiscounts);
  const predictionKind = predictionKindOf(service);
  const sibling = siblingInvoiceOf(service);
  const invoiceAmount = invoiceAmountOf({ service, hasVisitPrice, visitPrice, isCallback, sibling, predictionKind });
  const prepaidCovered = prepaidCovers({ service, usingUnpricedPrediction: !hasVisitPrice && !isCallback, predictionKind, invoiceAmount });
  const invoiceAlreadyPaid = invoiceIsSettled(service);
  const reportOnly = isReportOnly({ service, prepaidCovered, invoiceAlreadyPaid, predictionKind });
  const typedOneTimeBilling = isTypedOneTimeBilling({ service, hasVisitPrice, isCallback, visitOutcome });
  const willInvoice = !oneTimeRecapOnly
    && !reportOnly
    && hasBillingSignal({ service, sibling, typedOneTimeBilling })
    && invoiceAmount > 0;
  // The server's invoiceBlocksReview: an UNPAID invoice after completion —
  // one minted now (willInvoice) or one already sent from dispatch and still
  // open (completionInvoiceAlreadySent, codex #4140 r12 P2). Prepaid and
  // paid invoices never hold the ask. A covering sibling invoice awaiting
  // payment or reconciliation holds it too — the reused invoice completion
  // actually checks is the SIBLING's, and invoiceBlocksReview clears only on
  // its literal 'paid'/'prepaid' status, not this row's own.
  const reviewAwaitsPayment = willInvoice || sibling.notYetSettled
    || (!!service.completionInvoiceAlreadySent && !invoiceAlreadyPaid);
  return { willInvoice, reviewAwaitsPayment };
}
