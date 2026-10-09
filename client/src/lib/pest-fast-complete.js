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
import { carriesAreaAddOnWork } from './areaAddOns';
import { resolveSpecialtyServiceKey } from './service-completion-presets';
import { STATION_TYPE_PROGRAM } from './typed-findings-rules';

const TERMINAL_SERVICE_STATUSES = new Set(['completed', 'cancelled', 'skipped', 'no_show']);

// Pest control services get the lightweight ServiceRecapModal instead of the
// heavy CreateProjectModal. completionProfile.category is the services-table
// backed signal (the schedule API attaches it).
export function isPestControlService(service) {
  return service?.completionProfile?.category === 'pest_control'
    // An area add-on (the web sweep is pest control by family) is generic work, and a
    // visit with an add-on row has work the recap cannot record.
    && !carriesAreaAddOnWork(service);
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

// A visit closed out as a whole (every service on it in one packet).
export function closesOutAsVisit(service) {
  return !!((service?.visitId || service?.visit_id) && (service?.visitCloseoutEnabled || service?.visitCloseoutPacket));
}

// Lane voice fill (GATE_LANE_VOICE_FILL, Fast Complete step 2): a specialty
// visit whose lane the reader reads (bed bug, fire ant, tick, bee & wasp,
// mud dauber, mosquito; the schedule row's `laneVoiceFillEnabled`) opens the
// one-screen sheet in the report flow, its own record read from the note,
// while the report flow is on. Off, it opens the project editor as before,
// and so does a visit that completes through a project (its profile says
// so, a project is already linked, or the profile could not be read).
export function isLaneReportEligible(service) {
  return service?.laneVoiceFillEnabled === true
    && service?.fastCompleteReportEnabled === true
    && completesOnOwnRecord(service);
}
// A visit the report-flow sheet may complete on its own record: open, its
// profile and linked-project reads answered, and not completing through a
// project.
export function completesOnOwnRecord(service) {
  const profile = service?.completionProfile;
  return service?.completionProfileLookupFailed !== true
    && service?.linkedProjectLookupFailed !== true
    && !profile?.projectBacked && !profile?.requiresProject && !service?.linkedProject?.id
    && !TERMINAL_SERVICE_STATUSES.has(String(service?.status || ''));
}
// Typed voice fill (GATE_TYPED_VOICE_FILL, Fast Complete step 3): a typed
// visit whose form the reader reads (cockroach, the roach knockdowns, flea,
// pest inspection, mosquito event, wildlife trapping, rodent exclusion,
// sanitation and inspection; the schedule row's `typedReportFlowEnabled`)
// opens the one-screen sheet in the report flow, its own record read from
// the note, in place of the Dispatch typed form. Off, it opens the typed
// form as before, and so does a visit closed out as a whole visit (its
// packet completes every service on it), a visit that completes through a
// project, a row whose profile or form could not be read, or a closed visit.
// A station visit (termite or rodent bait stations, a trap check) opens the
// sheet only once the tech's station map (station-map-v1) is known to be off:
// with it on, the typed form records a check for every station and the sheet
// carries no map (Codex P1 on #5638).
export function isTypedReportEligible(service, { stationMapOff = false } = {}) {
  const type = service?.completionProfile?.findingsType;
  return service?.typedReportFlowEnabled === true
    && !!type && service?.findingsSchema?.type === type
    && (stationMapOff || !Object.hasOwn(STATION_TYPE_PROGRAM, type))
    && !service?.visitCloseoutPacket && !closesOutAsVisit(service)
    && completesOnOwnRecord(service);
}
// The inspection credit a typed inspection visit offers on the sheet, as the
// office form offers it (SchedulePage isInspectionVisit): an inspection
// profile, or the typed rodent and termite inspection keys, while the
// schedule row says a credit is available. The server re-checks.
export function offersInspectionCredit(service) {
  const profile = service?.completionProfile;
  return (profile?.category === 'inspection' || ['rodent_inspection', 'termite_inspection'].includes(profile?.serviceKey))
    && service?.inspectionCreditAvailable === true;
}
const laneKeyOf = (service) => resolveSpecialtyServiceKey({
  serviceKey: service?.completionProfile?.serviceKey,
  serviceType: service?.serviceTypeRaw || service?.serviceType || service?.service_type,
});

// What the sheet reads of the report flow from the row: whether it runs, for
// a lane visit its lane and for a typed visit its form (each read from the
// note), and no trace on the sheet for either (a trace stays on the full
// form).
export function reportFlowFields(service, { stationMapOff = false } = {}) {
  const laneFlow = isLaneReportEligible(service);
  const typedFlow = isTypedReportEligible(service, { stationMapOff });
  return {
    // A saved report-flow attempt reopens in the report flow whatever the
    // row says now (useSavedFastCompletions).
    reportFlow: service.fastCompletionRecoveryReportFlow === true || isFastCompleteReportEligible(service) || laneFlow || typedFlow,
    laneFlow,
    laneKey: laneFlow ? laneKeyOf(service) : null,
    typedFlow,
    typedType: typedFlow ? service.completionProfile.findingsType : null,
    typedSchema: typedFlow ? service.findingsSchema : null,
    inspectionCredit: typedFlow && offersInspectionCredit(service),
    traceEligible: service.traceEligible !== false && !laneFlow && !typedFlow,
  };
}

// The station map is known to be off: the flags were read from the server and
// `station-map-v1` is off. A load still in flight, or one that failed (the
// hook then answers off, fail closed), is not that answer: a station visit
// keeps the full form, whose map records a check for every station.
export function stationMapKnownOff(stationMap) {
  return stationMap?.ready === true && stationMap?.known === true && stationMap?.enabled === false;
}
