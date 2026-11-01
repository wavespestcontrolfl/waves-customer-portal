/**
 * Staff appointment placement within the EXISTING two-hour arrival promises.
 * Extends the route-reorder simulation; never changes other visits' windows,
 * service durations, or customer communications. Capacity writers certify
 * insertion orders and persist them with an audit inside the occupancy lock.
 */
const db = require('../../models/db');
const logger = require('../logger');
const RouteOptimizer = require('../route-optimizer');
const { loadTechStartPoint } = require('./tech-start-point');
const { gateEnvValue, multiTechConfirmLive, routeOrderTimeFallbackLive } = require('../../config/feature-gates');
const { etDateString, etParts } = require('../../utils/datetime-et');
const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');
const { TERMINAL_ROW_STATUSES } = require('../visit-context/statuses');
const { dayStopsQuery, guardedCoordSelects, serviceLocationSelects, resolveServiceLocation } = require('./day-stops');
const { currentOrder, effectiveWindowRange, simulateArrivalRoute, workDuration,
  staleOrderReasons, promisedWindowOrder } = require('../route-reorder-window-fit');
const { SHIFT, capacityEnabled, placementFitsShift } = require('./policy');
const { placedVisitMinutes } = require('./planning-minutes');
const { allocationKey, occupiedRows } = require('./visit-capacity');
const warningDetail = require('./route-warning-detail');
const { timeFallbackOrder } = require('./route-order-time-fallback');

/** The customer's primary premise, aliased the way effectivePremise (and
 *  stampedAddressDiverges) expect. Every query that feeds the co-visit merge
 *  selects these. */
const CUSTOMER_PREMISE_ALIASES = [{
  customer_address_line1: 'customers.address_line1',
  customer_address_line2: 'customers.address_line2',
  customer_city: 'customers.city',
  customer_state: 'customers.state',
  customer_zip: 'customers.zip',
}];

const COLUMNS = [
  'id', 'customer_id', 'technician_id', 'scheduled_date', 'window_start', 'window_end',
  'estimated_duration_minutes', 'status', 'route_order', 'created_at', 'visit_id',
  'reservation_expires_at', 'actual_end_time', 'check_out_time', 'completed_at', 'time_window',
  'service_type', 'service_id', 'source_estimate_id', 'updated_at',
  // Premise identity for the co-visit merge — premiseStampConflicts reads
  // all four (street, unit, zip, city).
  'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip',
  'reservation_service_mix', 'reservation_policy_version',
  // Planning-minute inputs (planning-minutes.js), with service_type above.
  'is_recurring', 'is_callback',
];

function arrivalWindowRoutingEnabled() {
  return gateEnvValue('GATE_ADMIN_ARRIVAL_WINDOWS') || capacityEnabled();
}

function dateOnly(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value || '').slice(0, 10);
}

