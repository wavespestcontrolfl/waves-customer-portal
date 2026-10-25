/**
 * Service-line map: which technician a service line's visit would go to.
 * SHADOW ONLY (GATE_SERVICE_LINE_MAP=shadow, owner 2026-10-25).
 *
 * A second technician starts early 2027. The new technician is the HOME tech for
 * general pest, rodent and mosquito; the owner is the home tech for lawn / tree &
 * shrub and termite / WDO, and covers every gap (the new tech's days off,
 * absences). service_line_techs holds the home and gap technician per line.
 *
 * THIS RELEASE ONLY RECORDS. Six booking choice points call recordLinePickShadow
 * AFTER their own commit; it resolves what the map would pick and writes one
 * service_line_pick_shadow row next to the technician actually chosen. It never
 * changes a booking and sends nothing. Gate off = no resolver call, no query.
 *
 * Reads only, apart from the one shadow insert. No new eligibility rules: a
 * technician counts as assignable through technician-eligibility (employment
 * active + field dispatchable), absent through technician_absences, off through
 * technicians.work_days (GATE_TECH_WORK_DAYS) and unfit for a line through
 * technician_capabilities.
 */
const defaultDb = require('../../models/db');
const logger = require('../logger');
const featureGates = require('../../config/feature-gates');
const { classifyServiceCategory, CAPABILITY_CATEGORIES } = require('../auto-dispatch/service-category');
const { isAssignable, isOffDay, absentTechDays } = require('../technician-eligibility');
const { stateOf } = require('../technician-capabilities');
const { dateOnlyString } = require('../../utils/datetime-et');
const { commitPromiseOf } = require('../../utils/trx-commit-promise');

// services.category (service library) -> service line. inspection / specialty /
// other / anything unknown has no line of its own: it falls through to the NAME.
const CATALOG_CATEGORY_LINES = Object.freeze({
  pest_control: 'general',
  mosquito: 'mosquito',
  lawn_care: 'lawn',
  tree_shrub: 'lawn',
  rodent: 'rodent',
  termite: 'termite',
  wdo: 'termite',
});

const SOURCES = Object.freeze(['book', 'phone_live', 'after_call', 'estimate_accept', 'office_auto', 'night_run']);
const LINES = CAPABILITY_CATEGORIES;

// Read at call time off the module: this file is loaded under many partial
// feature-gates mocks, and a missing reader must read as "off".
const shadowOn = () => typeof featureGates.serviceLineMapMode === 'function'
  && featureGates.serviceLineMapMode() === 'shadow';

const clean = (value, max = 200) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
};

/**
 * Which service line a visit belongs to: { line, lineFrom }.
 *  1. The catalog row first: services.category, found by `serviceId` (the
 *     scheduled_services.service_id), else by `serviceKey` (services.service_key).
 *     A category that names a line wins, so "Palm Tree Nutritional Treatment"
 *     (tree_shrub) and "Top Dress" (lawn_care) read lawn, which the name alone
 *     (auto-dispatch's classifyServiceCategory falls back to general) gets wrong.
 *  2. Otherwise the NAME, through classifyServiceCategory (unchanged).
 * lineFrom is 'catalog' or 'name'; { line: null, lineFrom: null } when there is
 * neither a usable catalog row nor a service name.
 */
async function serviceLineFor(conn, { serviceId = null, serviceKey = null, serviceType = null } = {}) {
  const db = conn || defaultDb;
  let category = null;
  try {
    let row = null;
    if (serviceId) row = await db('services').where({ id: serviceId }).first('category');
    if (!row && serviceKey) row = await db('services').where({ service_key: String(serviceKey) }).first('category');
    category = row ? String(row.category || '').trim().toLowerCase() : null;
  } catch (err) {
    // An unreadable catalog is not "no catalog": fall to the name, never throw.
    logger.warn(`[line-technician] catalog category lookup failed: ${err.message}`);
  }
  if (category && Object.prototype.hasOwnProperty.call(CATALOG_CATEGORY_LINES, category)) {
    return { line: CATALOG_CATEGORY_LINES[category], lineFrom: 'catalog' };
  }
  const name = clean(serviceType, 300);
  if (name) return { line: classifyServiceCategory(name), lineFrom: 'name' };
  return { line: null, lineFrom: null };
}

/**
 * Why `techId` may not take `line` work on `date`, or null when it may:
 * not_assignable | absent | off_day | capability_off. Reads only.
 */
async function unfitReason(db, techId, line, date, { techs, absent, capabilities }) {
  if (!techId) return 'not_assignable';
  const tech = techs.get(techId);
  if (!isAssignable(tech)) return 'not_assignable';
  if (date && absent.has(`${techId}:${date}`)) return 'absent';
  if (date && isOffDay(tech, date)) return 'off_day';
  if (stateOf(capabilities.get(`${techId}:${line}`) || null) === 'off') return 'capability_off';
  return null;
}

