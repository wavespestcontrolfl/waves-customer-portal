/**
 * Staff appointment placement within the EXISTING two-hour arrival promises.
 * Extends the route-reorder simulation; never changes other visits' windows,
 * service durations, route_order, or customer communications. The order tested
 * is the order dispatch will show after saving this appointment.
 */
const db = require('../../models/db');
const RouteOptimizer = require('../route-optimizer');
const { gateEnvValue } = require('../../config/feature-gates');
const { etDateString, etParts } = require('../../utils/datetime-et');
const { NOT_A_ROUTE_STOP_STATUSES } = require('../stops-ahead');
const { dayStopsQuery, guardedCoordSelects } = require('./day-stops');
const { currentOrder, effectiveWindowRange, simulateArrivalRoute } = require('../route-reorder-window-fit');

const COLUMNS = [
  'id', 'customer_id', 'technician_id', 'scheduled_date', 'window_start', 'window_end',
  'estimated_duration_minutes', 'status', 'route_order', 'created_at', 'visit_id',
  'reservation_expires_at', 'actual_end_time', 'time_window',
];

function arrivalWindowRoutingEnabled() {
  return gateEnvValue('GATE_ADMIN_ARRIVAL_WINDOWS');
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

function workDuration(stop) {
  const start = minuteOfDay(stop.window_start);
  const end = minuteOfDay(stop.window_end);
  const span = start != null && end != null ? Math.max(0, end - start) : 0;
  return Math.max(span, Number(stop.estimated_duration_minutes) || 0) || 60;
}

async function loadArrivalRouteContext({
  conn = db, serviceId, date, technicianId, excludeServiceIds = [], changes = {}, now = new Date(),
}) {
  const stored = await conn('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .where('scheduled_services.id', serviceId)
    .first(...COLUMNS.map(c => `scheduled_services.${c}`), ...guardedCoordSelects(conn));
  if (!stored) return null;
  const techId = technicianId === undefined
    ? (Object.prototype.hasOwnProperty.call(changes, 'technician_id') ? changes.technician_id : stored.technician_id)
    : technicianId;
  const target = { ...stored, ...changes, technician_id: techId, scheduled_date: date };
  if (dateOnly(stored.scheduled_date) !== date || (stored.technician_id || null) !== (techId || null)) {
    target.route_order = null;
  }
  const rows = await dayStopsQuery(conn, {
    dateStr: date,
    excludeStatuses: NOT_A_ROUTE_STOP_STATUSES,
    select: [...COLUMNS.map(c => `scheduled_services.${c}`), ...guardedCoordSelects(conn)],
  }).where(q => q.whereNull('scheduled_services.reservation_expires_at')
      .orWhereRaw('scheduled_services.reservation_expires_at > NOW()'));
  const excluded = new Set([serviceId, ...excludeServiceIds].map(String));
  // Grouped work needs the unit mover's complete duration/placement. Do not
  // certify a partial group by excluding siblings from the simulated route.
  const grouped = !!target.visit_id && !!(await conn('scheduled_services')
    .where({ visit_id: target.visit_id }).whereNot('id', serviceId)
    .whereNotIn('status', NOT_A_ROUTE_STOP_STATUSES).first('id'));
  return { target, rows: rows.filter(row => !excluded.has(String(row.id))), date, now, grouped };
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
function evaluateArrivalPlacement(context, { windowStart, windowEnd, durationMinutes, dayEndMin = 20 * 60 }) {
  if (!context) return unverified(null, 'this date');
  const { date, rows, now, grouped } = context;
  const target = {
    ...context.target, window_start: windowStart, window_end: windowEnd,
    estimated_duration_minutes: durationMinutes ?? context.target.estimated_duration_minutes,
  };
  const own = rows.filter(row => row.technician_id === target.technician_id && row.reservation_expires_at == null);
  if (!target.technician_id || !hasCoords(target) || grouped || own.some(row => !hasCoords(row))) {
    return unverified(target, date);
  }
  let origin = RouteOptimizer.HQ;
  let startMin = 8 * 60;
  const today = date === etDateString(now);
  if (today) {
    // An in-progress stop needs live remaining-work/travel truth. Never sell
    // a fit by pretending the technician can restart that day from HQ.
    if (own.some(row => ['en_route', 'on_site'].includes(row.status))) return unverified(target, date);
    const parts = etParts(now);
    startMin = Math.max(startMin, parts.hour * 60 + parts.minute);
    const completed = own.filter(row => row.status === 'completed');
    if (completed.some(row => !row.actual_end_time)) return unverified(target, date);
    completed.sort((a, b) => new Date(b.actual_end_time) - new Date(a.actual_end_time));
    if (completed.length) origin = completed[0];
  }
  const pending = own.filter(row => row.status !== 'completed');
  const ordered = currentOrder([...pending, target]).map(row => ({ ...row, estimated_duration_minutes: workDuration(row) }));
  const simulation = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, ordered, { origin, startMin, dayEndMin });
  const fail = {
    feasible: false, target, reason: 'arrival_window',
    warning: `The route on ${date} cannot keep every promised arrival window with the planned service and driving times. Review the stop order or choose another window.`,
  };
  if (!simulation) return fail;
  // Keep the tech-blind occupancy guard: unassigned visits, other-tech work,
  // and live holds have NOT been proven movable by this route simulation.
  const fixed = rows.filter(row => row.technician_id !== target.technician_id || row.reservation_expires_at != null);
  const hitsFixed = simulation.arrivals.some((arrival, index) => fixed.some(row => {
    if (row.id === arrival.id || row.status === 'completed') return false;
    const start = minuteOfDay(row.window_start);
    // Driving and waiting also consume the technician's available time.
    const occupiedFrom = index === 0 ? startMin : simulation.arrivals[index - 1].departureMin;
    return start != null && occupiedFrom < start + workDuration(row) && arrival.departureMin > start;
  }));
  if (hitsFixed) return fail;
  const arrival = simulation.arrivals.find(row => row.id === target.id);
  const baselineDrive = routeDriveMinutes(currentOrder(pending), origin);
  return {
    feasible: true, target,
    estimatedArrival: hhmm(arrival.arrivalMin),
    detourMinutes: Math.max(0, simulation.travelMin - baselineDrive),
    driveMinutes: simulation.travelMin,
    waitingMinutes: simulation.waitingMin,
    arrivalDelayMinutes: arrival.arrivalMin - minuteOfDay(windowStart),
    arrivals: simulation.arrivals.map(row => ({ id: row.id, arrival: hhmm(row.arrivalMin), departure: hhmm(row.departureMin) })),
  };
}

async function checkArrivalPlacement({ windowStart, windowEnd, durationMinutes, ...options }) {
  const context = await loadArrivalRouteContext(options);
  return evaluateArrivalPlacement(context, { windowStart, windowEnd, durationMinutes });
}

module.exports = {
  arrivalWindowRoutingEnabled, loadArrivalRouteContext, evaluateArrivalPlacement, checkArrivalPlacement,
};