function minuteOfDay(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function hhmm(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`;
}

function hasCoords(stop) {
  return stop?.lat != null && stop?.lng != null
    && Number.isFinite(Number(stop.lat)) && Number.isFinite(Number(stop.lng))
    && Number(stop.lat) !== 0 && Number(stop.lng) !== 0;
}

/** GATE_COMBO_ROUTE_CHECK: dark unless set, read at call time. On, a caller
 *  that moves a WHOLE visit (`unit: true`) gets the visit placed as one stop
 *  instead of `route_unverified`, and a caller that separates one service
 *  first (`alone: true`) gets that service checked as a single visit. Off,
 *  both are ignored: byte-identical. */
function comboRouteCheckLive() {
  return gateEnvValue('GATE_COMBO_ROUTE_CHECK');
}

/** GATE_STAFF_ROUTE_INSERTION (owner 2026-10-25, "go" + "save order"): dark
 *  unless set, read at call time, capacity mode off only. On, a staff check of
 *  a MOVED visit tries it at every place in the technician's stored order
 *  instead of after the last numbered stop, and the save numbers the day in
 *  the certified order (placeMovedVisit). Off: byte-identical. */
function staffRouteInsertionLive() {
  return gateEnvValue('GATE_STAFF_ROUTE_INSERTION');
}

// A moved visit goes in ahead of a stop only when that stop still arrives at
// least this long before its window closes: the drive model is off by about
// 4 minutes a leg (route-optimizer.js), so a 2-minute fit on paper is not a
// fit (owner 2026-10-25).
const INSERTION_MARGIN_MINUTES = 15;

/** Where a check stands under GATE_STAFF_ROUTE_INSERTION: 'move' for a new
 *  visit, the save writer's own placement (`place`), or another day,
 *  technician or start than the saved row; 'saved' for the visit where it is
 *  saved; null for a hand-built context with no saved place (the gap tool),
 *  which keeps the saved order. */
function staffPlacement(context, place, date, technicianId, windowStart) {
  if (place || context.prospective) return 'move';
  const at = context.placedAt;
  if (!at) return null;
  return at.date !== date || at.technicianId !== (technicianId || null)
    || at.windowStart !== String(windowStart || '').slice(0, 5) ? 'move' : 'saved';
}

/** The whole visit as ONE target: the tapped row carrying its members'
 *  summed work (the sum groupRouteStops uses for every other stop, exempt
 *  from owner planning minutes like any target) and their ids. Null when the
 *  members are not one clean stop — a different technician, different or
 *  missing coordinates, another day, a member already under way, or members
 *  promised different arrival times (the unit mover keeps each member's
 *  offset, and one target window cannot stand for staggered promises) — and
 *  the caller keeps today's answer (`grouped` → route_unverified). */
function foldVisitUnit(target, stored, siblings) {
  const underWay = row => ['en_route', 'on_site'].includes(row.status);
  // Every member needs an arrival promise: a windowless one has nothing to
  // share, and the day's rows drop windowless stops under capacity.
  const clean = hasCoords(target) && !underWay(stored) && !!stored.window_start && siblings.every(row => (row.technician_id || null) === (stored.technician_id || null)
    && dateOnly(row.scheduled_date) === dateOnly(stored.scheduled_date)
    && hasCoords(row) && Number(row.lat) === Number(target.lat) && Number(row.lng) === Number(target.lng)
    && String(row.window_start || '').slice(0, 5) === String(stored.window_start || '').slice(0, 5)
    && !underWay(row));
  if (!clean) return null;
  // The tapped member keeps its own row untouched: its work is resolved per
  // candidate window by buildPlacementTarget, exactly as for a visit alone
  // (so the offered hours and the picked-hour verdict agree, and a pending
  // length change counts). The siblings' work is added there. Every member's service is kept for the technician capability
  // checks, which must cover the whole combo.
  return {
    ...target,
    memberIds: [stored.id, ...siblings.map(row => row.id)],
    // workDuration as groupRouteStops calls it for any member of a stop:
    // owner planning minutes apply to the siblings; only the tapped row is
    // exempt, as every target is.
    siblingWorkMinutes: siblings.reduce((sum, row) => sum + workDuration(row), 0),
    memberServices: [target, ...siblings].map(row => ({ service_type: row.service_type, service_id: row.service_id })),
  };
}

/** The target's live siblings on its visit, located the way the target is. */
async function loadVisitSiblings(conn, target, serviceId) {
  const rows = await conn('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .where('scheduled_services.visit_id', target.visit_id)
    .whereNot('scheduled_services.id', serviceId)
    .whereNotIn('scheduled_services.status', TERMINAL_ROW_STATUSES)
    .select(...COLUMNS.map(c => `scheduled_services.${c}`), ...serviceLocationSelects(conn), ...CUSTOMER_PREMISE_ALIASES);
  return Promise.all(rows.map(async (row) => {
    const location = await resolveServiceLocation(row, undefined, { cacheOnly: conn.isTransaction === true });
    return { ...row, lat: location.lat, lng: location.lng };
  }));
}

/** What a grouped target becomes for a caller that says how it moves: the
 *  whole visit as one target (`unit`), the tapped service split off
 *  (`alone`), or null — gate off, neither asked, or not certifiable — which
 *  leaves it `grouped`. */
async function resolveMovedVisitTarget(conn, { target, stored, serviceId, unit, alone }) {
  if (!comboRouteCheckLive()) return null;
  if (unit) return foldVisitUnit(target, stored, await loadVisitSiblings(conn, target, serviceId));
  return alone ? resolveSeparatedTarget(conn, target, serviceId) : null;
}

/** The tapped service as a single visit once it is split off, or null (gate
 *  off, or the visit would still hold two or more services afterwards: the
 *  remainder is then a shared stop of its own, which this check does not
 *  model, so the answer stays unverified). It carries its own service as
 *  `memberServices`, so the technician capability checks cover it. */
async function resolveSeparatedTarget(conn, target, serviceId) {
  const others = await conn('scheduled_services').where({ visit_id: target.visit_id })
    .whereNot('id', serviceId).whereNotIn('status', TERMINAL_ROW_STATUSES).select('id');
  if (others.length !== 1) return null;
  return { ...target, memberServices: [{ service_type: target.service_type, service_id: target.service_id }] };
}

// planningMinutes false (loadArrivalRouteContext): every stop on the route
// keeps its own window/estimate length. Any other value: the same rows.
function exemptFromPlanning(rows, planningMinutes) {
  return planningMinutes === false ? rows.map(row => ({ ...row, planning_exempt: true })) : rows;
}

async function loadArrivalRouteContext({
  conn = db, serviceId, prospective, date, technicianId, excludeServiceIds = [], excludeEstimateId,
  changes = {}, now = new Date(), travel, preserveCapacity = false, unit = false, alone = false,
  // false: every stop on the route keeps its own window/estimate length
  // (planning-minutes.js `planning_exempt`, the convention the placed visit
  // already uses) — the nightly auto-dispatch arrival search (find-time.js),
  // so it plans a day the way the 04:20 route pass does. Unset: unchanged.
  planningMinutes,
  // Staff callers only: start the day at the tech's start point
  // (GATE_TECH_START_POINTS). Public and commit-time callers keep the office.
  startPoints = false,
  // The night tool's arrival search only (GATE_AUTO_DISPATCH_DAY_RULES,
  // departure-time.js): the minute the van leaves its start point. Unset:
  // the 08:00 shift open, as before.
  vanDepartureMin,
  // Staff pickers only (GATE_PICKER_ROAD_CHECK, owner 2026-10-26): today's
  // route under way starts from the stop the tech is at or driving to
  // (resolvePlacementOrigin) instead of reading as unverified.
  fromActiveStop = false,
  // A caller outside any transaction that must not geocode (a staff save's
  // road purchase, buySaveRoads): read the geocoder's cache only, as the
  // save's own locked read does.
  cacheLocation = false,
}) {
  const stored = prospective ? { id: '__candidate__', route_order: null, created_at: now.toISOString(), ...prospective }
    : await conn('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .where('scheduled_services.id', serviceId)
    .first(...COLUMNS.map(c => `scheduled_services.${c}`), ...serviceLocationSelects(conn),
      // The co-visit merge resolves an UNSTAMPED row's premise from the
      // customer's primary address, and serviceLocationSelects exposes it as
      // `address_line1`, not the customer_address_* keys effectivePremise
      // reads — so an unstamped target never merged with its sibling and the
      // staff path kept charging the phantom duration (codex #4435 r4 P1).
      ...CUSTOMER_PREMISE_ALIASES);
  if (!stored) return null;
  const techId = technicianId === undefined
    ? (Object.prototype.hasOwnProperty.call(changes, 'technician_id') ? changes.technician_id : stored.technician_id)
    : technicianId;
  const target = { ...stored, ...changes, technician_id: techId, scheduled_date: date };
  if (prospective && target.customer_id) {
    const customer = await conn('customers').where({ id: target.customer_id })
      .first('address_line1', 'city', 'state', 'zip', 'latitude', 'longitude');
    const geo = require('../auto-dispatch/geo').resolveGeo({ ...target,
      customer_address_line1: customer?.address_line1, customer_city: customer?.city, customer_zip: customer?.zip,
      customer_latitude: customer?.latitude, customer_longitude: customer?.longitude });
    Object.assign(target, { lat: geo?.lat ?? null, lng: geo?.lng ?? null,
      customer_address_line1: customer?.address_line1, customer_city: customer?.city,
      customer_state: customer?.state, customer_zip: customer?.zip,
      address_line1: target.service_address_line1 || customer?.address_line1,
      city: target.service_address_city || customer?.city,
      state: target.service_address_state || customer?.state, zip: target.service_address_zip || customer?.zip });
  }
  const location = await resolveServiceLocation(target, undefined, { cacheOnly: conn.isTransaction === true || cacheLocation === true });
  target.lat = location.lat;
  target.lng = location.lng;
  if (dateOnly(stored.scheduled_date) !== date || (stored.technician_id || null) !== (techId || null)) {
    target.route_order = null;
  }
  // A new route number in the pending edit (not the stored one sent back) is
  // the place the save keeps, so the staff insertion rule checks that place.
  const routeOrderPinned = target.route_order != null && changes.route_order != null
    && Number(changes.route_order) !== Number(stored.route_order);
  const rows = await dayStopsQuery(conn, {
    dateStr: date,
    excludeStatuses: NOT_A_ROUTE_STOP_STATUSES,
    select: [...COLUMNS.map(c => `scheduled_services.${c}`), ...guardedCoordSelects(conn),
      // An unstamped row inherits the customer's premise, and the co-visit
      // merge compares EFFECTIVE addresses (codex #4435 r3 P1).
      ...CUSTOMER_PREMISE_ALIASES],
  }).where(q => q.whereNull('scheduled_services.reservation_expires_at')
      .orWhereRaw('scheduled_services.reservation_expires_at > NOW()'));
  const blocks = capacityEnabled() || preserveCapacity ? await conn('tech_schedule_blocks')
    .where({ date }).whereNot('block_type', 'available')
    .where(query => query.where('technician_id', techId).orWhereNull('technician_id'))
    .select('id', 'start_time', 'end_time', 'updated_at') : [];
  // A series mover's exclusion list names planned source rows, including
  // siblings it may already have placed on this destination. Count them in
  // live capacity. Prospective replacement callers still exclude their source.
  // Complete visit members are excluded below only when their
  // total work is represented by the moving group.
  const capacity = capacityEnabled() || preserveCapacity;
  const excluded = new Set([serviceId, ...(capacity && !prospective ? [] : excludeServiceIds)].map(String));
  // Grouped work needs the unit mover's complete duration/placement. Do not
  // certify a partial group by excluding siblings from the simulated route.
  const hasLiveSibling = !!target.visit_id && !!(await conn('scheduled_services')
    .where({ visit_id: target.visit_id }).whereNot('id', serviceId)
    .whereNotIn('id', capacity ? [] : excludeServiceIds)
    .whereNotIn('status', TERMINAL_ROW_STATUSES).first('id'));
  // A caller moving the WHOLE visit: its members leave the day's rows and
  // ride the target as one stop. Not one clean stop = `grouped` stands.
  // `alone`: the caller is about to split this service off its visit and
  // move only it ("Separate" in Edit appointment), so it is an ordinary
  // single visit for this check. Same gate; off, a grouped row is unverified.
  const movedTarget = hasLiveSibling && !prospective
    ? await resolveMovedVisitTarget(conn, { target, stored, serviceId, unit, alone }) : null;
  const grouped = hasLiveSibling && !movedTarget;
  (movedTarget?.memberIds || []).forEach(id => excluded.add(String(id)));
  const activeTarget = dateOnly(stored.scheduled_date) === date && ['en_route', 'on_site'].includes(stored.status);
  const dayRows = exemptFromPlanning(rows.filter(row => !excluded.has(String(row.id))
    && (!capacity || row.window_start || row.time_window || ['completed', 'en_route', 'on_site'].includes(row.status))
    && !(excludeEstimateId && row.source_estimate_id === excludeEstimateId && row.reservation_expires_at)), planningMinutes);
  const activeStop = fromActiveStop && date === etDateString(now) ? await loadActiveStop(conn, dayRows, techId) : null;
  return { target: movedTarget || target, rows: dayRows,
  date, now, grouped, activeTarget, activeStop, prospective: !!prospective,
  insertTarget: dateOnly(stored.scheduled_date) !== date || stored.technician_id !== techId
    || (changes.window_start && String(changes.window_start).slice(0, 5) !== String(stored.window_start).slice(0, 5)),
  // Where the visit is saved now (staffPlacement, GATE_STAFF_ROUTE_INSERTION).
  placedAt: prospective ? null : { date: dateOnly(stored.scheduled_date),
    technicianId: stored.technician_id || null, windowStart: String(stored.window_start || '').slice(0, 5) },
  routeOrderPinned,
  travel, preserveCapacity, blocks,
  planningMinutes,
  vanDepartureMin,
  // Where this tech's day starts and ends (GATE_TECH_START_POINTS; off = HQ).
  home: startPoints ? await loadTechStartPoint(conn, techId) : RouteOptimizer.HQ };
}

// The one stop the tech is at or driving to today, with its clock stamps
// (read apart from COLUMNS, so no route fingerprint changes). Two active
// stops, none, or an unreadable row: null, and the day stays unverified.
async function loadActiveStop(conn, rows, technicianId) {
  const active = rows.filter(row => row.technician_id === technicianId && ['en_route', 'on_site'].includes(row.status));
  if (active.length !== 1) return null;
  try {
    const stamps = await conn('scheduled_services').where({ id: active[0].id })
      .first('en_route_at', 'arrived_at', 'check_in_time');
    return { id: active[0].id, ...(stamps || {}) };
  } catch (err) {
    logger.warn(`[arrival-route] active stop unreadable (today stays unverified): ${err.message}`);
    return null;
  }
}

// ET minute of the day for a timestamp on `date`; null for another day or none.
function etMinuteOn(value, date) {
  if (!value) return null;
  const at = new Date(value);
  if (!Number.isFinite(at.getTime()) || etDateString(at) !== date) return null;
  const parts = etParts(at);
  return parts.hour * 60 + parts.minute;
}

// When the tech is free to leave the active stop (owner 2026-10-26, "his
// current stop"): on site, its arrival plus its job length; en route, the
// drive from where the van left (the model, from `from`) plus the job.
// Never before now.
function activeStopFreeAt(stop, stamps, from, date, nowMin) {
  const work = workDuration(stop);
  if (stop.status === 'on_site') {
    const arrived = etMinuteOn(stamps.arrived_at, date) ?? etMinuteOn(stamps.check_in_time, date) ?? nowMin;
    return Math.max(nowMin, arrived + work);
  }
  const left = etMinuteOn(stamps.en_route_at, date) ?? nowMin;
  const drive = hasCoords(from) ? RouteOptimizer.milesToDriveMinutes(RouteOptimizer.haversine(
    Number(from.lat), Number(from.lng), Number(stop.lat), Number(stop.lng))) : 0;
  return Math.max(nowMin, left + drive) + work;
}

// A visit consumes the sum of its members' work, with one journey to the
// property. Preserve each member's existing promise, including version-1
// combined holds that used separate hourly anchors.
function groupRouteStops(rows) {
  const groups = new Map();
  let previous;
  for (const row of currentOrder(rows)) {
    const key = row.visit_id || allocationKey(row) || row.id;
    if (groups.has(key) && key !== previous) return null;
    previous = key;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const result = [];
  for (const members of groups.values()) {
    const first = members[0];
    if (members.some(row => row.technician_id !== first.technician_id || !hasCoords(row)
      || Number(row.lat) !== Number(first.lat) || Number(row.lng) !== Number(first.lng))) return null;
    let duration = 0;
    let startMin = -Infinity;
    let endMin = Infinity;
    const sharedArrival = members.every(member => String(member.window_start) === String(first.window_start));
    for (const member of members) {
      const range = effectiveWindowRange(member);
      if (range) {
        const offset = sharedArrival ? 0 : duration;
        startMin = Math.max(startMin, range.startMin - offset);
        endMin = Math.min(endMin, range.endMin - offset);
      }
      duration += workDuration(member);
    }
    if (endMin < startMin) return null;
    result.push({ ...first, memberIds: members.map(row => row.id),
      estimated_duration_minutes: duration,
      arrivalRange: Number.isFinite(startMin) ? { startMin, endMin } : null });
  }
  return result;
}

// `detail`: { warning, diagnostics } from describeUnverified (GATE_ROUTE_WARNING_DETAIL, a staff
// save's own check only). Unset: today's result, byte for byte.
function unverified(target, date, detail) {
  const generic = `Could not verify the route's arrival windows on ${date}. Review the route before driving it.`;
  return {
    feasible: false, target, reason: 'route_unverified',
    warning: detail?.warning || generic,
    // The unchanged sentence rides with a worded one: a snapshot compared across a gate flip uses it.
    ...(detail?.warning ? { baseWarning: generic } : {}),
    ...(detail ? { diagnostics: detail.diagnostics } : {}),
  };
}

/** A stored order that is not a whole, window-ordered sequence: a stop with
 *  no position, two stops sharing one, or a later promise numbered ahead of
 *  an earlier one. Delegates to route-reorder-window-fit's staleOrderReasons
 *  (shared with the nightly canonicalization pass's per-reason ledger
 *  evidence) — identical semantics, OR'd into one boolean here. */
function storedOrderStale(rows, members = rows) {
  return staleOrderReasons(rows, members).length > 0;
}

/** The day in promised-window order, ignoring stored positions — sorted by
 *  the row's REAL arrival promise (arrivalRange / effectiveWindowRange), NOT
 *  currentOrder's board-display sort. currentOrder's window_start-string
 *  tiebreak (23:59 for a row with no window_start) is right for the board —
 *  it mirrors the dispatch SQL, which has no time_window column — but a
 *  legacy row promised only a time_window band (morning/afternoon/literal
 *  HH:MM, no window_start) has a REAL promise effectiveWindowRange resolves;
 *  reading it as unconstrained left it last regardless of route_order, so
 *  nulling route_order and re-sorting through currentOrder reproduced the
 *  exact same (inverted) order it was meant to rescue (Codex r1 P1).
 *  Genuinely unconstrained rows (no promise at all) still sort last, tied by
 *  created_at/id like the board. Delegates to route-reorder-window-fit's
 *  promisedWindowOrder (shared with the nightly canonicalization pass's
 *  stale-order baseline) — identical behavior. */
function clockOrder(rows) {
  return promisedWindowOrder(rows);
}

function routeDriveMinutes(stops, origin, end = RouteOptimizer.HQ) {
  let prev = origin;
  let total = 0;
  for (const stop of [...stops, end]) {
    total += RouteOptimizer.fallbackLegMetrics(RouteOptimizer.haversine(prev.lat, prev.lng, stop.lat, stop.lng)).minutes;
    prev = stop;
  }
  return total;
}

/** The visit being placed/considered. Its window is whatever this
 *  evaluation is testing; its real work is its own stored estimate, NEVER
 *  the window-derived `durationMinutes` (find-time-hints passes the
 *  selected span there, and treating a span as additive work charges a
 *  20-minute job in a 60-minute window 60 minutes beside its sibling —
 *  codex #4435 r3/r4 P1) — a genuinely long service is still covered: the
 *  chain's floor is the longest member's workDuration, which includes it.
 *  Exempt from owner planning minutes (planning-minutes.js) unless the table
 *  applies to it (placedVisitMinutes, capacity mode, allowance of the legacy
 *  hour or less): the caller's already-resolved allowance (booking funnel,
 *  estimate profile, re-service catalog) otherwise applies to THIS row. With
 *  `context.planningMinutes === false` (the night arrival search) it is always
 *  exempt. */
function buildPlacementTarget(context, windowStart, windowEnd, durationMinutes) {
  // A whole visit (loadArrivalRouteContext `unit`): its other members' work
  // is added to the tapped member's. Zero for every other target.
  const siblingWork = Number(context.target?.siblingWorkMinutes) || 0;
  const allowance = context.prospective ? Number(durationMinutes)
    : Math.max(workDuration({ ...context.target, planning_exempt: true }), Number(durationMinutes) || 0);
  // Capacity mode plans the placed visit at the owner table too (owner
  // 2026-10-30) — unless the caller turned planning minutes off for the whole
  // call (the night arrival search) or the table does not apply (null).
  const planned = context.planningMinutes === false ? null
    : placedVisitMinutes(context.target, allowance, { preserveCapacity: context.preserveCapacity });
  return {
    ...context.target, window_start: windowStart, window_end: windowEnd,
    raw_estimate_minutes: (Number(context.target?.estimated_duration_minutes) || 0) + siblingWork,
    // A planned visit reads the table through workDuration like every other
    // stop (a window span is a promise, never work); preserveCapacity rides
    // on it the way evaluateArrivalPlacement stamps the route's rows.
    planning_exempt: planned == null,
    ...(planned != null && context.preserveCapacity ? { preserveCapacity: true } : {}),
    estimated_duration_minutes: siblingWork + (planned ?? allowance),
  };
}

/** True when the target itself cannot be routed at all: an off-shift
 *  window, no assigned technician, no coordinates, or a partial visit
 *  group. Every one of these fails the same way in the caller — an
 *  unverified route, never a certified reject — so they are one check. */
function targetUnroutable(capacity, target, windowStart, windowEnd, grouped) {
  return (capacity && !placementFitsShift(minuteOfDay(windowStart), minuteOfDay(windowEnd)))
    || !target.technician_id || !hasCoords(target) || grouped;
}

/** The day's departure clock and origin, honoring today's live progress —
 *  and the (own-minus-completed) pending stops, verified geocoded along
 *  with the origin. Staff may promise an early on-the-hour arrival; depart
 *  early enough to model that route instead of imposing the public
 *  finder's 8 AM floor. An in-progress stop needs live remaining-work/
 *  travel truth: never sell a fit by pretending the technician can restart
 *  today from HQ. Returns null when today's live state (or a coordinate
 *  gap) cannot certify a route — the caller returns `unverified` for it,
 *  same as every reason below. */
// 'google_traffic' when every leg came back traffic-aware, 'google_road' when
// every leg came back from Google and some without traffic, else the model.
function pickerTravelSource(legs) {
  if (legs.every(leg => leg.source === 'google_traffic')) return 'google_traffic';
  if (legs.every(leg => leg.source === 'google_traffic' || leg.source === 'google_road')) return 'google_road';
  return 'conservative_model';
}

// `fail` (optional, GATE_ROUTE_WARNING_DETAIL): receives the cause of a null return. Never read otherwise.
// The stops (and the technician's start point) that have no map pin, for the detail wording.
function noPinCause(origin, pending) {
  return { code: 'no_pin', rows: [origin, ...pending].filter(row => row.id && !hasCoords(row)), startPoint: !origin.id && !hasCoords(origin) };
}

function resolvePlacementOrigin(context, capacity, departureMin, target, own, fail) {
  const refuse = (cause) => { fail.cause = cause; return null; };
  // The night tool's van departure (context.vanDepartureMin): the van may
  // leave before the shift opens, so a farther first stop still makes an
  // 08:00 promise. No stop starts before its window opens either way.
  const shiftStart = capacity && Number.isFinite(context.vanDepartureMin) ? context.vanDepartureMin : SHIFT.startMinutes;
  let startMin = capacity ? Math.max(shiftStart, departureMin ?? shiftStart)
    : departureMin ?? Math.min(8 * 60, ...[target, ...own].map(row => effectiveWindowRange(row)?.startMin ?? Infinity));
  // The tech's start point (GATE_TECH_START_POINTS), else the office.
  let origin = context.home || RouteOptimizer.HQ;
  let activeOrigin = null;
  if (context.date === etDateString(context.now)) {
    const active = own.filter(row => ['en_route', 'on_site'].includes(row.status));
    // A staff picker's one active stop (loadActiveStop) is where the day
    // continues from; anything else under way stays unverified.
    const continuesFrom = active.length === 1 && String(context.activeStop?.id) === String(active[0].id) ? active[0] : null;
    if (context.activeTarget) return refuse({ code: 'target_under_way' });
    if (active.length && !continuesFrom) return refuse({ code: 'under_way', rows: active });
    const parts = etParts(context.now);
    startMin = Math.max(startMin, parts.hour * 60 + parts.minute);
    const completed = own.filter(row => row.status === 'completed').map(row => ({
      ...row, completionTime: row.actual_end_time || row.check_out_time || row.completed_at,
    }));
    const unfinished = completed.find(row => !row.completionTime);
    if (unfinished) return refuse({ code: 'completed_no_time', rows: [unfinished] });
    completed.sort((a, b) => new Date(b.completionTime) - new Date(a.completionTime));
    if (completed.length) origin = completed[0];
    if (continuesFrom) {
      if (!hasCoords(continuesFrom)) return refuse(noPinCause(continuesFrom, []));
      startMin = Math.max(startMin, activeStopFreeAt(continuesFrom, context.activeStop, origin, context.date, parts.hour * 60 + parts.minute));
      origin = continuesFrom;
      activeOrigin = continuesFrom;
    }
  }
  const pending = own.filter(row => row.status !== 'completed' && row !== activeOrigin);
  if (!hasCoords(origin) || pending.some(row => !hasCoords(row))) return refuse(noPinCause(origin, pending));
  return { origin, startMin, pending };
}

/** Every route order to simulate, paired with that order's own same-source
 *  baseline drive (baselineDriveMinutes). Insertion tries every position —
 *  a prospective placement or a genuine move; an existing save probe
 *  re-sequences the day once with the target appended. Tried once per
 *  sequencer (see the stale-order rescue above the caller). `staffInsert`
 *  (GATE_STAFF_ROUTE_INSERTION, capacity off): every position for a moved
 *  visit, the save probe included, since the save writes that order. */
function buildCandidateOrders(context, capacity, groupedPending, target, allowInsertion, sequencers, baselineDriveMinutes, staffInsert = false) {
  const insert = staffInsert || (capacity && allowInsertion && (context.prospective || context.insertTarget));
  return sequencers.flatMap((sequence) => {
    const baseline = sequence(groupedPending);
    const baselineDrive = baselineDriveMinutes(baseline);
    return (insert
      ? Array.from({ length: baseline.length + 1 }, (_, i) => [...baseline.slice(0, i), target, ...baseline.slice(i)])
      : [sequence([...baseline, target])]).map(order => ({ order, baselineDrive }));
  });
}

/** True when a stop after the placed visit arrives less than `margin` minutes
 *  before its window closes. Stops ahead of the visit drive as before, and a
 *  stop with no promise has no window to keep. */
function laterStopTooTight(simulation, order, targetId, rangeForStop, margin, skipIds = null) {
  const at = order.findIndex(row => row.id === targetId);
  return at >= 0 && simulation.arrivals.some((arrival, index) => {
    // `skipIds` (GATE_ROUTE_CHECK_LATE_DAYS): a stop already late without the new visit has no margin to protect.
    const range = index > at && !skipIds?.has(arrival.id) ? rangeForStop(order[index]) : null;
    return range != null && range.endMin - arrival.arrivalMin < margin;
  });
}

// Whether a day row is a FIXED block on the target technician's simulated route.
// Capacity: unassigned rows only. Hour mode (legacy placement): every other
// technician's stop and every live hold, the one-technician shared rule. Hour
// mode with GATE_MULTI_TECH_CONFIRM on (owner 2026-10-30, same-hour technicians):
// each technician's route is separate, so a fixed block is an unassigned row or a
// live hold on the target technician; another technician's stops and holds are ignored.
function rowIsFixedBlock(row, target, capacity) {
  if (capacity) return row.technician_id == null;
  if (multiTechConfirmLive()) {
    return row.technician_id == null
      || (row.technician_id === target.technician_id && row.reservation_expires_at != null);
  }
  return row.technician_id !== target.technician_id || row.reservation_expires_at != null;
}

/** Simulate every candidate order and certify the winner: least travel,
 *  ties broken by less waiting — skipping any order that overruns a return
 *  deadline (returnTooLate) or collides with a FIXED blocker (unassigned
 *  work, another technician's live hold, or a technician-day block), and,
 *  with `marginMinutes`, any order that leaves a later stop less than that
 *  before its window closes (tooTight). */
function selectWinningOrder(orders, { simulate, collectLegs, returnByMin, rows, capacity, target, startMin,
  marginMinutes = 0, rangeForStop, marginSkipIds = null }) {
  let winner = null;
  let returnTooLate = false;
  let tooTight = false;
  for (const { order, baselineDrive } of orders) {
    const usedLegs = [];
    const simulation = simulate(order, usedLegs);
    if (collectLegs) collectLegs.push(...usedLegs);
    if (!simulation) continue;
    if (Number.isFinite(returnByMin) && simulation.returnAtMin > returnByMin) {
      returnTooLate = true;
      continue;
    }
    // Capacity models the selected technician's route; unassigned work still
    // blocks it, including the drive home. Legacy placement keeps its shared
    // occupancy rule for other technicians and live holds.
    const fixedRows = rows.filter(row => row.status !== 'completed' && rowIsFixedBlock(row, target, capacity));
    const fixed = capacity ? occupiedRows(fixedRows).map(row => {
      const range = effectiveWindowRange(row);
      // Unassigned work can start anywhere in its arrival promise. Add that
      // promise once to the complete allocation, not once per member.
      const duration = Math.max(workDuration(row), row.endMin - (row.startMin ?? 0));
      return range ? { ...row, window_start: hhmm(range.startMin),
        endMin: range.endMin + duration } : row;
    }) : fixedRows;
    const hitsFixed = simulation.arrivals.some((arrival, index) => fixed.some(row => {
      if (row.id === arrival.id) return false;
      const start = minuteOfDay(row.window_start);
      const end = Math.max(start + workDuration(row), row.endMin ?? 0);
      const occupiedFrom = index === 0 ? startMin : simulation.arrivals[index - 1].departureMin;
      return (capacity && start == null) || (start != null && occupiedFrom < end && arrival.departureMin > start);
    })) || (capacity && fixed.some(row => {
      const start = minuteOfDay(row.window_start);
      const end = Math.max(start + workDuration(row), row.endMin ?? 0);
      return start == null || (simulation.serviceFinishMin < end && simulation.returnFinishMin > start);
    }));
    if (hitsFixed) continue;
    if (marginMinutes > 0 && laterStopTooTight(simulation, order, target.id, rangeForStop, marginMinutes, marginSkipIds)) {
      tooTight = true;
      continue;
    }
    if (!winner || simulation.travelMin < winner.simulation.travelMin
      || (simulation.travelMin === winner.simulation.travelMin && simulation.waitingMin < winner.simulation.waitingMin)) {
      winner = { simulation, order, usedLegs, baselineDrive };
    }
  }
  return { winner, returnTooLate, tooTight };
}

/** True when the day's existing stops alone cannot keep their promises in
 *  ANY order tried — tells "this visit breaks the day" apart from "the day
 *  is already broken" (day_overcommitted vs arrival_window). */
function dayIsOvercommitted(sequencers, groupedPending, simulate) {
  return sequencers.every(sequence => !simulate(sequence(groupedPending), []));
}

/** Why an `arrival_window` failure happened, from the same simulation re-run to report
 *  lateness instead of stopping at the first miss (explain: true only). The new visit is
 *  tried at EVERY position of the day's current order (n+1), whatever capacity mode or
 *  GATE_STAFF_ROUTE_INSERTION do for the real placement, so one cramped order never speaks
 *  for the day.
 *
 *  A position is VIABLE only if the new visit keeps its OWN 2-hour window there. A position
 *  that misses it (typically the new visit appended after everyone) "saves" the other
 *  customers only by breaking the new customer's promise, so it is not a way to keep the
 *  hour: an hour that fits only by arriving late to the new customer is not offered, and
 *  one that fits only by making somebody else late is removed. Per position:
 *  - others(p): stops late with the visit there that are NOT late in the day without it.
 *  - Any viable position with no others(p): the hour can be kept with every promise
 *    kept, so nothing is confirmed.
 *  - No viable position: the new customer cannot be reached in their own window anywhere
 *    (`targetLate`); nobody else is blamed.
 *  - Viable positions all with others(p): `newlyLateStopIds` is the UNION of the stops
 *    made late at the viable positions.
 *  - baselineLateStopIds: stops already late in the day without the new visit.
 *  - dayEndExceeded: at some position the route runs past the day end. */
const EXPLAIN_MAX_STOPS = 30;

// The stops that arrive after their promised window in `order` (day end ignored) with how late each is,
// as a Map of id -> lateMinutes, or null when the order cannot be simulated.
function lateStopMinutes(simulate, order) {
  const simulation = simulate(order, [], { reportLate: true, dayEndMin: Infinity });
  return simulation ? new Map(simulation.arrivals.filter(arrival => arrival.lateMinutes > 0)
    .map(arrival => [arrival.id, arrival.lateMinutes])) : null;
}

// The ids alone: the stops that arrive after their promised window in `order`, or null when it cannot be simulated.
function lateStopIds(simulate, order) {
  const late = lateStopMinutes(simulate, order);
  return late ? [...late.keys()] : null;
}

function explainLateness({ sequencers, groupedPending, simulate, target }) {
  const lateIds = (order) => lateStopIds(simulate, order);
  const baselines = sequencers.map(sequence => sequence(groupedPending));
  const baselineLate = new Set(baselines.flatMap(baseline => lateIds(baseline) || []));
  const orders = baselines.flatMap(baseline => (baseline.length > EXPLAIN_MAX_STOPS ? []
    : Array.from({ length: baseline.length + 1 }, (_, i) => [...baseline.slice(0, i), target, ...baseline.slice(i)])));
  const crowded = new Set();
  let viable = 0;
  let unconfirmed = orders.length === 0; // an unsimulable position, or a viable one that keeps everyone on time
  let dayEndExceeded = false;
  for (const order of orders) {
    const late = lateIds(order);
    if (late == null) {
      unconfirmed = true;
      continue;
    }
    if (!simulate(order, [], { reportLate: true })) dayEndExceeded = true;
    if (late.includes(target.id)) continue;
    viable += 1;
    const others = late.filter(id => !baselineLate.has(id));
    if (others.length) others.forEach(id => crowded.add(id));
    else unconfirmed = true;
  }
  return { targetLate: orders.length > 0 && viable === 0,
    newlyLateStopIds: viable > 0 && !unconfirmed ? [...crowded] : [],
    baselineLateStopIds: [...baselineLate], dayEndExceeded };
}

/** GATE_ROUTE_CHECK_LATE_DAYS (staff arrival-window lists): a day whose EXISTING stops already
 *  arrive after their window (every order tried, without the new visit) must not read "full".
 *  Re-selects a winner among the same candidate orders and the same blockers, but lets a stop
 *  that is already late stay late. Same definition of late as explainLateness (the 2-hour
 *  arrival promise, baselineLate = stops late without the new visit): an order wins only when
 *  the new visit keeps its OWN window, no stop that is on time without it becomes late, and no
 *  stop that is already late arrives more than INSERTION_MARGIN_MINUTES (15) later than it does
 *  without the new visit. A stop counts as already late only when it is late in EVERY baseline
 *  tried (stored order and clock order under stale numbering), and its cap is its smallest
 *  lateness across them; a stop that is on time in any baseline may not become late. A late stop
 *  after the new visit is not held to the insertion margin. Null = no stop is late in every
 *  baseline (not an already-late day), or no order qualifies: the refusal stands. */
function lateDayWinner(orders, { sequencers, groupedPending, simulate, baselineDrive, ...selectArgs }) {
  const baselineLists = sequencers.map(sequence => lateStopMinutes(simulate, sequence(groupedPending)));
  if (baselineLists.some(list => !list)) return null;
  // A stop is "already late" only when it is late in EVERY baseline tried (stored order and clock order when
  // the numbering is stale); its allowance is its smallest lateness across them. A stop that is on time in any
  // baseline gets none: it may not become late. No stop late in every baseline: not an already-late day.
  const baselineLate = new Map([...baselineLists[0]].filter(([id]) => baselineLists.every(list => list.has(id)))
    .map(([id]) => [id, Math.min(...baselineLists.map(list => list.get(id)))]));
  if (!baselineLate.size) return null;
  const tolerantSimulate = (order, usedLegs, extra = {}) => {
    const simulation = simulate(order, usedLegs, { ...extra, reportLate: true });
    return simulation && simulation.arrivals.every(arrival => !(arrival.lateMinutes > 0)
      || (baselineLate.has(arrival.id) && arrival.lateMinutes <= baselineLate.get(arrival.id) + INSERTION_MARGIN_MINUTES))
      ? simulation : null;
  };
  // The detour is measured against the baseline drive, which the first pass took from the model when the
  // already-late baseline could not be simulated: re-take it from the same travel source with lateness allowed.
  const drives = new Map();
  const lateOrders = orders.map((entry) => {
    const baseline = entry.order.filter(row => row.id !== selectArgs.target.id);
    const key = baseline.map(row => row.id).join('|');
    if (!drives.has(key)) drives.set(key, baselineDrive(baseline));
    const drive = drives.get(key);
    return drive == null ? entry : { ...entry, baselineDrive: drive };
  });
  return selectWinningOrder(lateOrders, { ...selectArgs, simulate: tolerantSimulate, marginSkipIds: new Set(baselineLate.keys()) }).winner;
}

// ---- Staff warning detail (GATE_ROUTE_WARNING_DETAIL, route-warning-detail.js) ----
// Everything below runs only for a staff save's own check with the gate on, after the result is
// already decided: it words the failure, it never changes one. A stop is named by its place in
// the technician's day (completed stops first, then the route in the order simulated), its window
// and the clock, never by customer.

/** The stop number of any row on the technician's day, ordered the way the board lists the day. */
function stopNumberer(own, target) {
  const base = own.some(row => String(row.id) === String(target.id)) ? own : [...own, target];
  const numbers = new Map(currentOrder(base).map((row, index) => [String(row.id), index + 1]));
  return row => numbers.get(String(row.id));
}

function stopLabeler(own, target) {
  const numberOf = stopNumberer(own, target);
  const isNew = String(target.id) === '__candidate__';
  return (row, number = numberOf(row)) => {
    const range = row.arrivalRange || effectiveWindowRange(row);
    const mine = String(row.id) === String(target.id);
    if (mine && isNew) return warningDetail.stopLabel(null, range, { isNew: true });
    return warningDetail.stopLabel(number, range);
  };
}

/** The technician's day as it reads: completed stops, then the stop under way (en route or on site) if
 *  any, then the simulated pending order. The simulation drops the first two from the order it runs
 *  (resolvePlacementOrigin), and capacity mode collapses a shared stop's service rows into one entry
 *  (groupRouteStops) that buildFeasibleResult flattens by `memberIds` when it writes route numbers. So
 *  a stop's number is the rows ahead of it (those two kinds, plus every member of each earlier entry)
 *  plus one: the number the save writes. One helper for every sentence taken from a simulated order. */
function numberInOrder(own, target) {
  const ahead = own.filter(row => ['completed', 'en_route', 'on_site'].includes(row.status) && String(row.id) !== String(target.id)).length;
  return (order, index) => ahead + order.slice(0, index).reduce((sum, entry) => sum + (entry.memberIds?.length || 1), 0) + 1;
}

/** The cause of a `route_unverified` answer, in words. `cause` is { code, rows?, startPoint? }. */
function describeUnverified({ date, target, own, cause }) {
  const label = stopLabeler(own, target);
  const mine = label(target);
  let text;
  switch (cause.code) {
    case 'off_shift':
      text = `${mine} starts outside the technician's shift hours, so its route cannot be checked.`;
      break;
    case 'no_technician':
      text = `${mine} has no technician, so its route cannot be checked.`;
      break;
    case 'no_pin': {
      const rows = cause.rows || [];
      const named = rows.slice(0, 3).map(row => `${label(row)} has no map pin.`);
      if (rows.length > 3) named.push(`${warningDetail.plural(rows.length - 3, 'more stop')} also ${rows.length - 3 === 1 ? 'has' : 'have'} no map pin.`);
      if (cause.startPoint) named.push("The technician's start point has no map pin.");
      text = `${named.join(' ')} Fix the address pin to check the route.`;
      break;
    }
    case 'grouped':
      text = `${mine} is booked with another service at the same stop, so its route cannot be checked.`;
      break;
    case 'target_under_way':
      text = `${mine} is already under way, so the rest of the day cannot be checked.`;
      break;
    case 'under_way': {
      const rows = cause.rows || [];
      text = rows.length === 1
        ? `${label(rows[0])} is under way and its live position is not available, so the rest of the day cannot be checked.`
        : `${rows.slice(0, 3).map(row => label(row)).join(' and ')} are all under way, so the rest of the day cannot be checked.`;
      break;
    }
    case 'completed_no_time':
      text = `${label(cause.rows[0])} is marked completed with no finish time, so the route cannot be checked.`;
      break;
    case 'group_unmodeled':
      text = 'A shared stop on this day cannot be modeled, so the route cannot be checked.';
      break;
    default:
      return null;
  }
  return { warning: `Route on ${date}: ${text}`, diagnostics: { cause: cause.code } };
}

/** Late stops, in words, for the orders the check tried. `candidates` are the orders tried for the
 *  visit, `baselines` the day without it. Every late stop is one of three kinds: the visit itself
 *  (`mine`), a stop that is late in EVERY baseline, so late with or without the visit (`old`), or any
 *  other (`fresh`: on time in at least one baseline, so the visit's placement makes it late). Picks the
 *  order that breaks the fewest promises (the visit's own counts) and names them. null: nothing late to
 *  name (a blocker or margin). */
function describeLateness({ date, candidates, baselines, simulate, target, own, dayEndMin }) {
  const label = stopLabeler(own, target);
  const numberOf = numberInOrder(own, target);
  const isNew = String(target.id) === '__candidate__';
  const idOf = stop => String(stop.row.id);
  const lateStops = (order) => {
    const simulation = order.length <= EXPLAIN_MAX_STOPS + 1 && simulate(order, [], { reportLate: true, dayEndMin: Infinity });
    return simulation ? simulation.arrivals.map((arrival, index) => ({ row: order[index], arrivalMin: arrival.arrivalMin,
      lateMinutes: arrival.lateMinutes || 0, number: numberOf(order, index) })).filter(stop => stop.lateMinutes > 0) : null;
  };
  // The day WITHOUT the visit. A stop is already late only when no baseline keeps it on time; a stale
  // stored order can break a promise the clock order keeps. "Without this visit" sentences quote the
  // baseline's own arrival and minutes (the least late one), never the candidate route's.
  const runs = baselines.map(lateStops).filter(Boolean);
  const already = new Map();
  for (const stop of runs.flat()) {
    const seen = already.get(idOf(stop));
    if (runs.every(run => run.some(other => idOf(other) === idOf(stop))) && (!seen || stop.lateMinutes < seen.lateMinutes)) already.set(idOf(stop), stop);
  }
  const kindOf = stop => (idOf(stop) === String(target.id) ? 'mine' : (already.has(idOf(stop)) ? 'old' : 'fresh'));
  const byKind = late => late.reduce((kinds, stop) => { kinds[kindOf(stop)].push(stop); return kinds; }, { mine: [], old: [], fresh: [] });
  const cost = kinds => [...kinds.fresh, ...kinds.mine].reduce((sum, stop) => sum + stop.lateMinutes, 0);
  let best = null;
  for (const order of candidates) {
    const late = lateStops(order);
    const kinds = late && byKind(late);
    const score = kinds && kinds.fresh.length + kinds.mine.length;
    if (kinds && (!best || score < best.score || (score === best.score && cost(kinds) < cost(best.kinds)))) best = { order, kinds, score };
  }
  if (!best) return null;
  const { kinds } = best;
  const worst = stops => [...stops].sort((a, b) => b.lateMinutes - a.lateMinutes);
  const named = (stops, extra) => worst(stops).slice(0, extra.limit).map(stop => warningDetail.lateSentence(label(stop.row, stop.number), stop.arrivalMin, stop.lateMinutes, extra));
  const sentences = [
    ...named(kinds.fresh, { limit: 3 }),
    ...(kinds.fresh.length > 3 ? [`${warningDetail.plural(kinds.fresh.length - 3, 'more stop')} would also be late.`] : []),
    ...kinds.mine.map(stop => `${isNew ? label(stop.row, stop.number) : `${label(stop.row, stop.number)} is this visit and`} would arrive ${warningDetail.clockText(stop.arrivalMin)}, ${stop.lateMinutes} min late, so it cannot keep its own window.`),
    // Nothing the visit breaks: the day's own lateness, from the day without the visit.
    ...(kinds.fresh.length + kinds.mine.length ? [] : named(kinds.old.map(stop => ({ ...stop, ...already.get(idOf(stop)), row: stop.row, number: stop.number })), { limit: 2, already: true })),
    ...(Number.isFinite(dayEndMin) && !simulate(best.order, [], { reportLate: true }) ? [warningDetail.dayEndSentence(dayEndMin)] : []),
  ];
  const ids = [...kinds.fresh, ...kinds.mine, ...kinds.old].map(stop => (idOf(stop) === '__candidate__' ? 'new' : idOf(stop)));
  return sentences.length ? { warning: `Route on ${date}: ${sentences.join(' ')}`, lateStopIds: ids } : null;
}

/** The tightest later stop, for an `arrival_margin` answer: the order that leaves the most room. */
function describeTightness({ date, candidates, simulate, target, own, rangeForStop, margin }) {
  const label = stopLabeler(own, target);
  const numberOf = numberInOrder(own, target);
  let best = null;
  for (const order of candidates) {
    const simulation = simulate(order, []);
    const at = order.findIndex(row => String(row.id) === String(target.id));
    if (!simulation || at < 0) continue;
    let tight = null;
    simulation.arrivals.forEach((arrival, index) => {
      const range = index > at ? rangeForStop(order[index]) : null;
      if (range == null) return;
      const left = range.endMin - arrival.arrivalMin;
      if (left < margin && (!tight || left < tight.left)) tight = { row: order[index], arrivalMin: arrival.arrivalMin, left, number: numberOf(order, index) };
    });
    if (tight && (!best || tight.left > best.left)) best = tight;
  }
  if (!best) return null;
  return { warning: `Route on ${date}: ${warningDetail.tightSentence(label(best.row, best.number), best.arrivalMin, Math.max(0, best.left))} Choose another window.`,
    lateStopIds: [String(best.row.id)] };
}

/** Shape the certified winner into evaluateArrivalPlacement's public
 *  feasible result. */
function buildFeasibleResult({ target, capacity, staffInsert = false, startMin, own, windowStart, winner, origin, home = RouteOptimizer.HQ, roadTravel = false }) {
  const { simulation, order, usedLegs, baselineDrive } = winner;
  // Fixed blockers remain immovable; selected-technician holds are included
  // in the capacity route alongside that technician's appointments.
  const arrival = simulation.arrivals.find(row => row.id === target.id);
  const routeOrder = [...currentOrder(own.filter(row => row.status === 'completed')).map(row => row.id),
    ...order.flatMap(row => row.memberIds || [row.id])];
  return {
    feasible: true, target,
    estimatedArrival: hhmm(arrival.arrivalMin + (target.arrivalOffsetMinutes || 0)),
    detourMinutes: Math.max(0, simulation.travelMin - baselineDrive),
    driveMinutes: simulation.travelMin,
    waitingMinutes: simulation.waitingMin,
    returnMinuteBeforeBreaks: simulation.returnAtMin,
    ...(capacity ? {
      finishMinute: simulation.returnFinishMin,
      occupiedMinutes: simulation.returnFinishMin - startMin,
      routeOrder,
      travelSource: usedLegs.every(leg => leg.source === 'google_traffic') ? 'google_traffic' : 'conservative_model',
      travelReasons: [...new Set(usedLegs.map(leg => leg.reason).filter(Boolean))],
      // Where the van starts this route (home base, or today's last
      // completed stop), so a picker can say where the first drive starts.
      origin: origin ? { isHome: origin === home } : null,
    } : {}),
    // The order a staff save writes (placeMovedVisit).
    ...(staffInsert ? { routeOrder } : {}),
    // A staff picker's Google check (GATE_PICKER_ROAD_CHECK): whether every
    // leg it drove came from Google (with traffic, or a road time without
    // traffic on the later road days), so the box can drop the "~".
    ...(!capacity && roadTravel ? { travelSource: pickerTravelSource(usedLegs) } : {}),
    arrivalDelayMinutes: arrival.arrivalMin + (target.arrivalOffsetMinutes || 0) - minuteOfDay(windowStart),
    arrivals: simulation.arrivals.map(row => ({ id: row.id, arrival: hhmm(row.arrivalMin), departure: hhmm(row.departureMin), drive: row.driveMin })),
  };
}

/** Pure evaluation shared by the hint, live conflict check, and save probe. */
function evaluateArrivalPlacement(context, { windowStart, windowEnd, durationMinutes, dayEndMin = 20 * 60,
  departureMin, returnByMin, bufferMinutes = 0, collectLegs, allowInsertion = true, place = false,
  // Optional diagnostics (customer route check): on an `arrival_window` failure, add `lateness`
  // (see explainLateness). Unset: no extra work and the result is exactly what it was.
  explain = false,
  // GATE_ROUTE_CHECK_LATE_DAYS (find-time.js findArrivalWindowSlots, staff lists only): see lateDayWinner.
  // Unset: nothing below runs and the result is exactly what it was.
  lateDays,
  // A staff save's own check: a failure carries `diagnostics` for the save's log line, and with
  // GATE_ROUTE_WARNING_DETAIL on it is worded with the stop, its window, the predicted arrival and
  // the minutes. Never changes whether the placement fits.
  detail }) {
  if (!context) return unverified(null, 'this date');
  const { date, grouped } = context;
  const capacity = capacityEnabled() || context.preserveCapacity;
  // A version-2 hold accepted while the live gate is rolled back still owes
  // the SAME planning minutes it was offered under (prepareReservationCommit
  // passes preserveCapacity: true for it — Codex r1 P0). Stamp every row so
  // planning-minutes.js's plannedWorkMinutes (read through workDuration
  // below) honors the persisted path the same way `capacity` above does;
  // capacityEnabled() alone would silently drop back to the legacy
  // window/estimate rule on a rollback.
  const rows = context.preserveCapacity ? context.rows.map(row => ({ ...row, preserveCapacity: true })) : context.rows;
  if (capacity) dayEndMin = Math.min(dayEndMin, SHIFT.endMinutes);
  const target = buildPlacementTarget(context, windowStart, windowEnd, durationMinutes);
  const detailOn = warningDetail.detailWanted(detail);
  const dayOf = () => (target.technician_id ? rows.filter(row => row.technician_id === target.technician_id
    && (capacity || row.reservation_expires_at == null)) : []);
  // route_unverified, worded with its cause when a staff save asked for detail.
  const unverifiedBecause = (cause) => {
    if (detail !== true) return unverified(target, date);
    const words = describeUnverified({ date, target, own: dayOf(), cause: typeof cause === 'function' ? cause() : cause });
    // Gate off: the sentence stays; the cause still rides along for the save's log line.
    return unverified(target, date, detailOn ? words : (words ? { diagnostics: words.diagnostics } : undefined));
  };
  if (targetUnroutable(capacity, target, windowStart, windowEnd, grouped)) {
    return unverifiedBecause(() => (capacity && !placementFitsShift(minuteOfDay(windowStart), minuteOfDay(windowEnd)) ? { code: 'off_shift' }
      : !target.technician_id ? { code: 'no_technician' }
        : !hasCoords(target) ? { code: 'no_pin', rows: [target] } : { code: 'grouped' }));
  }
  // Staff route insertion (GATE_STAFF_ROUTE_INSERTION, capacity off): a move
  // tries every place (staffPlacement). A whole shared stop (`unit`) and a
  // route number the office typed keep today's rule: their save keeps that
  // place.
  const placement = !capacity && staffRouteInsertionLive() && !target.memberIds && !context.routeOrderPinned
    ? staffPlacement(context, place, date, target.technician_id, windowStart) : null;
  const staffInsert = placement === 'move';
  const own = rows.filter(row => row.technician_id === target.technician_id && (capacity || row.reservation_expires_at == null));
  const originFail = {};
  const resolvedOrigin = resolvePlacementOrigin(context, capacity, departureMin, target, own, originFail);
  if (!resolvedOrigin) return unverifiedBecause(() => originFail.cause || { code: 'unknown' });
  const { origin, startMin, pending } = resolvedOrigin;
  const groupedPending = capacity ? groupRouteStops(pending) : pending;
  if (!groupedPending) return unverifiedBecause({ code: 'group_unmodeled' });
  // Clock-order fallback (owner 2026-09-25): a stored order with gaps,
  // duplicates or an afternoon stop ahead of a morning one is leftover
  // numbering, not a plan. Simulate the day in promised-window order too and
  // certify whichever fits better; commit persists the certified order. A
  // complete, window-ordered dispatch order stays the only baseline. Under
  // GATE_STAFF_ROUTE_INSERTION a staff move follows the same rule, and so does
  // the visit where it is saved, so its own hour reads like every other hour
  // (nothing is written for it: only a move's result carries an order).
  const sequencers = (capacity || placement) && storedOrderStale(groupedPending, pending) ? [currentOrder, clockOrder] : [currentOrder];
  const rangeForStop = row => row.arrivalRange || effectiveWindowRange(row);
  const simulate = (order, usedLegs, extra = {}) => {
    const travel = context.travel || (capacity ? RouteOptimizer.createSchedulingTravel({ maxRequests: 0 }) : null);
    return simulateArrivalRoute(RouteOptimizer, rangeForStop,
      // raw_estimate_minutes keeps the UNTOUCHED estimate for the co-visit
      // sum: the rewrite below hands every ungrouped row its window span as
      // a duration, which would otherwise read as a real estimate and sum a
      // span-only pair back into the phantom hour (Codex #4435 r2 P1).
      order.map(row => ({ ...row,
        // A row that already carries its raw estimate (the target above)
        // keeps it — only ordinary rows take theirs from the untouched
        // column before the normalization below.
        // A grouped row already carries its members' ADDITIVE work as its
        // duration (groupRouteStops / visit-capacity); nulling its raw
        // estimate let a co-visit merge charge max(group, target) instead of
        // their sum (codex #4435 r4 P1). Ordinary rows take theirs from the
        // untouched column, and a row that already carries one keeps it.
        raw_estimate_minutes: row.memberIds ? row.estimated_duration_minutes
          : ('raw_estimate_minutes' in row ? row.raw_estimate_minutes : row.estimated_duration_minutes),
        estimated_duration_minutes: row.memberIds ? row.estimated_duration_minutes : workDuration(row) })), {
        origin, startMin, dayEndMin, includeReturnInFinish: capacity, bufferMinutes, end: context.home || RouteOptimizer.HQ,
        blockedIntervals: (context.blocks || []).map(block => ({ startMin: minuteOfDay(block.start_time), endMin: minuteOfDay(block.end_time) })),
        ...extra,
        ...(travel ? { legMinutes: (from, to, departureMin) => {
          const leg = { date, from, to, departureMin };
          const metric = travel.lookup(leg);
          usedLegs.push({ ...leg, ...metric });
          return metric.minutes;
        } } : {}),
      });
  };
  // The baseline drive the detour is measured against must come from the
  // SAME travel source (traffic-aware Google when context.travel is live)
  // and the SAME departures as the candidate simulation — never the
  // haversine fallback model on one side and Google on the other. A
  // congested EXISTING leg used to score entirely against the candidate
  // (routeDriveMinutes ignores traffic), manufacturing a detour that was
  // really just the standing route's own congestion (Codex r2 P1). Falls
  // back to the model-only estimate only when the baseline-alone route
  // cannot even be simulated (the day is already broken — see the
  // day_overcommitted diagnosis below, which is unaffected either way).
  const baselineDriveMinutes = (baseline) => {
    const legs = [];
    const baselineSimulation = simulate(baseline, legs);
    if (collectLegs) collectLegs.push(...legs);
    return baselineSimulation ? baselineSimulation.travelMin : routeDriveMinutes(baseline, origin, context.home || RouteOptimizer.HQ);
  };
  const orders = buildCandidateOrders(context, capacity, groupedPending, target, allowInsertion, sequencers, baselineDriveMinutes, staffInsert);
  const { winner, returnTooLate, tooTight } = selectWinningOrder(orders,
    { simulate, collectLegs, returnByMin, rows, capacity, target, startMin,
      marginMinutes: staffInsert ? INSERTION_MARGIN_MINUTES : 0, rangeForStop });
  const fail = {
    feasible: false, target, reason: 'arrival_window',
    warning: `The route on ${date} cannot keep every promised arrival window with the planned service and driving times. Review the stop order or choose another window.`,
  };
  // Staff warning detail: the stop, window, arrival and minutes behind a failure, plus what the save's
  // log line records (placement kind, late stops, where the drive times came from). The generic
  // sentence stays when nothing can be named. `base_warning` is the unchanged sentence: a snapshot
  // compared between a review and its apply must not drift with the clock.
  const detailed = (result, words) => {
    if (detail !== true) return result;
    return { ...result, ...(detailOn && words ? { warning: words.warning, baseWarning: result.warning } : {}),
      diagnostics: { placement: placement || 'none', travelSource: context.travel ? 'picker_cache' : 'conservative_model',
        lateStopIds: words?.lateStopIds || [] } };
  };
  const words = describe => (detailOn ? describe() : null);
  const candidateOrders = () => orders.map(entry => entry.order);
  const baselineOrders = () => sequencers.map(sequence => sequence(groupedPending));
  if (!winner && returnTooLate) {
    return detailed({ ...fail, reason: 'return_time', warning: `The modeled route returns after the requested workday limit on ${date}.` });
  }
  // Every place it fits crowds a later customer (staff route insertion).
  if (!winner && tooTight) {
    return detailed({ ...fail, reason: 'arrival_margin',
      warning: `The route on ${date} fits this visit only by leaving a later stop less than ${INSERTION_MARGIN_MINUTES} minutes before its arrival window closes. Choose another window.` },
    words(() => describeTightness({ date, candidates: candidateOrders(), simulate, target, own, rangeForStop, margin: INSERTION_MARGIN_MINUTES })));
  }
  // Late days are an arrival-window rule: capacity mode never offers them (findCapacitySlots), so no
  // capacity-mode caller (picked hour, save) may certify one (pre-push audit, PR #7041).
  if (!winner && lateDays && !capacity) {
    const lateBaselineDrive = (baseline) => {
      const legs = [];
      const simulation = simulate(baseline, legs, { reportLate: true });
      if (collectLegs) collectLegs.push(...legs);
      return simulation ? simulation.travelMin : null;
    };
    const lateWinner = lateDayWinner(orders, { sequencers, groupedPending, simulate, baselineDrive: lateBaselineDrive, collectLegs, returnByMin,
      rows, capacity, target, startMin, marginMinutes: staffInsert ? INSERTION_MARGIN_MINUTES : 0, rangeForStop });
    if (lateWinner) {
      return { ...buildFeasibleResult({ target, capacity, staffInsert, startMin, own, windowStart, winner: lateWinner, origin,
        home: context.home || RouteOptimizer.HQ, roadTravel: !!context.travel }), dayAlreadyLate: true };
    }
  }
  // Tell "this visit breaks the day" apart from "the day is already broken":
  // the existing stops alone cannot keep their promises in any order tried.
  if (!winner && capacity && dayIsOvercommitted(sequencers, groupedPending, simulate)) {
    return detailed({ ...fail, reason: 'day_overcommitted',
      warning: `The route on ${date} already cannot keep every promised arrival window before this visit is added.` },
    words(() => describeLateness({ date, candidates: baselineOrders(), baselines: baselineOrders(), simulate, target, own, dayEndMin })));
  }
  if (!winner) {
    const result = explain ? { ...fail, lateness: explainLateness({ sequencers, groupedPending, simulate, target }) } : fail;
    return detailed(result,
      words(() => describeLateness({ date, candidates: candidateOrders(), baselines: baselineOrders(), simulate, target, own, dayEndMin })));
  }
  return buildFeasibleResult({ target, capacity, staffInsert, startMin, own, windowStart, winner, origin, home: context.home || RouteOptimizer.HQ,
    roadTravel: !!context.travel });
}

/** One on-the-hour enumeration for the staff finder and read-only gap
 * measurements. Both evaluate the order the existing save would produce.
 * `startsOnly` (a Set of 'HH:MM' window starts; the pickers' Google band,
 * find-time.js preloadBandLegs) evaluates those hours alone. */
function enumerateArrivalPlacements(context, { durationMinutes, earliestStartMin, latestServiceEndMin = 20 * 60, startsOnly = null, ...limits }) {
  const placements = [];
  const rejections = {};
  let evaluated = 0;
  for (let start = Math.ceil(earliestStartMin / 60) * 60; start + durationMinutes <= latestServiceEndMin; start += 60) {
    const windowStart = hhmm(start);
    if (startsOnly && !startsOnly.has(windowStart)) continue;
    evaluated++;
    const windowEnd = hhmm(start + durationMinutes);
    const fit = evaluateArrivalPlacement(context, { windowStart, windowEnd, durationMinutes, ...limits });
    if (fit.feasible) placements.push({ windowStart, windowEnd, fit });
    else rejections[fit.reason] = (rejections[fit.reason] || 0) + 1;
  }
  return { placements, evaluated, rejections };
}

function routeFingerprint(context) {
  const { createHash } = require('crypto');
  const relevant = context.rows.filter(row => row.technician_id == null
    || row.technician_id === context.target.technician_id);
  const rows = [...relevant, context.target].map(row => Object.fromEntries(
    [...COLUMNS, 'lat', 'lng'].map(key => [key, row[key] ?? null]),
  )).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  // Prospective creation time is bookkeeping, not a changed route input.
  for (const row of rows) if (row.id === '__candidate__') row.created_at = null;
  return createHash('sha256').update(JSON.stringify({ rows,
    blocks: [...(context.blocks || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))) })).digest('hex');
}