/** What the fit tests read for the home and gap technician: their rows, absences that day, capability for the line. */
async function loadFitContext(db, { ids, line, day }) {
  const techRows = await db('technicians').whereIn('id', ids)
    .select('id', 'name', 'employment_status', 'field_dispatchable', 'work_days');
  const capRows = await db('technician_capabilities').whereIn('technician_id', ids).where({ service_category: line })
    .select('technician_id', 'service_category', 'capability_level', 'active');
  const absent = day
    ? await absentTechDays(db, { dateFrom: day, dateTo: day, technicianIds: ids, includeOffDays: false })
    : new Set();
  return {
    techs: new Map(techRows.map((r) => [r.id, r])),
    absent,
    capabilities: new Map(capRows.map((r) => [`${r.technician_id}:${r.service_category}`, r])),
  };
}

/**
 * What the map would pick: { line, lineFrom, homeId, gapId, technicianId, reason }.
 *   reason: 'home' (the home tech takes it) | gap_off_day | gap_absent |
 *           gap_not_assignable | gap_capability_off (the gap tech takes it; the
 *           suffix is why the home tech could not) | 'none' (neither can) |
 *           'no_map' (no line, or the line has no technician set).
 * `date` is the visit's YYYY-MM-DD ET calendar date; without one the absence and
 * off-day tests are skipped. Reads only; throws only on an unreadable database.
 */
async function resolveLineTechnician(conn, { serviceId = null, serviceKey = null, serviceType = null, date = null } = {}) {
  const db = conn || defaultDb;
  const { line, lineFrom } = await serviceLineFor(db, { serviceId, serviceKey, serviceType });
  const base = { line, lineFrom, homeId: null, gapId: null, technicianId: null, reason: 'no_map' };
  if (!line || !LINES.includes(line)) return base;
  const map = await db('service_line_techs').where({ service_category: line }).first('home_technician_id', 'gap_technician_id');
  const homeId = (map && map.home_technician_id) || null;
  const gapId = (map && map.gap_technician_id) || null;
  if (!homeId && !gapId) return base;

  const day = date ? dateOnlyString(date) : null;
  const ctx = await loadFitContext(db, { ids: [homeId, gapId].filter(Boolean), line, day });

  const homeWhy = await unfitReason(db, homeId, line, day, ctx);
  if (!homeWhy) return { line, lineFrom, homeId, gapId, technicianId: homeId, reason: 'home' };
  if (gapId && gapId !== homeId) {
    const gapWhy = await unfitReason(db, gapId, line, day, ctx);
    if (!gapWhy) return { line, lineFrom, homeId, gapId, technicianId: gapId, reason: `gap_${homeWhy}` };
  }
  return { line, lineFrom, homeId, gapId, technicianId: null, reason: 'none' };
}

/**
 * Whether `technicianId` is free at the visit's time, or null when it cannot be
 * told cheaply: no time, or the multi-tech occupancy scope is off (then the
 * probe is not per technician and "free" would mean "nobody is booked").
 */
async function wouldBeFree(db, { technicianId, date, windowStart, windowEnd, durationMinutes, scheduledServiceId, customerId }) {
  if (!technicianId || !date || !windowStart) return null;
  try {
    const start = String(windowStart).slice(0, 5);
    let end = windowEnd ? String(windowEnd).slice(0, 5) : null;
    if (!end) {
      const [h, m] = start.split(':').map(Number);
      const total = h * 60 + (m || 0) + (Number(durationMinutes) > 0 ? Number(durationMinutes) : 60);
      if (!Number.isFinite(total) || total >= 24 * 60) return null;
      end = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }
    const { technicianFreeAt, pickTechnicianActive } = require('./pick-technician');
    if (!pickTechnicianActive()) return null;
    return !!(await technicianFreeAt({
      conn: db, technicianId, date, windowStart: start, windowEnd: end,
      // The visit being recorded is already saved: it must not read as its own clash.
      excludeServiceIds: scheduledServiceId ? [scheduledServiceId] : [],
      excludeCustomerId: scheduledServiceId ? null : (customerId || null),
    }));
  } catch (err) {
    logger.warn(`[line-technician] free-time check failed (would_free left null): ${err.message}`);
    return null;
  }
}

/**
 * The visit as committed, read from the pool once the caller's transaction ends;
 * null when it is not readable (a rolled-back insert never is).
 */
