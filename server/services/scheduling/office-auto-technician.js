/**
 * Office "Auto" technician choice (census H5, owner 2026-10-25, GATE_UNASSIGNED_VISIT_GUARD).
 *
 * The create modal defaults the technician to Auto. The route used to ask a
 * `services/tech-matcher` that does not exist, so Auto always saved the visit
 * with no technician, and a visit with no technician shows on no field app.
 * With the guard on, Auto resolves a real technician from the rules that
 * already exist; no new eligibility rule lives here:
 *   1. Who may take it that day: assignable (technician-eligibility:
 *      employment active + field dispatchable), not absent or off that day
 *      (absentTechDays, which adds work days while GATE_TECH_WORK_DAYS is on),
 *      and not switched Off for the visit's service category
 *      (technician_capabilities, the line from line-technician.serviceLineFor).
 *   2. Exactly one → that technician.
 *   3. Several → the existing scheduling pick (pick-technician.js) when it is
 *      active; it never names anyone outside the list from step 1. Otherwise
 *      the office chooses: the visit stays unassigned.
 *   4. Nobody → unassigned.
 * Reads only. Never throws: a failed read is "unassigned, lookup_failed" so the
 * save is never blocked. The caller says so in the response and the modal warns.
 */
const defaultDb = require('../../models/db');
const logger = require('../logger');
const { applyAssignable, absentTechDays } = require('../technician-eligibility');
const { serviceLineFor } = require('./line-technician');
const { stateOf } = require('../technician-capabilities');
const { dateOnlyString } = require('../../utils/datetime-et');

const unassigned = (reason) => ({ technicianId: null, result: 'unassigned', reason });
const assigned = (technicianId, reason) => ({ technicianId, result: 'assigned', reason });

/** The technicians who may take this visit on this day: [{ id, name }]. */
async function assignableTechnicians(conn, { day, serviceId, serviceKey, serviceType }) {
  let techs = await applyAssignable(conn('technicians')).select('technicians.id', 'technicians.name');
  if (!techs.length) return [];
  const absent = await absentTechDays(conn, { dateFrom: day, dateTo: day, technicianIds: techs.map((t) => t.id) });
  techs = techs.filter((t) => !absent.has(`${t.id}:${day}`));
  if (!techs.length) return [];
  const { line } = await serviceLineFor(conn, { serviceId, serviceKey, serviceType });
  if (!line) return techs;
  const rows = await conn('technician_capabilities')
    .whereIn('technician_id', techs.map((t) => t.id)).where({ service_category: line })
    .select('technician_id', 'service_category', 'capability_level', 'active');
  const off = new Set(rows.filter((row) => stateOf(row) === 'off').map((row) => row.technician_id));
  return techs.filter((t) => !off.has(t.id));
}

/**
 * @returns {Promise<{technicianId: string|null, result: 'assigned'|'unassigned', reason: string}>}
 *   reason: only_assignable | scheduling_pick | none_assignable | several_assignable |
 *           none_free | lookup_failed
 */
async function resolveOfficeAutoTechnician({
  conn = defaultDb, date, windowStart, windowEnd, durationMinutes = 60,
  serviceId, serviceKey, serviceType, customerId, lat, lng,
} = {}) {
  try {
    const day = dateOnlyString(date);
    if (!day) return unassigned('lookup_failed');
    const techs = await assignableTechnicians(conn, { day, serviceId, serviceKey, serviceType });
    if (!techs.length) return unassigned('none_assignable');
    if (techs.length === 1) return assigned(techs[0].id, 'only_assignable');

    const picker = require('./pick-technician');
    if (!picker.pickTechnicianActive()) return unassigned('several_assignable');
    const pick = await picker.pickTechnicianForVisit({
      conn, date: day, windowStart, windowEnd, durationMinutes, lat, lng, serviceType, customerId,
    });
    if (!pick.active) return unassigned('several_assignable');
    const pickedId = pick.technician?.id || null;
    if (pickedId && techs.some((t) => t.id === pickedId)) return assigned(pickedId, 'scheduling_pick');
    return unassigned(pickedId ? 'none_assignable' : 'none_free');
  } catch (err) {
    logger.warn(`[office-auto-technician] lookup failed, leaving the visit unassigned: ${err.message}`);
    return unassigned('lookup_failed');
  }
}

module.exports = { resolveOfficeAutoTechnician, _internals: { assignableTechnicians } };