async function certifyArrivalPlacement(context, options) {
  if (!context) return unverified(null, 'this date');
  if (!capacityEnabled() && !context.preserveCapacity) return evaluateArrivalPlacement(context, options);
  context.travel ||= RouteOptimizer.createSchedulingTravel();
  // Recompute departure times after road estimates change a leg. A final
  // uncovered leg retains the conservative model and is labelled accordingly.
  for (let pass = 0; pass < 3; pass++) {
    const legs = [];
    evaluateArrivalPlacement(context, { ...options, collectLegs: legs });
    await context.travel.preload(legs);
  }
  return evaluateArrivalPlacement(context, options);
}


function capacityError(reason = 'route_changed') {
  return Object.assign(new Error('This time is no longer available. Please choose another appointment.'), {
    code: 'SLOT_UNAVAILABLE', reason, status: 409, statusCode: 409, isOperational: true,
  });
}

async function prepareArrivalCapacity(options) {
  if (!capacityEnabled() && !options.preserveCapacity) return null;
  const context = await loadArrivalRouteContext(options);
  if (!context) throw capacityError('route_unverified');
  await certifyArrivalPlacement(context, options);
  return { options, fingerprint: routeFingerprint(context), travel: context.travel };
}

// Self-serve arrival grace (owner ruling 2026-09-28, "I'd rather be more
// lenient than strict"): a customer-picked time is an ARRIVAL window, kept
// only while the certified fit's own delay stays within the caller's grace.
// Pulled out of verifyArrivalCapacity for direct unit coverage — arrival-
// route.js's own DB-backed callers make the whole function hard to exercise
// without a real transaction. `arrivalGraceMinutes` not a positive finite
// number (undefined for every staff/voice caller, and for a self-serve
// caller on a grace-0 day) is a no-op: the existing 120-minute arrival
// promise (baked into effectiveWindowRange/simulateArrivalRoute) stays the
// only bound, exactly as before this lane.
function arrivalExceedsGrace(fit, arrivalGraceMinutes) {
  return Number.isFinite(arrivalGraceMinutes) && arrivalGraceMinutes > 0
    && Number.isFinite(fit?.arrivalDelayMinutes) && fit.arrivalDelayMinutes > arrivalGraceMinutes;
}

