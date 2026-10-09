// client/src/lib/combo-fast-complete.js
//
// GATE_COMBO_FAST_COMPLETE (owner 2026-10-09): which two services of a grouped stop may close on ONE
// short screen, a pest part and a lawn part. `comboFastCompleteEnabled` rides the schedule row, true
// only while the gate is live and the row belongs to a grouped stop (server/routes/admin-schedule.js).
// This is the first look only: the server stays the authority on membership (the visit-closeout packet
// route, and the lawn context, which refuse a stop that is not exactly this).
//
// The pest and lawn rules are the canonical ones (pest-fast-complete.js, lawn-fast-complete.js). They
// carry no grouped-stop exclusion: Dispatch diverts a grouped stop to the visit closeout before it asks
// them, so using them here is what lifts that exclusion.
import { completesOnOwnRecord, isFastCompleteReportEligible, isReserviceVisit } from './pest-fast-complete';
import { isLawnFastCompleteEligible } from './lawn-fast-complete';
import { resolveSpecialtyServiceKey } from './service-completion-presets';

const COMBO_MEMBER_COUNT = 2;
// The server's TERMINAL_ROW_STATUSES (server/services/visit-context/statuses.js), which its openMembers excludes;
// 'rescheduled' counts as open on both sides. The same four as TERMINAL_VISIT_STATUSES (dispatchCompletionRouting.js)
// and TERMINAL_SERVICE_STATUSES (pest-fast-complete.js): all three agree.
const TERMINAL = new Set(['completed', 'cancelled', 'skipped', 'no_show']);
// The lanes the server's voice-lane reader reads (server/services/visit-lane-facts.js VOICE_LANES): a lane visit
// keeps its own sheet even while the lane voice fill gate (and so `laneVoiceFillEnabled`) is off, and the server
// refuses it as a combo member whatever the gate says. A test pins this list to the server's.
// The server's ASSESSMENT_EXPERIENCE_KEYS (config/completion-lane-registry.js): the lawn rule refuses these as assessment
// visits, and lawn-fast-complete.js's client rule only names lawn_inspection. A test pins this list too.
export const COMBO_ASSESSMENT_KEYS = new Set(['lawn_inspection', 'mosquito_misting_system']);
export const COMBO_LANE_KEYS = new Set(['bed_bug_treatment', 'fire_ant', 'tick_control', 'bee_wasp_removal', 'mud_dauber_removal', 'mosquito']);
const visitIdOf = (service) => service?.visitId || service?.visit_id || null;

// A visit that completes on its own plain record: no typed form, no companion form, no project, no
// lane or station sheet, nothing invoiced or returning from payment, and the profile read answered.
const PLAIN_MEMBER_RULES = [
  (service) => service.comboFastCompleteEnabled === true,
  (service) => completesOnOwnRecord(service),
  (service, profile) => !profile.findingsType,
  (service, profile) => !(profile.companions || []).length,
  (service) => service.laneVoiceFillEnabled !== true,
  (service, profile) => !COMBO_LANE_KEYS.has(resolveSpecialtyServiceKey({ serviceKey: profile.serviceKey, serviceType: service.serviceType || service.service_type })),
  (service) => service.typedReportFlowEnabled !== true,
  (service) => service.stationFastCompleteEnabled !== true,
  (service, profile) => !COMBO_ASSESSMENT_KEYS.has(profile.serviceKey),
  (service) => !(service.completionInvoiceAlreadySent || service.checkoutInvoiceId || service.checkoutInvoiceToken),
];
function isPlainMember(service) {
  const profile = service?.completionProfile;
  return !!profile && PLAIN_MEMBER_RULES.every((rule) => rule(service, profile));
}

// The stop's two open members as { pest, lawn }, or null.
export function comboMembersFor(service, dayServices) {
  const visitId = visitIdOf(service);
  if (!visitId || !Array.isArray(dayServices)) return null;
  // The stop's OPEN members, as the server counts them (openMembers): terminal history rows stay in the feed and
  // are not members here.
  const members = dayServices.filter((row) => visitIdOf(row) === visitId && !TERMINAL.has(String(row?.status || '')));
  if (members.length !== COMBO_MEMBER_COUNT) return null;
  if (!members.some((row) => row.id === service.id)) return null;
  if (!members.every(isPlainMember)) return null;
  // A pest re-service or callback keeps its own recap, review and payment rules: never the pest part (a lawn
  // callback is a lawn visit the lawn rule admits, as on the server).
  const isReservice = (row) => isReserviceVisit({ serviceKey: row.completionProfile?.serviceKey, isCallback: row.isCallback ?? row.is_callback });
  const pest = members.find((row) => isFastCompleteReportEligible(row) && !isLawnFastCompleteEligible(row) && !isReservice(row));
  const lawn = members.find((row) => isLawnFastCompleteEligible(row) && !isFastCompleteReportEligible(row));
  return pest && lawn && pest !== lawn ? { pest, lawn } : null;
}
