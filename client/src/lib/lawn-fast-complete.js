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
const TERMINAL_SERVICE_STATUSES = new Set(['completed', 'cancelled', 'skipped', 'no_show']);
const OWN_LANE_SERVICE_KEYS = new Set(['lawn_re_service', 'lawn_inspection']);
// The only typed findings a lawn visit carries.
export const LAWN_FINDINGS_TYPE = 'one_time_lawn_treatment';

export function isLawnFastCompleteEligible(service) {
  const profile = service?.completionProfile;
  return service?.lawnFastCompleteEnabled === true
    && profile?.category === 'lawn_care'
    && !OWN_LANE_SERVICE_KEYS.has(String(profile?.serviceKey || ''))
    && (!profile?.findingsType || profile.findingsType === LAWN_FINDINGS_TYPE)
    && !TERMINAL_SERVICE_STATUSES.has(String(service?.status || ''));
}

// The lawn area the VISIT'S OWN property has saved, from
// GET /admin/schedule/:serviceId/property-areas (`areas.lawn`): a reviewed area,
// or a recorded one (source 'recorded', the property's own recorded size; for the
// primary property the server reads it from the turf profile itself) with a
// positive size. A lookup estimate (source 'imagery' or 'computed', never
// reviewed) is not saved and is never used. null when there is none. The same
// rule as recordedLawnArea() in PR #5901's lib/lawn-completion.js (not on main
// yet); fold the two together once that merges.
export function savedLawnArea(areas) {
  const lawn = areas?.lawn;
  const sqft = Number(lawn?.sqft);
  if (!(sqft > 0)) return null;
  return lawn.reviewedAt || lawn.source === 'recorded' ? sqft : null;
}
