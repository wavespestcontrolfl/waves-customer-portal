'use strict';

/**
 * GATE_COMBO_FAST_COMPLETE (owner 2026-10-09): the pest and lawn Fast Complete sheets used as PARTS
 * of one grouped stop. The lawn Fast Complete routes refuse any grouped member (`grouped_visit`);
 * this is the one server rule that lifts that refusal, and only for a stop the server itself reads
 * as a combined stop. A client can ask (header X-Combo-Stop: 1); only this decides.
 */

const { comboFastCompleteLive } = require('../config/feature-gates');

const COMBO_STOP_HEADER = 'x-combo-stop';
// A combined stop is exactly two open services (one pest, one lawn): the container sheet is built for no more.
const COMBO_STOP_OPEN_MEMBERS = 2;

// Did the request say it is part of a combined stop? Intent only; never an authority.
function comboStopRequested(req) {
  return String(req?.get?.(COMBO_STOP_HEADER) ?? req?.headers?.[COMBO_STOP_HEADER] ?? '') === '1';
}

/**
 * May this grouped member use the lawn Fast Complete routes? The gate is live, and `ask` says which tie:
 *   - { packetContext } (the /complete preflight; the packet's context object, or null/undefined for a plain
 *     /complete): its packetId must be named; the stop is `closing` and that packet row belongs to this stop. A /complete that names
 *     no packet is never allowed.
 *   - { stop: true } (the sheet's reads, before a packet exists): the stop is `open` and has exactly two
 *     open members, this service one of them.
 * `knex` is the caller's connection (the packet's transaction inside /complete).
 */
async function groupedStopAllowed(knex, svc, ask) {
  if (!comboFastCompleteLive() || !svc?.visit_id || !ask) return false;
  const visit = await knex('service_visits').where({ id: svc.visit_id }).first('id', 'status');
  if (!visit) return false;
  if ('packetContext' in ask) {
    const packetId = ask.packetContext?.packetId;
    if (!packetId || String(visit.status || '') !== 'closing') return false;
    return !!(await knex('visit_completion_packets').where({ id: packetId, visit_id: visit.id }).first('id'));
  }
  if (String(visit.status || '') !== 'open') return false;
  const open = await require('./visit-groups').openMembers(knex, visit.id);
  return open.length === COMBO_STOP_OPEN_MEMBERS && open.some((member) => String(member.id) === String(svc.id));
}

// The schedule row's `comboFastCompleteEnabled` (admin-schedule.js): the gate is live and the row belongs to a grouped stop.
function comboRowFlag(row) {
  return comboFastCompleteLive() && !!row?.visit_id;
}

module.exports = { COMBO_STOP_HEADER, comboStopRequested, groupedStopAllowed, comboRowFlag };
