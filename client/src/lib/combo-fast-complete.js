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
import { completesOnOwnRecord, isFastCompleteReportEligible } from './pest-fast-complete';
import { isLawnFastCompleteEligible } from './lawn-fast-complete';

const COMBO_MEMBER_COUNT = 2;
const TERMINAL = new Set(['completed', 'cancelled', 'skipped', 'no_show']);
const visitIdOf = (service) => service?.visitId || service?.visit_id || null;

// A visit that completes on its own plain record: no typed form, no companion form, no project, no
// lane or station sheet, nothing invoiced or returning from payment, and the profile read answered.
function isPlainMember(service) {
  const profile = service?.completionProfile;
  return !!profile
    && service?.comboFastCompleteEnabled === true
    && completesOnOwnRecord(service)
    && !profile.findingsType
    && !(profile.companions || []).length
    && service?.laneVoiceFillEnabled !== true
    && service?.typedReportFlowEnabled !== true
    && service?.stationFastCompleteEnabled !== true
    && !(service?.completionInvoiceAlreadySent || service?.checkoutInvoiceId || service?.checkoutInvoiceToken);
}

// The stop's two open members as { pest, lawn }, or null.
export function comboMembersFor(service, dayServices) {
  const visitId = visitIdOf(service);
  if (!visitId || !Array.isArray(dayServices)) return null;
  const members = dayServices.filter((row) => visitIdOf(row) === visitId);
  // Exactly two open members: a finished or cancelled sibling would change what the stop owes.
  if (members.length !== COMBO_MEMBER_COUNT || members.some((row) => TERMINAL.has(String(row?.status || '')))) return null;
  if (!members.some((row) => row.id === service.id)) return null;
  if (!members.every(isPlainMember)) return null;
  const pest = members.find((row) => isFastCompleteReportEligible(row) && !isLawnFastCompleteEligible(row));
  const lawn = members.find((row) => isLawnFastCompleteEligible(row) && !isFastCompleteReportEligible(row));
  return pest && lawn && pest !== lawn ? { pest, lawn } : null;
}
