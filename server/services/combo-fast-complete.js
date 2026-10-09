'use strict';

/**
 * GATE_COMBO_FAST_COMPLETE (owner 2026-10-09): the pest and lawn Fast Complete sheets used as PARTS
 * of one grouped stop. The lawn Fast Complete routes refuse any grouped member (`grouped_visit`);
 * this is the one server rule that lifts that refusal, and only for a stop the server itself reads
 * as a combined stop: exactly one pest member the pest report flow admits and exactly one lawn
 * member the lawn Fast Complete rule admits. A client can ask (header X-Combo-Stop: 1); only this decides.
 */

const { comboFastCompleteLive, fastCompleteReportLive } = require('../config/feature-gates');

const COMBO_STOP_HEADER = 'x-combo-stop';
// A combined stop is exactly two open services (one pest, one lawn): the container sheet is built for no more.
const COMBO_STOP_MEMBERS = 2;
const LAWN_REASONS_SET_ASIDE = [null, 'grouped_visit'];

// Did the request say it is part of a combined stop? Intent only; never an authority.
function comboStopRequested(req) {
  return String(req?.get?.(COMBO_STOP_HEADER) ?? req?.headers?.[COMBO_STOP_HEADER] ?? '') === '1';
}

// The ONE lawn-fast grouped ask of a request: spread into the options of any lawn-fast eligibility read, so a
// route cannot forget the header. Empty for a request that did not ask.
function lawnFastGroupedAsk(req) {
  return comboStopRequested(req) ? { allowGrouped: { stop: true } } : {};
}

// The profile shape the pest report flow needs, gate aside: an untyped visit with no companion form. The schedule
// payload's `fastCompleteReportEnabled` is this plus the report-flow gate.
function reportFlowShape(profile) {
  return !(profile?.companions || []).length && !profile?.findingsType;
}

// A pest re-service: the pest re-service itself, or a free callback (the same rule as the pest sheet's
// isReserviceVisit in client/src/lib/pest-fast-complete.js; a drift test pins them together).
function isPestReservice(profile, isCallback) {
  return profile?.serviceKey === 'pest_re_service' || isCallback === true;
}

// A pest visit the plain pest report flow admits (gate aside): pest control, reportFlowShape, not a re-service or
// callback, not completed through a project, and not a lane visit (the lane voice fill's own reader,
// visit-lane-facts voiceLaneFor).
function pestReportFlowAdmits(profile, serviceType, isCallback) {
  return profile?.category === 'pest_control' && reportFlowShape(profile) && !isPestReservice(profile, isCallback)
    && !profile.projectBacked && !profile.requiresProject
    && require('./visit-lane-facts').voiceLaneFor({ profile, serviceType }) == null;
}

// Does any invoice already hang on these members? The mint's own `existing_member_invoice` predicate
// (visit-completion-invoice.js linkedMemberInvoices); a failed read counts as invoiced (fail closed).
async function membersInvoiced(knex, memberIds) {
  const { linkedMemberInvoices } = require('./visit-completion-invoice');
  const found = await linkedMemberInvoices(knex, memberIds.map((id) => ({ id, record_id: null }))).first('id').catch(() => ({}));
  return !!found;
}

// Exactly one pest member and one lawn member, each judged by the canonical server rule: the pest report flow
// above, and resolveLawnFastEligibility (the grouped reason set aside; no recursion: it is called without a
// grouped ask). The pest report flow gate is read live (the kill switch holds against a stale client), and no
// invoice may hang on either member yet (an invoiced stop is the long closeout form's). Reads per member.
async function pairAdmitted(knex, memberIds, allowStatuses) {
  if (memberIds.length !== COMBO_STOP_MEMBERS || !fastCompleteReportLive()) return false;
  const { resolveLawnFastEligibility } = require('./lawn-fast-complete');
  const { serviceHasLinkedProject } = require('./pest-recap');
  // Two reads per member on the caller's connection: the eligibility/profile read, and the project link (the office
  // may link a project after the schedule loaded; a failed read counts as linked).
  const [verdicts, linked] = await Promise.all([
    Promise.all(memberIds.map((id) => resolveLawnFastEligibility(id, knex, { withVisitType: false, allowStatuses }))),
    Promise.all(memberIds.map((id) => serviceHasLinkedProject(id, knex))),
  ]);
  if (verdicts.some((verdict) => !verdict.ok) || linked.some(Boolean)) return false;
  if (await membersInvoiced(knex, memberIds)) return false;
  const lawn = verdicts.filter((verdict) => verdict.profile?.category === 'lawn_care' && LAWN_REASONS_SET_ASIDE.includes(verdict.reason));
  const pest = verdicts.filter((verdict) => pestReportFlowAdmits(verdict.profile, verdict.svc?.service_type, verdict.svc?.is_callback));
  return lawn.length === 1 && pest.length === 1;
}

/**
 * May this grouped member use the lawn Fast Complete routes? The gate is live, `ask` says which tie, and the
 * stop's two members are a pest/lawn pair the server's own rules admit:
 *   - { packetContext } (the /complete preflight; the packet's context object, or null/undefined for a plain
 *     /complete): its packetId must be named; the stop is `closing`, that packet row belongs to this stop, and the
 *     packet's frozen items are the pair.
 *   - { stop: true } (the sheet's reads, before a packet exists): the stop is `open` and its two open members, this
 *     service one of them, are the pair.
 * `knex` is the caller's connection (the packet's transaction inside /complete).
 */
async function groupedStopAllowed(knex, svc, ask) {
  if (!comboFastCompleteLive() || !svc?.visit_id || !ask) return false;
  const visit = await knex('service_visits').where({ id: svc.visit_id }).first('id', 'status');
  if (!visit) return false;
  if ('packetContext' in ask) {
    const packetId = ask.packetContext?.packetId;
    if (!packetId || String(visit.status || '') !== 'closing') return false;
    const packet = await knex('visit_completion_packets').where({ id: packetId, visit_id: visit.id }).first('id', 'payload');
    const payload = typeof packet?.payload === 'string' ? JSON.parse(packet.payload) : packet?.payload;
    const ids = (payload?.items || []).map((item) => String(item.serviceId));
    // Earlier items of this packet are already completed inside it.
    return ids.includes(String(svc.id)) && pairAdmitted(knex, ids, ['completed']);
  }
  if (String(visit.status || '') !== 'open') return false;
  const open = (await require('./visit-groups').openMembers(knex, visit.id)).map((member) => String(member.id));
  return open.includes(String(svc.id)) && pairAdmitted(knex, open);
}

// The schedule row's `comboFastCompleteEnabled` (admin-schedule.js): the gate is live and the row belongs to a grouped stop.
function comboRowFlag(row) {
  return comboFastCompleteLive() && !!row?.visit_id;
}

module.exports = { COMBO_STOP_HEADER, comboStopRequested, lawnFastGroupedAsk, reportFlowShape, isPestReservice, pestReportFlowAdmits, groupedStopAllowed, comboRowFlag };