async function verifyArrivalCapacity(prepared, {
  conn, windowStart, windowEnd, durationMinutes, serviceTypes, arrivalGraceMinutes,
} = {}) {
  if (!prepared || (!capacityEnabled() && !prepared.options.preserveCapacity)) throw capacityError();
  // Callers hold selected and unassigned tech-day fences before row locks.
  // Completion writers lock stops without the tech-day fence. Hold relevant
  // rows through persistence; NOWAIT avoids reversing their lock order.
  if (!conn?.isTransaction) throw capacityError('transaction_required');
  try {
    await conn('scheduled_services').where({ scheduled_date: prepared.options.date })
      .where(query => query.where('technician_id', prepared.options.technicianId).orWhereNull('technician_id'))
      .whereNotIn('status', NOT_A_ROUTE_STOP_STATUSES)
      .orderBy('id').select('id').forUpdate().noWait();
  } catch (error) {
    if (error.code === '55P03') throw capacityError('route_busy');
    throw error;
  }
  const context = await loadArrivalRouteContext({ ...prepared.options, conn, travel: prepared.travel });
  if (!context || routeFingerprint(context) !== prepared.fingerprint) throw capacityError();
  const fit = evaluateArrivalPlacement(context, { ...prepared.options,
    ...(windowStart ? { windowStart } : {}), ...(windowEnd ? { windowEnd } : {}),
    ...(durationMinutes ? { durationMinutes } : {}), bufferMinutes: 0 });
  if (!fit.feasible) throw capacityError(fit.reason);
  // A grace narrower than the system's 120-minute promise: conditions may
  // have shifted between the offer (which already screened for this) and
  // this commit-time re-certification — never widen what was offered.
  if (arrivalExceedsGrace(fit, arrivalGraceMinutes)) throw capacityError('arrival_grace');
  await assertCapacityEligibility(conn, context, serviceTypes);
  return fit;
}

