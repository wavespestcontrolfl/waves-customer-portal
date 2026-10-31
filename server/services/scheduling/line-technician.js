/**
 * Service-line map: which technician a service line's visit goes to.
 * GATE_SERVICE_LINE_MAP=shadow records (owner 2026-10-25); =live records AND picks
 * (build 4, owner "DO THIS NOW" 2026-10-30).
 *
 * A second technician starts early 2027. The new technician is the HOME tech for
 * general pest, rodent and mosquito; the owner is the home tech for lawn / tree &
 * shrub and termite / WDO, and covers every gap (the new tech's days off,
 * absences). service_line_techs holds the home and gap technician per line.
 *
 * SHADOW. Six booking choice points call recordLinePickShadow AFTER their own
 * commit; it resolves what the map would pick and writes one
 * service_line_pick_shadow row next to the technician actually chosen. It never
 * changes a booking and sends nothing. Gate off = no resolver call, no query.
 *
 * LIVE keeps those rows and adds two pickers for NEW work, used by their callers
 * only while the gate reads 'live':
 *   - lineOfferRanking: an offer builder (/book, the phone booking recheck)
 *     keeps only a mapped line's home and gap technician's slots, home first
 *     at a start both have.
 *   - pickLineTechnician: one visit whose day is fixed (the after-call booking,
 *     the office Auto choice, the scheduling pick): the home technician when
 *     fit (and free, when asked), else the gap technician, else nobody.
 * A line with no technician set adds no rule: while service_line_techs is empty
 * (as on 2026-10-30) live picks exactly what today's code picks.
 *
 * TERRITORY (GATE_TERRITORY_ROUTING, owner 2026-10-30): each technician owns a ZIP
 * list (territory_zips, services/territory.js). On, a pest, mosquito, rodent or
 * termite line's home technician is the one who owns the visit's ZIP, and the line's
 * own home (else gap) technician covers gaps; lawn keeps the map. It rides the
 * map's own modes: shadow rows record it, live picks follow it. Off, or a ZIP with
 * no territory technician: the map exactly as before.
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
const {
  classifyServiceCategory, categoryForCatalogCategory, CATALOG_CATEGORY_LINES, CAPABILITY_CATEGORIES,
} = require('../auto-dispatch/service-category');
const { isAssignable, isOffDay, absentTechDays } = require('../technician-eligibility');
const { stateOf } = require('../technician-capabilities');
const { dateOnlyString } = require('../../utils/datetime-et');
const { commitPromiseOf } = require('../../utils/trx-commit-promise');
const territory = require('../territory');

const SOURCES = Object.freeze(['book', 'phone_live', 'after_call', 'estimate_accept', 'office_auto', 'night_run']);
const LINES = CAPABILITY_CATEGORIES;

// Read at call time off the module: this file is loaded under many partial
// feature-gates mocks, and a missing reader must read as "off".
const lineMapMode = () => (typeof featureGates.serviceLineMapMode === 'function' ? featureGates.serviceLineMapMode() : 'off');
// Live keeps the shadow rows: the read-out then shows each live pick next to what was saved.
const shadowOn = () => ['shadow', 'live'].includes(lineMapMode());
const lineMapLive = () => lineMapMode() === 'live';
const territoryOn = () => (typeof featureGates.territoryRoutingLive === 'function' ? featureGates.territoryRoutingLive() : false);
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/** The place fields a picker's caller passes: { zip, lat, lng, customerId }. */
const placeOf = (opts = {}) => ({
  zip: opts.zip || null, lat: opts.lat ?? null, lng: opts.lng ?? null, customerId: opts.customerId || null,
});

/**
 * The technician who owns the place's territory, or null: gate off, no place, a ZIP
 * with no territory technician, or an unreadable territory (logged; the map alone
 * decides then).
 */
async function territoryTechnicianOf(db, place) {
  if (!territoryOn() || !place) return null;
  try {
    return await territory.territoryTechnicianFor(db, place);
  } catch (err) {
    logger.warn(`[line-technician] territory read failed (the line map alone decides): ${err.message}`);
    return null;
  }
}

/**
 * A line's { homeId, gapId } with the territory laid over it. On a territory line the
 * territory technician is the home, and the gap is the line's own home, else its gap,
 * when that is someone else. Any other line, or no territory technician: `entry`
 * unchanged (null = the line has no technician set).
 */
