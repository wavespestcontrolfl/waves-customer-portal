/**
 * May this caller move a visit? (GATE_TECH_MOVE_SWITCH, owner 2026-10-25.)
 *
 * The owner sets a "Can move visits" switch per technician in the Team tab
 * (technicians.can_move_visits), the way ServiceTitan gates technician
 * rescheduling: on for a trusted technician, off for a new one until the owner
 * trusts their routing. Off = the technician asks the office to move the visit.
 *
 * Checked by every route a technician can reach that moves a visit or lists the
 * moves it would make: Quick Move in the tech app (tech-track.js), Quick Move
 * and Reschedule from the dispatch routes (admin-dispatch.js), and a call's
 * reschedule proposal card (admin-call-recordings.js preview + apply). The commit
 * routes are the enforcers; the option and preview routes refuse too, so the
 * sheets show the reason instead of choices the commit would refuse.
 *
 * Admins are never refused. Read at call time. Gate off: always allowed, and no
 * query runs (today's behavior). Gate on: a technician with no row, or a row that
 * does not read true, is refused (fail closed).
 */
const db = require('../../models/db');
const { gateEnvValue } = require('../../config/feature-gates');

const MOVE_NOT_ALLOWED = Object.freeze({
  error: 'Ask the office to move this visit.',
  code: 'move_not_allowed',
});

function techMoveSwitchLive() {
  return !!gateEnvValue('GATE_TECH_MOVE_SWITCH');
}

// null = allowed; otherwise { status, payload } for the route to send as is.
// mode 'customer_pick' (GATE_QUICKMOVE_CUSTOMER_PICK, owner 2026-11-01): handing a
// visit to the customer moves nothing by hand, so a technician whose switch is off
// may use that one Quick Move option. Every other mode keeps the switch.
async function techMoveRefusal(req, { conn = db, mode = 'move' } = {}) {
  if (!techMoveSwitchLive() || req?.techRole === 'admin') return null;
  if (mode === 'customer_pick') return null;
  const refused = { status: 403, payload: { ...MOVE_NOT_ALLOWED } };
  if (!req?.technicianId) return refused;
  const row = await conn('technicians').where({ id: req.technicianId }).first('can_move_visits');
  return row && row.can_move_visits === true ? null : refused;
}

module.exports = { techMoveRefusal, techMoveSwitchLive, MOVE_NOT_ALLOWED };