async function assertCapacityEligibility(conn, context, serviceTypes) {
  const { assertAssignableTechnician, NOT_ASSIGNABLE } = require('../technician-eligibility');
  try {
    await assertAssignableTechnician(context.target.technician_id, { conn, date: context.date });
  } catch (error) {
    if (error.code !== NOT_ASSIGNABLE) throw error;
    throw capacityError('technician_unavailable');
  }
  const members = serviceTypes?.map(service_type => ({ service_type }))
    || context.target.reservation_service_mix?.services?.map(service_type => ({ service_type }))
    || context.target.memberServices
    || [context.target];
  await require('../technician-capabilities').assertCapabilitiesActive(conn, context.target.technician_id, members,
    () => capacityError('technician_unavailable'));
  // Serialize against the blackout/weekly-days-off mutation endpoints
  // (routes/admin-schedule.js) before reading closure state: without this
  // shared lock, a READ COMMITTED read here can observe the pre-mutation
  // closure state and let the hold commit for a day an admin write closes a
  // moment later (codex #4346 P2). See blackout-dates.js for lock order.
  const { lockClosureState, getBlackoutLayers } = require('./blackout-dates');
  await lockClosureState(conn);
  if ((await getBlackoutLayers(context.date, context.date, conn)).dates.has(context.date)) {
    throw capacityError('day_unavailable');
  }
}