function withTerritory(entry, line, territoryTechId) {
  if (!territoryTechId || !territory.TERRITORY_LINES.includes(line)) return entry;
  const cover = entry ? [entry.homeId, entry.gapId].find((id) => id && !sameId(id, territoryTechId)) : null;
  return { homeId: territoryTechId, gapId: cover || null };
}

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
  const catalogLine = categoryForCatalogCategory(category);
  if (catalogLine) return { line: catalogLine, lineFrom: 'catalog' };
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
 * One line's { homeId, gapId } as the shadow resolver reads it (its own single-row read),
 * with the place's territory laid over it; null when nobody is set.
 */
async function shadowLineEntry(db, line, place) {
  const row = await db('service_line_techs').where({ service_category: line }).first('home_technician_id', 'gap_technician_id');
  const mapped = row && (row.home_technician_id || row.gap_technician_id)
    ? { homeId: row.home_technician_id || null, gapId: row.gap_technician_id || null } : null;
  return withTerritory(mapped, line, await territoryTechnicianOf(db, place));
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
async function resolveLineTechnician(conn, { serviceId = null, serviceKey = null, serviceType = null, date = null, place = null } = {}) {
  const db = conn || defaultDb;
  const { line, lineFrom } = await serviceLineFor(db, { serviceId, serviceKey, serviceType });
  const base = { line, lineFrom, homeId: null, gapId: null, technicianId: null, reason: 'no_map' };
  if (!line || !LINES.includes(line)) return base;
  const entry = await shadowLineEntry(db, line, place);
  if (!entry) return base;
  const { homeId, gapId } = entry;

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
/** HH:MM end of a window: its own end, else start + duration (60 by default); null past midnight. */
function windowEndOf(start, windowEnd, durationMinutes) {
  if (windowEnd) return String(windowEnd).slice(0, 5);
  const [h, m] = start.split(':').map(Number);
  const total = h * 60 + (m || 0) + (Number(durationMinutes) > 0 ? Number(durationMinutes) : 60);
  if (!Number.isFinite(total) || total >= 24 * 60) return null;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

async function wouldBeFree(db, { technicianId, date, windowStart, windowEnd, durationMinutes, scheduledServiceId, customerId }) {
  if (!technicianId || !date || !windowStart) return null;
  try {
    const start = String(windowStart).slice(0, 5);
    const end = windowEndOf(start, windowEnd, durationMinutes);
    if (!end) return null;
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
 * The home and gap technician per line, for the lines that have either set:
 * Map(line -> { homeId, gapId }). A gap equal to the home counts once (home).
 */
async function loadLineMap(db, lines) {
  const wanted = [...new Set((lines || []).filter((line) => LINES.includes(line)))];
  if (!wanted.length) return new Map();
  const rows = await db('service_line_techs').whereIn('service_category', wanted)
    .select('service_category', 'home_technician_id', 'gap_technician_id');
  const map = new Map();
  for (const row of rows) {
    const homeId = row.home_technician_id || null;
    const gapId = row.gap_technician_id && !sameId(row.gap_technician_id, homeId) ? row.gap_technician_id : null;
    if (homeId || gapId) map.set(row.service_category, { homeId, gapId });
  }
  return map;
}

/**
 * LIVE (GATE_SERVICE_LINE_MAP=live): how an offer builder ranks each technician's
 * slots for work on `lines` (capability categories: ['general'], or
 * ['general', 'lawn'] for a two-service booking).
 *
 * null when the gate is not live, or when none of `lines` has a technician set:
 * the builder then offers exactly what it offers today. Otherwise
 * { lines, rankOf }, where rankOf(technicianId) is
 *   - null: drop this technician's slots (not the home or gap technician of
 *     EVERY mapped line, or switched Off for one of them);
 *   - 0, 1, ...: keep. Lower wins a date and start two technicians both have:
 *     the count of mapped lines this technician covers only as the gap.
 * A line with no technician set adds no rule. Day rules (absent, off day, not
 * assignable) stay with the slot finders, which never build a slot on such a
 * day, so the gap technician's slots fill exactly the starts the home technician
 * has none for: the owner's "i cover all gaps the tech cant fullfill" (2026-10-25).
 * Reads only; throws only on an unreadable database.
 */
async function lineOfferRanking(conn, { lines = [], place = null } = {}) {
  if (!lineMapLive()) return null;
  const db = conn || defaultDb;
  const map = await loadLineMap(db, lines);
  const territoryTechId = await territoryTechnicianOf(db, place);
  for (const line of new Set((lines || []).filter((value) => LINES.includes(value)))) {
    const entry = withTerritory(map.get(line) || null, line, territoryTechId);
    if (entry) map.set(line, entry);
  }
  if (!map.size) return null;
  const ids = [...new Set([...map.values()].flatMap(({ homeId, gapId }) => [homeId, gapId]).filter(Boolean))];
  const capRows = await db('technician_capabilities').whereIn('technician_id', ids).whereIn('service_category', [...map.keys()])
    .select('technician_id', 'service_category', 'capability_level', 'active');
  const off = new Set(capRows.filter((row) => stateOf(row) === 'off').map((row) => `${row.technician_id}:${row.service_category}`));
  const rankOf = (technicianId) => {
    if (technicianId == null || technicianId === '') return null;
    let rank = 0;
    for (const [line, { homeId, gapId }] of map) {
      if (off.has(`${technicianId}:${line}`)) return null;
      if (sameId(technicianId, homeId)) continue;
      if (!sameId(technicianId, gapId)) return null;
      rank += 1;
    }
    return rank;
  };
  return { lines: [...map.keys()], rankOf };
}

/**
 * LIVE (GATE_SERVICE_LINE_MAP=live): the line's technician for ONE visit whose
 * day (and maybe time) is already fixed.
 *
 * { mapped: false, line, technicianId: null, reason } when the gate is not live
 * ('off'), or the visit has no line or its line has no technician set
 * ('no_map'): the caller keeps today's choice. Otherwise
 * { mapped: true, line, technicianId, reason }:
 *   'home'       the home technician takes it;
 *   'gap_<why>'  the gap technician takes it; <why> is why the home technician
 *                could not: not_assignable | absent | off_day | capability_off |
 *                busy | not_listed | unset (the line has no home technician);
 *   'none'       neither can: technicianId null, and the caller takes its own
 *                "nobody" path (the visit is saved unassigned).
 * A Waves Assessment is { mapped: false, reason: 'assessment' } (isAssessmentIdentity).
 * A technician is tried only when fit (unfitReason) and, when `candidateIds` is
 * given, listed in it (the caller's own eligible list). `checkFree` adds the
 * save probe (pick-technician.technicianFreeAt) for a visit with a time; a
 * caller passes it only while that probe is per technician. Reads only; throws
 * only on an unreadable database.
 */
async function pickLineTechnician(conn, opts = {}) {
  if (!lineMapLive()) return { mapped: false, line: null, technicianId: null, reason: 'off' };
  const db = conn || defaultDb;
  const identity = { serviceId: opts.serviceId, serviceKey: opts.serviceKey, serviceType: opts.serviceType };
  if (await isAssessmentIdentity(db, identity)) return { mapped: false, line: null, technicianId: null, reason: 'assessment' };
  const { line } = await serviceLineFor(db, identity);
  const mapEntry = line ? (await loadLineMap(db, [line])).get(line) || null : null;
  const entry = line ? withTerritory(mapEntry, line, await territoryTechnicianOf(db, placeOf(opts))) : null;
  if (!entry) return { mapped: false, line, technicianId: null, reason: 'no_map' };

  const day = opts.date ? dateOnlyString(opts.date) : null;
  const order = [entry.homeId, entry.gapId].filter(Boolean);
  const test = {
    line,
    day,
    ctx: await loadFitContext(db, { ids: order, line, day }),
    listed: Array.isArray(opts.candidateIds) ? new Set(opts.candidateIds.map(String)) : null,
    probe: opts.checkFree ? freeProbeFor(day, opts) : null,
  };
  let homeWhy = entry.homeId ? null : 'unset';
  for (const id of order) {
    const why = await whyNotPicked(db, id, test);
    if (!why) return { mapped: true, line, technicianId: id, reason: sameId(id, entry.homeId) ? 'home' : `gap_${homeWhy}` };
    if (sameId(id, entry.homeId)) homeWhy = why;
  }
  return { mapped: true, line, technicianId: null, reason: 'none' };
}

/**
 * Whether the visit is a Waves Assessment: the free sales visit (catalog key
 * lawn_inspection, name "Waves Assessment"; services/assessment-booking.js).
 * Live mode routes no assessment: which line an inspection belongs to is still
 * an open owner decision (build-4 trace, decision 1), and the name alone reads
 * general pest, which would hand a sales visit to the new pest technician. The
 * caller keeps today's choice for it. An unreadable catalog row reads "no".
 */
async function isAssessmentIdentity(db, { serviceId = null, serviceKey = null, serviceType = null } = {}) {
  const { ASSESSMENT_SERVICE_KEY, isAssessmentServiceType, isAssessmentServiceRow } = require('../assessment-booking');
  if (serviceKey === ASSESSMENT_SERVICE_KEY || isAssessmentServiceType(serviceType)) return true;
  if (!serviceId) return false;
  try {
    return isAssessmentServiceRow(await db('services').where({ id: serviceId }).first('service_key', 'name'));
  } catch (err) {
    logger.warn(`[line-technician] assessment lookup failed (read as not an assessment): ${err.message}`);
    return false;
  }
}

/**
 * LIVE: the line a booked service routes by, or null (no line rule): a Waves
 * Assessment belongs to no line (isAssessmentIdentity); otherwise serviceLineFor.
 */
async function liveServiceLine(conn, identity = {}) {
  const db = conn || defaultDb;
  if (await isAssessmentIdentity(db, identity)) return null;
  return (await serviceLineFor(db, identity)).line;
}

/** The save-probe arguments for a visit with a day and a start, or null (no probe). */
function freeProbeFor(day, { windowStart, windowEnd, durationMinutes, excludeCustomerId, excludeServiceIds }) {
  const start = windowStart ? String(windowStart).slice(0, 5) : null;
  const end = start ? windowEndOf(start, windowEnd, durationMinutes) : null;
  if (!day || !start || !end) return null;
  return { date: day, windowStart: start, windowEnd: end, excludeCustomerId: excludeCustomerId || null, excludeServiceIds: excludeServiceIds || [] };
}

/** Why `id` cannot take the visit, or null: the fit test, the caller's list, then the save probe when asked. */
async function whyNotPicked(db, id, { line, day, ctx, listed, probe }) {
  const unfit = await unfitReason(db, id, line, day, ctx);
  if (unfit) return unfit;
  if (listed && !listed.has(String(id))) return 'not_listed';
  if (!probe) return null;
  const { technicianFreeAt } = require('./pick-technician');
  return (await technicianFreeAt({ ...probe, conn: db, technicianId: id })) ? null : 'busy';
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

/**
 * A shadow row's territory place, read only while GATE_TERRITORY_ROUTING is on: the saved
 * visit's own service ZIP and map position (a multi-property customer's other property
 * must not read as the main one), with the customer row as the last fallback.
 */
async function shadowPlace(db, row) {
  if (!territoryOn()) return null;
  let visit = null;
  if (row.scheduledServiceId) {
    try {
      visit = await db('scheduled_services').where({ id: row.scheduledServiceId }).first('service_address_zip', 'lat', 'lng');
    } catch (err) {
      logger.warn(`[line-technician] shadow visit place unreadable (customer row used): ${err.message}`);
    }
  }
  return {
    zip: (visit && visit.service_address_zip) || null,
    lat: visit ? visit.lat : null,
    lng: visit ? visit.lng : null,
    customerId: row.customerId || null,
  };
}

async function writeShadowRow(row) {
  const db = defaultDb;
  const date = row.date ? dateOnlyString(row.date) : null;
  let pick = null;
  try {
    pick = await resolveLineTechnician(db, {
      serviceId: row.serviceId, serviceKey: row.serviceKey, serviceType: row.serviceType, date,
      place: await shadowPlace(db, row),
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
  lineMapLive,
  lineOfferRanking,
  pickLineTechnician,
  liveServiceLine,
  _internals: { loadLineMap, windowEndOf, isAssessmentIdentity, withTerritory, shadowPlace },
};
