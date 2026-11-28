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
 * With GATE_SERVICE_LINE_MAP=live, a line that has a home or gap technician set
 * decides first, among the step 1 list (line_home | line_gap | line_none).
 * Reads only. Never throws: a failed read is "unassigned, lookup_failed" so the
 * save is never blocked. The caller says so in the response and the modal warns.
 */
const defaultDb = require('../../models/db');
const logger = require('../logger');
const eligibility = require('../technician-eligibility');
const { applyAssignable, absentTechDays } = eligibility;
const featureGates = require('../../config/feature-gates');
const { serviceLineFor, lineMapLive, pickLineTechnician } = require('./line-technician');
const { stateOf, inactiveCapabilitiesForServices } = require('../technician-capabilities');
const { rowBlockMinutes } = require('./window-rules');
const { dateOnlyString } = require('../../utils/datetime-et');

const shiftHoursLive = () => typeof featureGates.techShiftHoursLive === 'function' && featureGates.techShiftHoursLive();

const unassigned = (reason) => ({ technicianId: null, result: 'unassigned', reason });
const assigned = (technicianId, reason) => ({ technicianId, result: 'assigned', reason });

async function filterTechsByShift(conn, techs, { day, windowStart, windowEnd, durationMinutes }) {
  if (!techs.length || !windowStart || !shiftHoursLive() || typeof eligibility.shiftExcluding !== 'function') return techs;
  const hours = rowBlockMinutes({
    window_start: windowStart,
    window_end: windowEnd,
    estimated_duration_minutes: durationMinutes,
  });
  if (!hours) return techs;
  const kept = [];
  for (const tech of techs) {
    if (!(await eligibility.shiftExcluding(conn, tech.id, day, hours))) kept.push(tech);
  }
  return kept;
}

/** The technicians who may take this visit on this day: [{ id, name }]. */
async function assignableTechnicians(conn, { day, serviceId, serviceKey, serviceType, serviceAddons = [], windowStart = null, windowEnd = null, durationMinutes = 60 }) {
  let techs = await applyAssignable(conn('technicians')).select('technicians.id', 'technicians.name');
  if (!techs.length) return [];
  const absent = await absentTechDays(conn, { dateFrom: day, dateTo: day, technicianIds: techs.map((t) => t.id) });
  techs = techs.filter((t) => !absent.has(`${t.id}:${day}`));
  if (!techs.length) return [];
  techs = await filterTechsByShift(conn, techs, { day, windowStart, windowEnd, durationMinutes });
  if (!techs.length) return [];
  const { line } = await serviceLineFor(conn, { serviceId, serviceKey, serviceType });
  if (line) {
    const rows = await conn('technician_capabilities')
      .whereIn('technician_id', techs.map((t) => t.id)).where({ service_category: line })
      .select('technician_id', 'service_category', 'capability_level', 'active');
    const off = new Set(rows.filter((row) => stateOf(row) === 'off').map((row) => row.technician_id));
    techs = techs.filter((t) => !off.has(t.id));
  }
  if (techs.length && Array.isArray(serviceAddons) && serviceAddons.length) {
    const addonOff = await inactiveCapabilitiesForServices(conn, techs.map((t) => t.id), serviceAddons);
    const addonOffIds = new Set(addonOff.map((row) => row.technician_id));
    techs = techs.filter((t) => !addonOffIds.has(t.id));
  }
  return techs;
}

/**
 * @returns {Promise<{technicianId: string|null, result: 'assigned'|'unassigned', reason: string}>}
 *   reason: only_assignable | scheduling_pick | none_assignable | several_assignable |
 *           none_free | lookup_failed | line_home | line_gap | line_none
 */
async function resolveOfficeAutoTechnician({
  conn = defaultDb, date, windowStart, windowEnd, durationMinutes = 60,
  serviceId, serviceKey, serviceType, serviceAddons, customerId, lat, lng, zip = null,
} = {}) {
  try {
    const day = dateOnlyString(date);
    if (!day) return unassigned('lookup_failed');
    const techs = await assignableTechnicians(conn, { day, serviceId, serviceKey, serviceType, serviceAddons, windowStart, windowEnd, durationMinutes });
    if (!techs.length) return unassigned('none_assignable');

    // Service-line map LIVE: the line's home technician, else its gap technician, among
    // the technicians above. A line with nobody set (or the gate not live) falls through.
    if (lineMapLive()) {
      const line = await pickLineTechnician(conn, {
        serviceId, serviceKey, serviceType, date: day, windowStart, windowEnd, durationMinutes,
        zip, customerId, lat, lng, excludeCustomerId: customerId, candidateIds: techs.map((t) => t.id),
        checkFree: require('./pick-technician').pickTechnicianActive(),
      });
      if (line.mapped) return line.technicianId ? assigned(line.technicianId, line.reason === 'home' ? 'line_home' : 'line_gap') : unassigned('line_none');
    }
    if (techs.length === 1) return assigned(techs[0].id, 'only_assignable');

    const picker = require('./pick-technician');
    if (!picker.pickTechnicianActive()) return unassigned('several_assignable');
    // The catalog identity rides along: the pick reads the line (and capability) catalog
    // first, as step 1 did; by name alone a lawn catalog row such as "Top Dress" reads general.
    const pick = await picker.pickTechnicianForVisit({
      conn, date: day, windowStart, windowEnd, durationMinutes, lat, lng, zip, serviceType, serviceId, serviceKey, serviceAddons, customerId,
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
