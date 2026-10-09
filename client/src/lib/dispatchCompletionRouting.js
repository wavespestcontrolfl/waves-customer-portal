import { isTreeShrubFastCompleteEligible } from "./tree-shrub-fast-complete";
import { isLawnFastCompleteEligible, isLawnReserviceFastCompleteEligible, LAWN_FINDINGS_TYPE } from "./lawn-fast-complete";
import { isFastCompleteReportEligible, isLaneReportEligible, isTypedReportEligible } from "./pest-fast-complete";

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
// returning from the payment flow keeps the full form, whose body marks the
// invoice as handled, unless GATE_FAST_COMPLETE_INVOICED_VISITS is on for the
// row: the sheets then post that same mark (refusesInvoicedVisit below).
// So does a row with no `propertyId` key (the mobile week list's rows carry no
// premise): the sheet checks the routed premise against the live visit, and
// without it a cached row moved to another property could complete unnoticed.
export function shouldOpenTreeShrubFastComplete(service) {
  return isTreeShrubFastCompleteEligible(service)
    && service != null && "propertyId" in service
    && !refusesInvoicedVisit(service);
}

// Admin Dispatch opens the lawn Fast Complete sheet for a visit the shared rule
// makes eligible, on the same terms as the Tree & Shrub sheet above: not a
// visit returning from the payment flow, and not a row with no `propertyId`
// key. The sheet then confirms it with the server's context and hands the visit
// to the full form when the server says it is not eligible.
export function shouldOpenLawnFastComplete(service) {
  return isLawnFastCompleteEligible(service)
    && service != null && "propertyId" in service
    && !refusesInvoicedVisit(service);
}

// Admin Dispatch opens the lawn re-service's own Fast Complete sheet for a
// visit the shared rule makes eligible (owner 2026-10-08: the technician home
// already did), on the same terms as the sheets above.
// It also asks what the server's own check refuses and the row already
// shows (lawnReserviceIneligibleReason: not the typed lawn form, a project,
// companion findings, a grouped stop), so those visits open the
// working form and not a blocked sheet.
export function shouldOpenLawnReserviceFastComplete(service) {
  return isLawnReserviceFastCompleteEligible(service)
    && !lawnReserviceServerRefuses(service)
    && "propertyId" in service
    && !refusesInvoicedVisit(service);
}

function lawnReserviceServerRefuses(service) {
  const profile = service.completionProfile;
  if (profile.findingsType !== LAWN_FINDINGS_TYPE) return true;
  if (profile.projectBacked || profile.requiresProject || service.linkedProject?.id) return true;
  if ((profile.companions || []).length) return true;
  // Any grouped stop: the server refuses every visit id that is not a
  // dissolved one (grouped_visit), which the row cannot tell apart.
  return !!(service.visitCloseoutPacket || service.visitId || service.visit_id);
}

// A visit returning from the payment flow, or already invoiced.
function returningFromPayment(service) {
  return !!(service?.completionInvoiceAlreadySent || service?.checkoutInvoiceId || service?.checkoutInvoiceToken);
}

// Whether the sheets refuse a visit for its invoice. They do unless the schedule
// row carries GATE_FAST_COMPLETE_INVOICED_VISITS (`invoicedVisitFastCompleteEnabled`,
// exactly true): then the sheet opens, and posts the full form's own
// invoiceAlreadySent (lib/completion-invoice-fields.js), so /complete takes the
// branch the full form's body selects for the same visit.
function refusesInvoicedVisit(service) {
  return returningFromPayment(service) && service?.invoicedVisitFastCompleteEnabled !== true;
}

// Admin Dispatch opens the pest Fast Complete sheet, in its report flow, for the
// regular pest visits and pest re-services the technician home already sends
// there (owner 2026-10-05: the long form was slow for a regular quarterly
// visit). It is the shared pest rule, with this page's guards on top: not a
// typed or combined profile (their forms keep the Dispatch completion panel),
// not a visit returning from the payment flow, and not a row with no
// `propertyId` key (the mobile week list), all on the same terms as the lawn
// sheet above. The sheet's own "Full form" button hands the visit to the full
// form.
export function shouldOpenPestFastComplete(service) {
  const profile = service?.completionProfile;
  return isFastCompleteReportEligible(service)
    && !profile?.findingsType
    && !(profile?.companions || []).length
    && service != null && "propertyId" in service
    && !refusesInvoicedVisit(service);
}

// Admin Dispatch opens the same sheet, in its report flow, for the specialty
// visits the technician home already sends there (owner 2026-10-08: the
// Schedule screen sent every specialty visit to the long form): a lane visit
// under the lane voice fill, or a typed visit the reader reads (a station
// visit only once the station map is known to be off). The shared rules
// already leave out a visit that completes through a project (a WDO
// inspection, a pre-treat), a whole-visit closeout and a closed visit; this
// page's guards go on top, as for the pest sheet above. The sheet's "Full
// form" hands the visit to the Dispatch completion panel.
export function shouldOpenSpecialtyFastComplete(service, { stationMapOff = false } = {}) {
  return (isLaneReportEligible(service) || isTypedReportEligible(service, { stationMapOff }))
    && !(service?.completionProfile?.companions || []).length
    && "propertyId" in service
    && !refusesInvoicedVisit(service);
}

// Which one-screen sheet admin Dispatch opens for a visit, or null for the
// full form. Order matters: a lawn re-service is a typed lawn visit, so it is
// asked first (as on the technician home) and no later rule may claim it.
export function fastCompleteSheetFor(service, { stationMapOff = false } = {}) {
  if (service == null) return null;
  if (shouldOpenLawnReserviceFastComplete(service)) return "lawn_reservice";
  if (shouldOpenTreeShrubFastComplete(service)) return "tree_shrub";
  if (shouldOpenLawnFastComplete(service)) return "lawn";
  if (shouldOpenPestFastComplete(service) || shouldOpenSpecialtyFastComplete(service, { stationMapOff })) return "pest";
  return null;
}