async function loadCommittedVisit(scheduledServiceId) {
  try {
    return (await defaultDb('scheduled_services').where({ id: scheduledServiceId }).first(
      'customer_id', 'scheduled_date', 'window_start', 'window_end', 'service_id',
      'service_key_snapshot', 'service_type', 'estimated_duration_minutes', 'technician_id',
    )) || null;
  } catch {
    return null;
  }
}

// The estimate accept rewrites a visit after its first save (the combined service's
// identity, duration and capacity window), so a deferred row takes the committed
// visit's own fields over the caller's first-save snapshot.
const withCommittedVisit = (row, visit) => ({
  ...row,
  customerId: visit.customer_id || row.customerId,
  date: visit.scheduled_date || row.date,
  windowStart: visit.window_start || null,
  windowEnd: visit.window_end || null,
  serviceId: visit.service_id || null,
  serviceKey: visit.service_key_snapshot || row.serviceKey || null,
  serviceType: visit.service_type || row.serviceType,
  durationMinutes: visit.estimated_duration_minutes || row.durationMinutes,
  actualTechnicianId: visit.technician_id || null,
});

async function writeShadowRow(row) {
  const db = defaultDb;
  const date = row.date ? dateOnlyString(row.date) : null;
  let pick = null;
  try {
    pick = await resolveLineTechnician(db, {
      serviceId: row.serviceId, serviceKey: row.serviceKey, serviceType: row.serviceType, date,
    });
  } catch (err) {
    logger.warn(`[line-technician] shadow resolve failed: ${err.message}`);
  }
  const wouldFree = pick && pick.technicianId
    ? await wouldBeFree(db, {
      technicianId: pick.technicianId, date, windowStart: row.windowStart, windowEnd: row.windowEnd,
      durationMinutes: row.durationMinutes, scheduledServiceId: row.scheduledServiceId, customerId: row.customerId,
    })
    : null;
  await db('service_line_pick_shadow').insert({
    source: row.source,
    scheduled_service_id: row.scheduledServiceId || null,
    customer_id: row.customerId || null,
    visit_date: date,
    window_start: clean(row.windowStart, 20),
    run_id: clean(row.runId, 80),
    service_type: clean(row.serviceType, 200),
    service_line: pick ? pick.line : null,
    line_from: pick ? pick.lineFrom : null,
    actual_technician_id: row.actualTechnicianId || null,
    would_technician_id: pick ? pick.technicianId : null,
    would_reason: pick ? pick.reason : 'error',
    home_technician_id: pick ? pick.homeId : null,
    would_free: wouldFree,
  });
}

/**
 * Record one shadow row: what was actually chosen, and what the map would pick.
 *
 *   recordLinePickShadow({ source, scheduledServiceId, customerId, date,
 *     windowStart, windowEnd, runId, serviceId, serviceKey, serviceType,
 *     actualTechnicianId, trx })
 *
 * Call it AFTER the caller's commit. `trx` (optional) is the caller's still-open
 * transaction when the choice point sits inside one that outlives the call (the
 * estimate accept): the write then waits for that OUTERMOST commit, is dropped
 * on rollback, and records the visit as committed (the accept rewrites a visit
 * after its first save). The write itself always rides the global pool, never the caller's
 * transaction. Gate off = returns at once, no query. ALWAYS in its own try/catch:
 * it never throws and never changes the caller's result, so callers do not need
 * to await it.
 */
function recordLinePickShadow(row) {
  try {
    if (!shadowOn() || !row || !SOURCES.includes(row.source)) return Promise.resolve(null);
    const run = (fields) => writeShadowRow(fields).then(() => null, (err) => {
      logger.warn(`[line-technician] shadow row not written (${row.source}): ${err.message}`);
      return null;
    });
    const commitPromise = row.trx ? commitPromiseOf(row.trx) : null;
    if (commitPromise) {
      // A transaction that throws rejects this promise, so a failed accept records nothing.
      // A bare trx.rollback() resolves it (knex doNotRejectOnRollback): the visit itself
      // must then be readable from the pool, which a rolled-back insert never is. The row
      // records the visit as committed, not as first saved.
      commitPromise
        .then(() => (row.scheduledServiceId ? loadCommittedVisit(row.scheduledServiceId) : null))
        .then((visit) => {
          if (!row.scheduledServiceId) return run(row);
          return visit ? run(withCommittedVisit(row, visit)) : null;
        })
        .catch(() => {});
      return Promise.resolve(null);
    }
    return run(row);
  } catch (err) {
    try { logger.warn(`[line-technician] shadow recorder failed: ${err.message}`); } catch { /* never throws */ }
    return Promise.resolve(null);
  }
}

module.exports = {
  CATALOG_CATEGORY_LINES,
  SOURCES,
  serviceLineFor,
  resolveLineTechnician,
  recordLinePickShadow,
};
