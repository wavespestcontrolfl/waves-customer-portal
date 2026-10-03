/**
 * Technician pick for a visit whose time is already fixed (owner 2026-10-03:
 * "geo located and by availability"; closest route that day, no territories,
 * no new-hire guard).
 *
 * A caller that saves a timed visit with no technician chosen (the after-call
 * booking) asks here who should take it:
 *   1. Who can do it  — assignable, not out that day, capability for the
 *      service not switched off. "Needs review" counts the same as qualified.
 *   2. Who is free    — the window is open on that technician's OWN route:
 *      the save probe itself (occupancy.findConflictingVisits scoped by
 *      technicianId), so the pick and the save can never disagree; and no
 *      schedule block (lunch, hard block, crew-wide) covers the window.
 *   3. Who is closest — the smallest extra drive on that technician's day
 *      (find-time's detour for that exact start). The day's route decides,
 *      not a home address or a territory.
 *   4. Ties (within TIE_MINUTES of the best) — the customer's last
 *      technician, then the lighter day.
 * Nobody free → null: the caller saves the visit unassigned, which blocks the
 * time for everyone until the office assigns it.
 *
 * Active only when the tech-aware save scope is (GATE_MULTI_TECH_CONFIRM +
 * capacity mode, occupancy.techScopedConfirmActive). Otherwise `active` is
 * false and the caller keeps its own default, byte for byte.
 *
 * Reads only. The route estimate spends none of the shared Google allowance
 * (providerTravel: false, the conservative model the save checks with).
 */
const defaultDb = require('../../models/db');
const logger = require('../logger');
const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');
const { applyAssignable, absentTechDays } = require('../technician-eligibility');
const { techScopedConfirmActive, findConflictingVisits } = require('./occupancy');

// Detours this close to the best one are a tie: the estimate is a model, and
// a few minutes of drive is not worth moving a customer off their technician.
const TIE_MINUTES = 5;
const DEFAULT_DURATION_MINUTES = 60;

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : null;
}

function pickTechnicianActive() {
  return techScopedConfirmActive();
}

/**
 * The ONE "is this technician free at this time" answer: the save probe scoped
 * to the technician, plus their schedule blocks. The pick asks it for every
 * candidate; a caller that picked BEFORE taking its locks asks it again under
 * them for the technician it is about to save.
 */
async function technicianFreeAt({
  conn = defaultDb, technicianId, date, windowStart, windowEnd, durationMinutes = DEFAULT_DURATION_MINUTES,
  excludeCustomerId = null, excludeServiceIds = [],
}) {
  const clash = await findConflictingVisits({
    db: conn, date, windowStart, windowEnd, technicianId, excludeCustomerId, excludeServiceIds,
  });
  if (clash.length) return false;
  const startMin = toMinutes(windowStart);
  const endMin = toMinutes(windowEnd) ?? (startMin + durationMinutes);
  return !(await require('../tech-out-auto-move').blockedBySchedule(technicianId, date, startMin, endMin, conn));
}

/** The technician on the customer's most recent completed visit, or null. */
async function lastTechnicianFor(conn, customerId) {
  if (!customerId) return null;
  const row = await conn('scheduled_services')
    .where({ customer_id: customerId, status: 'completed' })
    .whereNotNull('technician_id')
    .orderBy('scheduled_date', 'desc')
    .first('technician_id');
  return row?.technician_id || null;
}

/** Live route stops per technician on the day (the lighter-day tie-break). */
async function stopsByTechnician(conn, date, technicianIds) {
  const rows = await conn('scheduled_services')
    .where('scheduled_date', date)
    .whereIn('technician_id', technicianIds)
    .whereNotIn('status', NOT_A_ROUTE_STOP_STATUSES)
    // The occupancy and route models' own predicates: a windowless
    // placeholder row and an expired estimate hold are not stops.
    .whereNotNull('window_start')
    .where((q) => q.whereNull('reservation_expires_at').orWhere('reservation_expires_at', '>', conn.fn.now()))
    .groupBy('technician_id')
    .select('technician_id')
    .count('* as stops');
  return new Map(rows.map((row) => [row.technician_id, Number(row.stops) || 0]));
}

/**
 * Extra drive minutes per technician for this exact start, from find-time.
 * A technician find-time cannot place (no coordinates, off the hour grid, an
 * unverifiable route) is simply absent from the map: availability still
 * decides, and that technician ranks after every measured one.
 */
async function detourByTechnician({ lat, lng, date, windowStart, durationMinutes, serviceType, excludeServiceIds }) {
  const detours = new Map();
  const startMin = toMinutes(windowStart);
  if (lat == null || lng == null || startMin == null) return detours;
  const { findAvailableSlots } = require('./find-time');
  const result = await findAvailableSlots({
    lat, lng, dateFrom: date, dateTo: date, durationMinutes, serviceType,
    earliestStartMin: startMin, includeWeekends: true, includeBlackoutDates: true,
    providerTravel: false, excludeServiceIds, topN: 500,
  });
  for (const slot of result?.slots || []) {
    if (slot.date !== date || String(slot.start_time).slice(0, 5) !== String(windowStart).slice(0, 5)) continue;
    const id = slot.technician?.id;
    if (!id || !Number.isFinite(slot.detour_minutes)) continue;
    const seen = detours.get(id);
    if (!seen || slot.detour_minutes < seen.detourMinutes) {
      detours.set(id, { detourMinutes: slot.detour_minutes });
    }
  }
  return detours;
}

