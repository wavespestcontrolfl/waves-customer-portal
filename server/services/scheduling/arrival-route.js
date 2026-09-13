/**
 * Staff appointment placement within the EXISTING two-hour arrival promises.
 * Extends the route-reorder simulation; never changes other visits' windows,
 * service durations, or customer communications. Capacity writers certify
 * insertion orders and persist them with an audit inside the occupancy lock.
 */
const db = require('../../models/db');
const RouteOptimizer = require('../route-optimizer');
const { gateEnvValue } = require('../../config/feature-gates');
const { etDateString, etParts } = require('../../utils/datetime-et');
const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');
const { TERMINAL_ROW_STATUSES } = require('../visit-context/statuses');
const { dayStopsQuery, guardedCoordSelects, serviceLocationSelects, resolveServiceLocation } = require('./day-stops');
const { currentOrder, effectiveWindowRange, simulateArrivalRoute, workDuration } = require('../route-reorder-window-fit');
const { SHIFT, capacityEnabled, placementFitsShift } = require('./policy');
const { allocationKey, occupiedRows } = require('./visit-capacity');

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

async function loadArrivalRouteContext({
  conn = db, serviceId, prospective, date, technicianId, excludeServiceIds = [], excludeEstimateId,
  changes = {}, now = new Date(), travel, preserveCapacity = false,
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
  const location = await resolveServiceLocation(target, undefined, { cacheOnly: conn.isTransaction === true });
  target.lat = location.lat;
  target.lng = location.lng;
  if (dateOnly(stored.scheduled_date) !== date || (stored.technician_id || null) !== (techId || null)) {
    target.route_order = null;
  }
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
  const grouped = !!target.visit_id && !!(await conn('scheduled_services')
    .where({ visit_id: target.visit_id }).whereNot('id', serviceId)
    .whereNotIn('id', capacity ? [] : excludeServiceIds)
    .whereNotIn('status', TERMINAL_ROW_STATUSES).first('id'));
  const activeTarget = dateOnly(stored.scheduled_date) === date && ['en_route', 'on_site'].includes(stored.status);
  return { target, rows: rows.filter(row => !excluded.has(String(row.id))
    && (!capacity || row.window_start || row.time_window || ['completed', 'en_route', 'on_site'].includes(row.status))
    && !(excludeEstimateId && row.source_estimate_id === excludeEstimateId && row.reservation_expires_at)),
  date, now, grouped, activeTarget, prospective: !!prospective,
  insertTarget: dateOnly(stored.scheduled_date) !== date || stored.technician_id !== techId
    || (changes.window_start && String(changes.window_start).slice(0, 5) !== String(stored.window_start).slice(0, 5)),
  travel, preserveCapacity, blocks };
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

function unverified(target, date) {
  return {
    feasible: false, target, reason: 'route_unverified',
    warning: `Could not verify the route's arrival windows on ${date}. Review the route before driving it.`,
  };
}

function routeDriveMinutes(stops, origin) {
  let prev = origin;
  let total = 0;
  for (const stop of [...stops, RouteOptimizer.HQ]) {
    total += RouteOptimizer.fallbackLegMetrics(RouteOptimizer.haversine(prev.lat, prev.lng, stop.lat, stop.lng)).minutes;
    prev = stop;
  }
  return total;
}

/** Pure evaluation shared by the hint, live conflict check, and save probe. */
function evaluateArrivalPlacement(context, { windowStart, windowEnd, durationMinutes, dayEndMin = 20 * 60,
  departureMin, returnByMin, bufferMinutes = 0, collectLegs, allowInsertion = true }) {
  if (!context) return unverified(null, 'this date');
  const { date, rows, now, grouped, activeTarget } = context;
  const capacity = capacityEnabled() || context.preserveCapacity;
  if (capacity) dayEndMin = Math.min(dayEndMin, SHIFT.endMinutes);
  const target = {
    ...context.target, window_start: windowStart, window_end: windowEnd,
    // The target's REAL work — its own stored estimate, captured BEFORE the
    // line below replaces it with the window span, and NEVER the
    // window-derived `durationMinutes` (find-time-hints passes the selected
    // span there, and treating a span as additive work charges a 20-minute
    // job in a 60-minute window 60 minutes beside its sibling — codex #4435
    // r3/r4 P1). A genuinely long service is still covered: the chain's
    // floor is the longest member's workDuration, which includes it.
    raw_estimate_minutes: Number(context.target?.estimated_duration_minutes) || 0,
    estimated_duration_minutes: context.prospective ? Number(durationMinutes)
      : Math.max(workDuration(context.target), Number(durationMinutes) || 0),
  };
  if (capacity && !placementFitsShift(minuteOfDay(windowStart), minuteOfDay(windowEnd))) return unverified(target, date);
  const own = rows.filter(row => row.technician_id === target.technician_id && (capacity || row.reservation_expires_at == null));
  if (!target.technician_id || !hasCoords(target) || grouped) {
    return unverified(target, date);
  }
  let origin = RouteOptimizer.HQ;
  // Staff may promise an early on-the-hour arrival; depart early enough
  // to model that route instead of imposing the public finder's 8 AM floor.
  let startMin = capacity ? Math.max(SHIFT.startMinutes, departureMin ?? SHIFT.startMinutes)
    : departureMin ?? Math.min(8 * 60, ...[target, ...own].map(row => effectiveWindowRange(row)?.startMin ?? Infinity));
  const today = date === etDateString(now);
  if (today) {
    // An in-progress stop needs live remaining-work/travel truth. Never sell
    // a fit by pretending the technician can restart that day from HQ.
    if (activeTarget || own.some(row => ['en_route', 'on_site'].includes(row.status))) return unverified(target, date);
    const parts = etParts(now);
    startMin = Math.max(startMin, parts.hour * 60 + parts.minute);
    const completed = own.filter(row => row.status === 'completed').map(row => ({
      ...row, completionTime: row.actual_end_time || row.check_out_time || row.completed_at,
    }));
    if (completed.some(row => !row.completionTime)) return unverified(target, date);
    completed.sort((a, b) => new Date(b.completionTime) - new Date(a.completionTime));
    if (completed.length) origin = completed[0];
  }
  const pending = own.filter(row => row.status !== 'completed');
  if (!hasCoords(origin) || pending.some(row => !hasCoords(row))) return unverified(target, date);
  const groupedPending = capacity ? groupRouteStops(pending) : pending;
  if (!groupedPending) return unverified(target, date);
  const baseline = currentOrder(groupedPending);
  const orders = capacity && allowInsertion && (context.prospective || context.insertTarget)
    ? Array.from({ length: baseline.length + 1 }, (_, i) => [...baseline.slice(0, i), target, ...baseline.slice(i)])
    : [currentOrder([...baseline, target])];
  const rangeForStop = row => row.arrivalRange || effectiveWindowRange(row);
  let winner = null;
  let returnTooLate = false;
  for (const order of orders) {
    const usedLegs = [];
    const travel = context.travel || (capacity ? RouteOptimizer.createSchedulingTravel({ maxRequests: 0 }) : null);
    const simulation = simulateArrivalRoute(RouteOptimizer, rangeForStop,
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
        origin, startMin, dayEndMin, includeReturnInFinish: capacity, bufferMinutes,
        blockedIntervals: (context.blocks || []).map(block => ({ startMin: minuteOfDay(block.start_time), endMin: minuteOfDay(block.end_time) })),
        ...(travel ? { legMinutes: (from, to, departureMin) => {
          const leg = { date, from, to, departureMin };
          const metric = travel.lookup(leg);
          usedLegs.push({ ...leg, ...metric });
          return metric.minutes;
        } } : {}),
      });
    if (collectLegs) collectLegs.push(...usedLegs);
    if (!simulation) continue;
    if (Number.isFinite(returnByMin) && simulation.returnAtMin > returnByMin) {
      returnTooLate = true;
      continue;
    }
    // Capacity models the selected technician's route; unassigned work still
    // blocks it, including the drive home. Legacy placement keeps its shared
    // occupancy rule for other technicians and live holds.
    const fixedRows = rows.filter(row => row.status !== 'completed'
      && (capacity ? row.technician_id == null
        : row.technician_id !== target.technician_id || row.reservation_expires_at != null));
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
    if (!winner || simulation.travelMin < winner.simulation.travelMin
      || (simulation.travelMin === winner.simulation.travelMin && simulation.waitingMin < winner.simulation.waitingMin)) {
      winner = { simulation, order, usedLegs };
    }
  }
  const fail = {
    feasible: false, target, reason: 'arrival_window',
    warning: `The route on ${date} cannot keep every promised arrival window with the planned service and driving times. Review the stop order or choose another window.`,
  };
  if (!winner) return returnTooLate
    ? { ...fail, reason: 'return_time', warning: `The modeled route returns after the requested workday limit on ${date}.` }
    : fail;
  const { simulation, order, usedLegs } = winner;
  // Fixed blockers remain immovable; selected-technician holds are included
  // in the capacity route alongside that technician's appointments.
  const arrival = simulation.arrivals.find(row => row.id === target.id);
  const baselineDrive = routeDriveMinutes(currentOrder(pending), origin);
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
      routeOrder: [...currentOrder(own.filter(row => row.status === 'completed')).map(row => row.id),
        ...order.flatMap(row => row.memberIds || [row.id])],
      travelSource: usedLegs.every(leg => leg.source === 'google_traffic') ? 'google_traffic' : 'conservative_model',
      travelReasons: [...new Set(usedLegs.map(leg => leg.reason).filter(Boolean))],
    } : {}),
    arrivalDelayMinutes: arrival.arrivalMin + (target.arrivalOffsetMinutes || 0) - minuteOfDay(windowStart),
    arrivals: simulation.arrivals.map(row => ({ id: row.id, arrival: hhmm(row.arrivalMin), departure: hhmm(row.departureMin) })),
  };
}

