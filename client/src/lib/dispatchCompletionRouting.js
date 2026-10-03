import { isTreeShrubFastCompleteEligible } from "./tree-shrub-fast-complete";
import { isLawnFastCompleteEligible } from "./lawn-fast-complete";

export const TERMINAL_VISIT_STATUSES = new Set([
  "completed",
  "cancelled",
  "no_show",
  "skipped",
]);

export function shouldReopenCompletionAfterPayment(service) {
  return !TERMINAL_VISIT_STATUSES.has(
    String(service?.status || "").trim().toLowerCase(),
  );
}

export function mergePostPaymentService(freshService, paymentService) {
  if (!freshService) return paymentService;
  return {
    ...freshService,
    ...paymentService,
    // The refetch owns lifecycle state. The payment-sheet snapshot can be
    // stale (for example, checkout opened before another actor completed the
    // visit), but its invoice fields still need to ride into completion.
    status: freshService.status || paymentService?.status,
  };
}

// Admin Dispatch opens the Tree & Shrub Fast Complete sheet for a visit the
// shared rule makes eligible (same rule as the technician home page). A visit
// returning from the payment flow carries invoice fields the sheet does not
// send, so it keeps the full form, whose body marks the invoice as handled.
// So does a row with no `propertyId` key (the mobile week list's rows carry no
// premise): the sheet checks the routed premise against the live visit, and
// without it a cached row moved to another property could complete unnoticed.
export function shouldOpenTreeShrubFastComplete(service) {
  return isTreeShrubFastCompleteEligible(service)
    && service != null && "propertyId" in service
    && !service?.completionInvoiceAlreadySent
    && !service?.checkoutInvoiceId
    && !service?.checkoutInvoiceToken;
}

// Admin Dispatch opens the lawn Fast Complete sheet for a visit the shared rule
// makes eligible, on the same terms as the Tree & Shrub sheet above: not a
// visit returning from the payment flow, and not a row with no `propertyId`
// key. The sheet then confirms it with the server's context and hands the visit
// to the full form when the server says it is not eligible.
export function shouldOpenLawnFastComplete(service) {
  return isLawnFastCompleteEligible(service)
    && service != null && "propertyId" in service
    && !service?.completionInvoiceAlreadySent
    && !service?.checkoutInvoiceId
    && !service?.checkoutInvoiceToken;
}
