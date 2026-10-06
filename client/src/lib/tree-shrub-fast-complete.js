// client/src/lib/tree-shrub-fast-complete.js
//
// The one rule for "this visit completes on the Tree & Shrub Fast Complete
// sheet", shared by the technician home page and admin Dispatch so the two
// surfaces can never disagree.
//
// GATE_TS_FAST_COMPLETE: `treeShrubFastCompleteEnabled` rides the schedule
// payload per service, true only while the gate is live (no per-tech flag,
// owner 2026-10-01). An open tree & shrub visit then opens the one-screen
// sheet instead of the full typed completion form. Flag off, a terminal
// status, or any other service routes exactly as before.
const TERMINAL_SERVICE_STATUSES = new Set(['completed', 'cancelled', 'skipped', 'no_show']);

export function isTreeShrubFastCompleteEligible(service) {
  return service?.treeShrubFastCompleteEnabled === true
    && service?.completionProfile?.findingsType === 'tree_shrub'
    && !TERMINAL_SERVICE_STATUSES.has(String(service?.status || ''));
}