// One number per stop in the certified order; a stop already holding its
// number is not rewritten. Returns the order written.
async function writeRouteOrder(conn, fit, targetId) {
  const order = fit.routeOrder.map(id => id === '__candidate__' ? targetId : id);
  return writeOrderNumbers(conn, order, fit.target.scheduled_date, fit.target.technician_id);
}

// The fenced writer both placements share: where id, date and technician; only
// a row whose number changes is written.
async function writeOrderNumbers(conn, order, scheduledDate, technicianId) {
  for (let i = 0; i < order.length; i++) {
    await conn('scheduled_services').where({ id: order[i] })
      .where({ scheduled_date: scheduledDate, technician_id: technicianId })
      .whereRaw('route_order IS DISTINCT FROM ?', [i + 1]).update({ route_order: i + 1 });
  }
  return order;
}

async function persistArrivalOrder(conn, fit, targetId) {
  await writeRouteOrder(conn, fit, targetId);
  await recordCapacityDecision(conn, fit, targetId);
}

/** GATE_STAFF_ROUTE_INSERTION, capacity mode off: after a staff save moved a
 *  visit (another day, technician or start), or New Appointment booked one
 *  (GATE_NEW_APPT_STOP_ORDER; `source: 'new_appointment'` goes on the audit
 *  row), number its technician's day in the order the staff check
 *  certified. Until then such a visit has no number, and the board, the tech
 *  app and the tracking page list it after every numbered stop. Runs on the
 *  caller's save transaction under a savepoint: any failure keeps the save
 *  and leaves the numbers as they were. A day the check cannot certify (a save past its warning, a stop
 *  under way, a missing location, a shared stop) also stays as it was.
 *  Callers hold the tech-day fence; a busy one leaves the numbers to the
 *  writer holding it. A staff save (`staffSave`, GATE_SAVE_ROAD_TIMES)
 *  numbers a road day on the road times its check read. A staff save also
 *  passes `lateDays`: under GATE_ROUTE_CHECK_LATE_DAYS it certifies a day whose
 *  existing stops are already late by the same bounded rule the picker listed
 *  the hour under, and numbers the day in that order. Returns the order
 *  written, or null. */
