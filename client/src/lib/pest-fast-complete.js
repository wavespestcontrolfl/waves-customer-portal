// client/src/lib/pest-fast-complete.js
//
// The one rule for "this pest visit opens the Fast Complete sheet in its report
// flow", used by the technician home page and, since owner 2026-10-05, by admin
// Dispatch (the owner completed a regular quarterly pest visit from Dispatch and
// got the long form). Moved out of TechHomePage so the two surfaces cannot drift.
//
// GATE_FAST_COMPLETE_REPORT (owner "ok go" 2026-10-01): `fastCompleteReportEnabled`
// rides the schedule row, true only while the gate is live and the visit is not a
// combined service or a typed one (server/routes/admin-schedule.js). Off, pest
// visits route exactly as before.
import { isAreaAddOnVisit } from './areaAddOns';

const TERMINAL_SERVICE_STATUSES = new Set(['completed', 'cancelled', 'skipped', 'no_show']);

// Pest control services get the lightweight ServiceRecapModal instead of the
// heavy CreateProjectModal. completionProfile.category is the services-table
// backed signal (the schedule API attaches it).
export function isPestControlService(service) {
  return service?.completionProfile?.category === 'pest_control'
    // An area add-on (the web sweep is pest control by family) is generic work.
    && !isAreaAddOnVisit(service);
}

// With `fastCompleteReportEnabled` on the schedule row, every open untyped pest
// visit, a re-service or a regular visit, opens the one-screen sheet in its
// report flow (talk, generate the AI report, read it, trace, send; billed and
// texted as the full form).
export function isFastCompleteReportEligible(service) {
  return service?.fastCompleteReportEnabled === true
    && isPestControlService(service)
    // The report flow traces a perimeter: a visit traced as an outline (a
    // yard treatment such as tick control, under trace eligibility) keeps its
    // existing path, whose tracer draws that outline (codex local r15).
    && service?.traceVariant !== 'outline'
    // A linked-project lookup that failed is not "no project": the visit
    // keeps its existing path (a lane visit filed under pest control would
    // otherwise fall through to here and complete on its own record).
    && service?.linkedProjectLookupFailed !== true
    // A closed visit stays on the recap editor, which updates the existing
    // record (/complete would answer service_already_completed).
    && !TERMINAL_SERVICE_STATUSES.has(String(service?.status || ''));
}