/** One on-the-hour enumeration for the staff finder and read-only gap
 * measurements. Both evaluate the order the existing save would produce. */
function enumerateArrivalPlacements(context, { durationMinutes, earliestStartMin, latestServiceEndMin = 20 * 60, ...limits }) {
  const placements = [];
  const rejections = {};
  let evaluated = 0;
  for (let start = Math.ceil(earliestStartMin / 60) * 60; start + durationMinutes <= latestServiceEndMin; start += 60) {
    evaluated++;
    const windowStart = hhmm(start);
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

async function verifyArrivalCapacity(prepared, { conn, windowStart, windowEnd, durationMinutes, serviceTypes } = {}) {
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
  await assertCapacityEligibility(conn, context, serviceTypes);
  return fit;
}

async function assertCapacityEligibility(conn, context, serviceTypes) {
  const { assertAssignableTechnician, NOT_ASSIGNABLE } = require('../technician-eligibility');
  try {
    await assertAssignableTechnician(context.target.technician_id, { conn });
  } catch (error) {
    if (error.code !== NOT_ASSIGNABLE) throw error;
    throw capacityError('technician_unavailable');
  }
  const members = serviceTypes?.map(service_type => ({ service_type }))
    || context.target.reservation_service_mix?.services?.map(service_type => ({ service_type }))
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

async function persistArrivalOrder(conn, fit, targetId) {
  const order = fit.routeOrder.map(id => id === '__candidate__' ? targetId : id);
  for (let i = 0; i < order.length; i++) {
    await conn('scheduled_services').where({ id: order[i] })
      .where({ scheduled_date: fit.target.scheduled_date, technician_id: fit.target.technician_id })
      .whereRaw('route_order IS DISTINCT FROM ?', [i + 1]).update({ route_order: i + 1 });
  }
  await recordCapacityDecision(conn, fit, targetId);
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

async function checkArrivalPlacement({ windowStart, windowEnd, durationMinutes, ...options }) {
  const context = await loadArrivalRouteContext(options);
  return evaluateArrivalPlacement(context, { windowStart, windowEnd, durationMinutes, allowInsertion: false });
}


module.exports = {
  arrivalWindowRoutingEnabled, loadArrivalRouteContext, evaluateArrivalPlacement, checkArrivalPlacement,
  enumerateArrivalPlacements,
  groupRouteStops, workDuration,
  prepareArrivalCapacity, verifyArrivalCapacity, persistArrivalOrder, persistCapacityAllocation, capacityError,
};