async function placeMovedVisit(conn, { serviceId, source, staffSave = false, lateDays = false } = {}) {
  if (capacityEnabled() || !staffRouteInsertionLive() || !arrivalWindowRoutingEnabled()) return null;
  if (!conn?.isTransaction || !serviceId) return null;
  try {
    return await conn.transaction(sp => placeInSavepoint(sp, { serviceId, source, staffSave, lateDays }));
  } catch (error) {
    logger.warn(`[arrival-route] route order not placed for ${serviceId}: ${error.message}`);
    return null;
  }
}

// One line for every refusal past the gate checks (Route Check Everywhere,
// step 0): the reason a visit kept no stop number. Log only, no data write.
function refusePlacement(serviceId, source, reason, date) {
  logger.info(`[arrival-route] route order not placed: service=${String(serviceId).slice(0, 8)} source=${source || '-'} reason=${reason} date=${date || '-'}`);
  return null;
}

// GATE_ROUTE_ORDER_TIME_FALLBACK (owner 2026-11-01): the check refused, so number the day by arrival time
// (route-order-time-fallback.js) instead of leaving the visit last. Ordering only, no arrival simulation;
// runs inside placeInSavepoint's savepoint, under the tech-day lock it holds.
async function placeByTimeAfterRefusal(sp, { context, serviceId, source, date, technicianId, reason }) {
  const order = timeFallbackOrder(context.rows, { ...context.target, id: serviceId, technician_id: technicianId });
  await writeOrderNumbers(sp, order, date, technicianId);
  logger.info(`[arrival-route] route order placed by time after refusal: service=${String(serviceId).slice(0, 8)} reason=${reason}`);
  await require('../audit-log').recordAuditEvent({ actor_type: 'system', action: 'schedule.route_order_placed',
    resource_type: 'scheduled_service', resource_id: serviceId, critical: true, trx: sp,
    metadata: { policy: 'route_order_time_fallback_2026_11_01', reason, route_order: order, ...(source ? { source } : {}) } });
  return order;
}

async function placeInSavepoint(sp, { serviceId, source, staffSave, lateDays }) {
  const row = await sp('scheduled_services').where({ id: serviceId })
    .first('scheduled_date', 'technician_id', 'window_start', 'window_end');
  const date = row ? dateOnly(row.scheduled_date) : '';
  const refuse = reason => refusePlacement(serviceId, source, reason, date);
  if (!row) return refuse('no_context');
  if (!row.technician_id) return refuse('unassigned');
  if (!row.window_start || !date) return refuse('untimed');
  if (!await require('./tech-day-lock').lockTechDays(sp, [{ techId: row.technician_id, date }], { wait: false })) return refuse('lock_busy');
  // From the office, like every commit-time check (tech-start-point.js):
  // the save probe certified this day from there, so the same order wins.
  const context = await loadArrivalRouteContext({ conn: sp, serviceId, date, technicianId: row.technician_id });
  if (!context) return refuse('no_context');
  if (context.grouped) return refuse('grouped');
  if (staffSave === true) context.travel = staffSaveTravel(date);
  // `lateDays` (GATE_ROUTE_CHECK_LATE_DAYS, the staff saves' callers only): the save numbers the day in
  // the same bounded late-day order its picker offered the hour on. The automatic writers never pass it.
  const fit = evaluateArrivalPlacement(context, { windowStart: String(row.window_start).slice(0, 5),
    windowEnd: row.window_end ? String(row.window_end).slice(0, 5) : undefined, place: true,
    ...(lateDays === true && gateEnvValue('GATE_ROUTE_CHECK_LATE_DAYS') ? { lateDays: true } : {}) });
  // GATE_ROUTE_ORDER_TIME_FALLBACK: a refused check still numbers the visit by its arrival time.
  const refuseOrNumberByTime = async reason => {
    const refused = refuse(reason);
    if (!(typeof routeOrderTimeFallbackLive === 'function' && routeOrderTimeFallbackLive())) return refused;
    return placeByTimeAfterRefusal(sp, { context, serviceId, source, date, technicianId: row.technician_id, reason });
  };
  if (!fit.feasible) return refuseOrNumberByTime(fit.reason || 'no_order');
  if (!fit.routeOrder) return refuseOrNumberByTime('no_order');
  const order = await writeRouteOrder(sp, fit, serviceId);
  await require('../audit-log').recordAuditEvent({ actor_type: 'system', action: 'schedule.route_order_placed',
    resource_type: 'scheduled_service', resource_id: serviceId, critical: true, trx: sp,
    metadata: { policy: 'staff_route_insertion_2026_10_25', route_order: order, ...(source ? { source } : {}) } });
  return order;
}

// Conversion expands a certified combined anchor without changing its route position.
async function persistCapacityAllocation(conn, anchor, memberIds) {
  // Accept callers pre-acquire this fence before their first row lock.
  // Other converter callers may already hold rows: never wait in reverse
  // order. A busy reorder rolls this allocation back for a recoverable retry.
  if (!await require('./tech-day-lock').lockTechDays(conn,
    [{ techId: anchor.technician_id, date: dateOnly(anchor.scheduled_date) }], { wait: false })) throw capacityError();
  const rows = await conn('scheduled_services').where({ scheduled_date: dateOnly(anchor.scheduled_date),
    technician_id: anchor.technician_id }).select('id', 'route_order', 'window_start', 'created_at');
  const order = currentOrder(rows).filter(row => row.id === anchor.id || !memberIds.includes(row.id))
    .flatMap(row => row.id === anchor.id ? memberIds : [row.id]);
  if (!order.includes(anchor.id)) throw capacityError();
  for (const [index, id] of order.entries()) await conn('scheduled_services').where({ id }).update({ route_order: index + 1 });
  await require('../audit-log').recordAuditEvent({ actor_type: 'system', action: 'schedule.capacity_allocated',
    resource_type: 'scheduled_service', resource_id: anchor.id, critical: true, trx: conn,
    metadata: { route_order: order, allocated_service_ids: memberIds } });
}

async function recordCapacityDecision(conn, fit, targetId) {
  const order = fit.routeOrder.map(id => id === '__candidate__' ? targetId : id);
  // Audit application-owned decisions, never Google response bodies or legs.
  await require('../audit-log').recordAuditEvent({ actor_type: 'system', action: 'schedule.capacity_verified',
    resource_type: 'scheduled_service', resource_id: targetId, critical: true, trx: conn,
    metadata: { policy: 'capacity_2026_09_09', route_order: order,
      travel_source: fit.travelSource, reason_codes: fit.travelReasons,
      finish_minute: fit.finishMinute, occupied_minutes: fit.occupiedMinutes } });
}

// Staff checks agree with the pickers' list (GATE_PICKER_ROAD_CHECK): a
// route under way today continues from the tech's current stop (a caller
// may opt out: the automatic tech-out mover). `roads: true` also drives the
// placement on the same Google road times as the list (the pickers' road
// days and cache, so an hour the list offered is mostly answered from it;
// a later day stays on the model, as in the list). Opt-in (Codex #6881 r3):
// only a staff caller outside any lock asks — never a technician (the
// allowance is staff-only) and never a save probe inside its transaction
// (road times are preloaded before a scheduling lock). `roadSpender` = the
// staff user the lookups are counted against (picker-road-spend.js); none =
// no Google. `pickerBudget` = the request's shared budget, when it has one.
// The staff pickers' Google route check (GATE_PICKER_ROAD_CHECK). Under
// GATE_SCHEDULING_CAPACITY the pickers list the capacity engine's hours
// (find-time.js findCapacitySlots), which this check does not drive, so it
// stays off there too: a listed hour and its live check never disagree.
function pickerRoadCheckLive() {
  return gateEnvValue('GATE_PICKER_ROAD_CHECK') && !capacityEnabled();
}

// GATE_ROUTE_CHECK_STAFF_LISTS (owner 2026-10-29, "Route Check Everywhere"
// build 1): the staff day lists (the Reschedule window's suggested days, the
// Quick Move day buttons, the Intelligence Bar's find_available_slots) rank
// and filter by the dispatcher's arrival-window route check
// (scheduling/route-ranked-days.js). Read at call time; callers also need
// arrivalWindowRoutingEnabled(). Unset = today's lists, byte for byte.
function routeCheckStaffListsLive() {
  return gateEnvValue('GATE_ROUTE_CHECK_STAFF_LISTS');
}

