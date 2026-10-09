// client/src/lib/lawn-fast-complete.js
//
// The one rule for "this visit may open the lawn Fast Complete sheet", used by
// admin Dispatch (the technician portal is being retired: no tech page uses it).
//
// GATE_LAWN_FAST_COMPLETE: `lawnFastCompleteEnabled` rides the schedule payload
// per service, true only while the gate is live. This is only the first
// look: the sheet then reads GET /admin/dispatch/:id/lawn-fast/context, whose
// `eligible` is the authority, and hands the visit to the full form when the
// server says no. Flag off, a terminal status or any other service line routes
// exactly as before.
//
// Every regular lawn visit type is eligible (owner 2026-10-03). Left out here
// only what has its own lane or sheet: the lawn re-service (own sheet), the
// Waves Assessment visit, and a typed visit whose findings are not the lawn
// ones (Tree & Shrub carries the same lawn_care category).
import { isAreaAddOnVisit } from './areaAddOns';

const TERMINAL_SERVICE_STATUSES = new Set(['completed', 'cancelled', 'skipped', 'no_show']);
const OWN_LANE_SERVICE_KEYS = new Set(['lawn_re_service', 'lawn_inspection']);
// The only typed findings a lawn visit carries.
export const LAWN_FINDINGS_TYPE = 'one_time_lawn_treatment';

export function isLawnFastCompleteEligible(service) {
  const profile = service?.completionProfile;
  return service?.lawnFastCompleteEnabled === true
    && profile?.category === 'lawn_care'
    // An area add-on (lawn care by family) is generic one-time work, not a lawn visit.
    && !isAreaAddOnVisit(service)
    && !OWN_LANE_SERVICE_KEYS.has(String(profile?.serviceKey || ''))
    && (!profile?.findingsType || profile.findingsType === LAWN_FINDINGS_TYPE)
    && !TERMINAL_SERVICE_STATUSES.has(String(service?.status || ''));
}

// Fast Complete for lawn re-services (GATE_LAWN_RESERVICE_FAST_COMPLETE):
// `lawnReserviceFastCompleteEnabled` rides the schedule payload per service. An
// open lawn re-service (completionProfile.serviceKey === 'lawn_re_service', a
// TYPED one_time_lawn_treatment visit) then opens its own one-screen sheet
// instead of the Dispatch completion form. Shared by the technician home and,
// since owner 2026-10-08, admin Dispatch. Gate off, or any other service,
// routes exactly as before.
export function isLawnReserviceFastCompleteEligible(service) {
  return service?.lawnReserviceFastCompleteEnabled === true
    && service?.completionProfile?.serviceKey === 'lawn_re_service'
    && !TERMINAL_SERVICE_STATUSES.has(String(service?.status || ''));
}