/** Pure ranking over free candidates. Exported for tests. */
function rankCandidates(candidates, lastTechnicianId) {
  const measured = candidates.filter((c) => Number.isFinite(c.detourMinutes));
  // Unmeasured candidates compete only when nobody was measured.
  const pool = measured.length ? measured : candidates;
  if (!pool.length) return null;
  const best = Math.min(...pool.map((c) => (Number.isFinite(c.detourMinutes) ? c.detourMinutes : 0)));
  const tied = pool.filter((c) => (Number.isFinite(c.detourMinutes) ? c.detourMinutes : 0) - best <= TIE_MINUTES);
  tied.sort((a, b) => (Number(b.id === lastTechnicianId) - Number(a.id === lastTechnicianId))
    || (a.stopsThatDay - b.stopsThatDay)
    || ((a.detourMinutes ?? 0) - (b.detourMinutes ?? 0))
    || String(a.name || '').localeCompare(String(b.name || ''))
    || String(a.id).localeCompare(String(b.id)));
  return tied[0];
}

/**
 * @returns {Promise<{active: boolean, technician: {id, name}|null, reason: string, candidates?: Array}>}
 *   active false → the caller keeps its own default. active true + technician
 *   null → save unassigned (reason: 'none_assignable' | 'none_free').
 */
async function pickTechnicianForVisit({
  conn = defaultDb, date, windowStart, windowEnd, durationMinutes = DEFAULT_DURATION_MINUTES,
  lat = null, lng = null, serviceType = null, customerId = null, excludeServiceIds = [],
  // Whose rows the availability probe skips. Default: the customer's own (a
  // fresh booking, where the caller's same-day guard owns same-customer
  // overlaps — parity with its save probe). A caller assigning an EXISTING
  // row passes null and excludes only that row, so the customer's other
  // visit on a technician's route still counts.
  excludeCustomerId = customerId,
} = {}) {
  if (!pickTechnicianActive()) return { active: false, technician: null, reason: 'gate_off' };
  if (!date || !windowStart || !windowEnd) return { active: false, technician: null, reason: 'no_window' };

  let techs = await applyAssignable(conn('technicians')).select('technicians.id', 'technicians.name');
  if (!techs.length) return { active: true, technician: null, reason: 'none_assignable' };
  const absent = await absentTechDays(conn, { dateFrom: date, dateTo: date, technicianIds: techs.map((t) => t.id) });
  techs = techs.filter((t) => !absent.has(`${t.id}:${date}`));
  if (serviceType && techs.length) {
    const off = await require('../technician-capabilities')
      .inactiveCapabilitiesForServices(conn, techs.map((t) => t.id), [{ service_type: serviceType }]);
    const offIds = new Set(off.map((row) => row.technician_id));
    techs = techs.filter((t) => !offIds.has(t.id));
  }
  if (!techs.length) return { active: true, technician: null, reason: 'none_assignable' };

  // Free = the save probe, scoped to each technician (their rows + unassigned),
  // and no tech_schedule_blocks row over the window. The probe does not model
  // blocks; find-time does, but a blocked technician with no route estimate
  // would otherwise still win the availability-only fallback.
  const free = [];
  for (const tech of techs) {
    if (await technicianFreeAt({
      conn, technicianId: tech.id, date, windowStart, windowEnd, durationMinutes, excludeCustomerId, excludeServiceIds,
    })) free.push(tech);
  }
  if (!free.length) return { active: true, technician: null, reason: 'none_free' };

  let detours = new Map();
  try {
    detours = await detourByTechnician({ lat, lng, date, windowStart, durationMinutes, serviceType, excludeServiceIds });
  } catch (err) {
    // The route estimate only ranks; availability already decided who may
    // take the visit.
    logger.warn(`[pick-technician] route estimate failed (ranking by availability only): ${err.message}`);
  }
  // Counted from the day's rows, not from the route estimate, so the
  // lighter-day tie-break also holds when there is no estimate at all.
  const [lastTechnicianId, stops] = free.length > 1
    ? await Promise.all([lastTechnicianFor(conn, customerId), stopsByTechnician(conn, date, free.map((t) => t.id))])
    : [null, new Map()];
  const candidates = free.map((tech) => ({
    id: tech.id, name: tech.name || null,
    detourMinutes: detours.get(tech.id)?.detourMinutes ?? null,
    stopsThatDay: stops.get(tech.id) || 0,
  }));
  const winner = rankCandidates(candidates, lastTechnicianId);
  return {
    active: true,
    technician: winner ? { id: winner.id, name: winner.name } : null,
    reason: winner ? (Number.isFinite(winner.detourMinutes) ? 'closest_route' : 'availability_only') : 'none_free',
    candidates,
  };
}

module.exports = {
  pickTechnicianForVisit,
  pickTechnicianActive,
  technicianFreeAt,
  TIE_MINUTES,
  _internals: { rankCandidates, detourByTechnician, lastTechnicianFor },
};