// GATE_SAVE_ROAD_TIMES (owner 2026-10-28, "yes do this"): a staff save's
// check and its route number read the road times the pickers bought for that
// day (`roads: 'cache'`), so a save agrees with the hour its picker offered.
// Cache only: no Google call inside a save's transaction and no spend; a
// drive no picker looked up keeps the model. Needs the pickers' road check.
function saveRoadTimesLive() {
  return gateEnvValue('GATE_SAVE_ROAD_TIMES') && pickerRoadCheckLive();
}

// GATE_ROUTE_CHECK_STAFF_SAVES (owner 2026-10-29, "start the builds", Route
// Check Everywhere build 2a): the staff saves that checked only for an overlap
// (New Appointment, lead booking, the Intelligence Bar's create, reschedule
// and move-stops tools, bulk reschedule) also run the dispatcher's
// arrival-window route check on the saved visit and show its warning. Warn
// only: a route result never blocks a save. Cache road times only
// (`roads: 'cache'`, no Google call). Needs the arrival-window route check
// itself (arrivalWindowRoutingEnabled), the check that Edit's save runs.
function routeCheckStaffSavesLive() {
  return gateEnvValue('GATE_ROUTE_CHECK_STAFF_SAVES') && arrivalWindowRoutingEnabled();
}

// GATE_ROUTE_CHECK_AUTO_SAVES (owner 2026-10-29, "start the builds", Route
// Check Everywhere build 2b): the automatic writers that create or move a
// visit (completion and package follow-ups, annual prepay renewals, call
// bookings) number the visit's technician day in the dispatcher's order
// (placeMovedVisit, cache road times only). No warning, no notification, no
// message, no Google call. Needs the arrival-window route check itself.
function routeCheckAutoSavesLive() {
  return gateEnvValue('GATE_ROUTE_CHECK_AUTO_SAVES') && arrivalWindowRoutingEnabled();
}

// GATE_ROUTE_CHECK_ACCEPT_SAVES (owner 2026-10-29, "ok go", Route Check
// Everywhere follow-up item 1): an accepted estimate's visit gets its stop
// number in the accept's own save. A held slot that graduates
// (slot-reservation.js commitReservation, also a one-tap booking) and the
// converter's same-trip standalone parent are numbered (placeMovedVisit,
// source 'estimate_accept'). Stop numbers only: no message, no notification,
// no Google call. Needs the arrival-window route check itself.
function routeCheckAcceptSavesLive() {
  return gateEnvValue('GATE_ROUTE_CHECK_ACCEPT_SAVES') && arrivalWindowRoutingEnabled();
}

// GATE_ROUTE_CHECK_ASSIGN_SAVES (same follow-up, item 1): an office board
// assign (PUT /api/admin/dispatch/jobs/:id/assign) numbers the visit on its
// new technician's day (placeMovedVisit, source 'dispatch_assign') instead of
// leaving it unnumbered after the assign cleared the old number. Stop numbers
// only; the assign itself is unchanged. Needs the arrival-window route check.
function routeCheckAssignSavesLive() {
  return gateEnvValue('GATE_ROUTE_CHECK_ASSIGN_SAVES') && arrivalWindowRoutingEnabled();
}

// GATE_ROUTE_CHECK_BOOKING_SAVES (owner 2026-10-30, "ok go", Route Check
// Everywhere follow-up): a new or moved customer-booked visit gets its stop
// number in the booking's own save (placeMovedVisit). Covers /book and the
// re-service, inspection and commercial first-visit pages (createSelfBooking),
// the customer reschedule page, the voice agent's booking and the new-caller
// visit. Stop numbers only:
// no message, no notification, no Google call. Needs the arrival-window route
// check itself.
function routeCheckBookingSavesLive() {
  return gateEnvValue('GATE_ROUTE_CHECK_BOOKING_SAVES') && arrivalWindowRoutingEnabled();
}

// A staff save's travel for `date`: on a road day, the road times the pickers
// bought (cache only, never a purchase); otherwise null, the model.
function staffSaveTravel(date) {
  const roadTimes = require('./hint-road-times');
  return saveRoadTimesLive() && roadTimes.onRoads(date, etDateString(new Date()))
    ? roadTimes.createPickerTravel({ cacheOnly: true }) : null;
}

// GATE_SAVE_ROAD_BUY (owner 2026-10-28 design, "ok go" 2026-10-29): before an
// ADMIN staff save opens its transaction, buy the Google road times its own
// check and route number will read, for the legs no picker bought. The save
// then reads them from the cache (GATE_SAVE_ROAD_TIMES), so the New
// Appointment save, the Edit save and the Edit dialog's slot check agree.
// Needs the save road times and the pickers' road check.
function saveRoadBuyLive() {
  return gateEnvValue('GATE_SAVE_ROAD_BUY') && saveRoadTimesLive() && arrivalWindowRoutingEnabled();
}

// One save buys at most this many lookups (about 15 cents) and waits at most
// this long: a slow Google never stalls a save.
const SAVE_BUY_MAX_LOOKUPS = 15;
const SAVE_BUY_TIMEOUT_MS = 2000;

/** Buys the road times one staff save will read (GATE_SAVE_ROAD_BUY). Call it
 *  BEFORE the save's transaction, scheduling lock and row lock: it refuses to
 *  run on a transaction. Admin callers only (`spender` = the staff user, the
 *  one the lookups count against; a technician or an automatic writer passes
 *  none). `serviceId` + `changes` describe a visit being moved or edited;
 *  `prospective` ({ lat, lng, estimated_duration_minutes, service_type })
 *  describes a visit about to be created. It evaluates the save's two reads:
 *  the advisory arrival check, then the route number's placement (`place`),
 *  (`check: false` leaves out the first, for a move that runs none), and asks
 *  Google only for the legs still missing, inside the pickers' spend
 *  ceilings (picker-road-spend.js). Never throws, never blocks: a refused,
 *  failed or slow purchase leaves the save on the cache and the model, as
 *  before. Returns { lookups, skipped?, refused?, timedOut? }. */
async function buySaveRoads({
  spender = null, serviceId = null, prospective = null, changes = {}, date, technicianId,
  windowStart, windowEnd, excludeServiceIds = [], conn = db, check = true,
  maxLookups = SAVE_BUY_MAX_LOOKUPS, timeoutMs = SAVE_BUY_TIMEOUT_MS,
} = {}) {
  const roadTimes = require('./hint-road-times');
  const day = dateOnly(date);
  // The first refusal that applies, in order; a purchase runs only when none does.
  const [, skipped] = [
    [!saveRoadBuyLive(), 'gate'],
    [conn?.isTransaction, 'in_transaction'],
    [!spender, 'no_spender'],
    [!(day && technicianId && windowStart && (serviceId || prospective)), 'no_placement'],
    [!roadTimes.onRoads(day, etDateString(new Date())), 'not_road_day'],
  ].find(([refused]) => refused) || [];
  if (skipped) return { lookups: 0, skipped };
  const controller = new AbortController();
  const budget = roadTimes.createPickerBudget({ signal: controller.signal, maxLookups });
  const [start, end] = [windowStart, windowEnd].map((value) => String(value ?? '').slice(0, 5) || undefined);
  const work = async () => {
    const load = (extra) => loadArrivalRouteContext({
      conn, serviceId, prospective, date: day, technicianId, changes, cacheLocation: true, ...extra,
    });
    const checkContext = await load({ fromActiveStop: pickerRoadCheckLive(), excludeServiceIds });
    // The route number is read from a context with no exclusions and no active
    // stop (placeMovedVisit); reuse the check's when it is the same one.
    const placeContext = staffRouteInsertionLive() && !capacityEnabled()
      && (excludeServiceIds.length || checkContext?.activeStop ? await load({}) : checkContext);
    const travel = roadTimes.createPickerTravel({ spender, budget });
    // `check: false` = a move that numbers the day but runs no advisory check (Quick Move).
    const reads = [[check && checkContext, { allowInsertion: false }], [placeContext, { place: true }]]
      .filter(([context]) => context);
    reads.forEach(([context]) => { context.travel = travel; });
    // Three passes, as checkArrivalPlacement: a re-timed leg is asked again.
    for (let pass = 0; pass < 3 && !budget.refused && !controller.signal.aborted; pass++) {
      const before = budget.traffic + budget.plain;
      const legs = [];
      reads.forEach(([context, mode]) => evaluateArrivalPlacement(context, { windowStart: start, windowEnd: end, ...mode, collectLegs: legs }));
      await travel.preload(legs);
      if (budget.traffic + budget.plain === before) break;
    }
  };
  let timer;
  // Never throws, never waits past the limit: any failure is an outcome, not an error.
  const outcome = await Promise.race([
    work().then(() => 'done', (error) => { logger.warn(`[arrival-route] save road purchase skipped: ${error.message}`); return 'error'; }),
    new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve('timeout'); }, timeoutMs); }),
  ]);
  clearTimeout(timer);
  const lookups = budget.traffic + budget.plain;
  logger.info(`[arrival-route] save road purchase: ${lookups} lookups, ${outcome}, refused: ${budget.refused || 'no'}`);
  return { lookups, refused: budget.refused || undefined, timedOut: outcome === 'timeout' };
}

async function checkArrivalPlacement({
  windowStart, windowEnd, durationMinutes, roads = false, roadSpender = null, pickerBudget = null, detail = false, lateDays = false, ...options
}) {
  const live = pickerRoadCheckLive();
  const context = await loadArrivalRouteContext({ fromActiveStop: live, ...options });
  // `lateDays` (GATE_ROUTE_CHECK_LATE_DAYS): only the staff picked-hour verdict asks for it, so an hour the
  // list offered on an already-late day is judged the same when picked. Saves and every other caller do not.
  const placement = { windowStart, windowEnd, durationMinutes, allowInsertion: false, ...(lateDays === true ? { lateDays: true } : {}) };
  const roadTimes = require('./hint-road-times');
  // A staff save reads the road times its picker bought; it never buys.
  if (context && roads === 'cache') context.travel = staffSaveTravel(options.date);
  if (context && live && roads === true && roadTimes.onRoads(options.date, etDateString(new Date()))) {
    context.travel = roadTimes.createPickerTravel({ spender: roadSpender, ...(pickerBudget ? { budget: pickerBudget } : {}) });
    // Three passes, as certifyArrivalPlacement: a re-timed leg is asked again.
    for (let pass = 0; pass < 3; pass++) {
      const legs = [];
      evaluateArrivalPlacement(context, { ...placement, collectLegs: legs });
      await context.travel.preload(legs);
    }
  }
  // A staff save's own check words its failure (GATE_ROUTE_WARNING_DETAIL); every other caller keeps the sentence.
  return evaluateArrivalPlacement(context, detail === true ? { ...placement, detail: true } : placement);
}


module.exports = {
  arrivalWindowRoutingEnabled, pickerRoadCheckLive, saveRoadBuyLive, buySaveRoads, loadArrivalRouteContext, evaluateArrivalPlacement, checkArrivalPlacement,
  enumerateArrivalPlacements,
  routeCheckStaffListsLive,
  groupRouteStops, workDuration,
  prepareArrivalCapacity, verifyArrivalCapacity, persistArrivalOrder, persistCapacityAllocation, capacityError,
  placeMovedVisit, INSERTION_MARGIN_MINUTES,
  _internals: { clockOrder, storedOrderStale, arrivalExceedsGrace, foldVisitUnit, comboRouteCheckLive, buildPlacementTarget, laterStopTooTight, staffSaveTravel },
};
module.exports.routeCheckStaffSavesLive = routeCheckStaffSavesLive;
module.exports.routeCheckAutoSavesLive = routeCheckAutoSavesLive;
module.exports.routeCheckAcceptSavesLive = routeCheckAcceptSavesLive;
module.exports.routeCheckAssignSavesLive = routeCheckAssignSavesLive;
module.exports.routeCheckBookingSavesLive = routeCheckBookingSavesLive;
