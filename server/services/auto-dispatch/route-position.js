'use strict';

const { createHash } = require('node:crypto');
const { currentOrder, staleOrderReasons, effectiveWindowRange, simulateArrivalRoute } = require('../route-reorder-window-fit');
const { timeFallbackOrder } = require('../scheduling/route-order-time-fallback');
const { groupRouteStops } = require('../scheduling/arrival-route');
const { isHoldStop } = require('../scheduling/travel-gap');
const { driveMin } = require('./geo');
const { toDateStr } = require('./dates');
const RouteOptimizer = require('../route-optimizer');

// Run-local evidence, like ROAD_LEGS. The audit log stores metrics, never the address inputs.
const ROUTE_POSITION = Symbol('dispatch route position');

function routeStamp(rows, movingFrom = null) {
  const facts = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(r => [
    r.id, r.visit_id, r.technician_id, r.status, r.window_start, r.window_end, r.route_order, r.created_at,
    r.reservation_expires_at, r.reservation_service_mix, r.estimated_duration_minutes, r.service_type, r.is_recurring, r.is_callback,
    r.preserveCapacity, r.geo?.lat, r.geo?.lng, r.customer_id,
    r.service_address_line1, r.service_address_line2, r.service_address_city, r.service_address_zip,
    r.customer_address_line1, r.customer_address_line2, r.customer_city, r.customer_state, r.customer_zip,
  ]);
  // The mover's original time and stop number affect the drive saved on its source day.
  const sourcePlacement = movingFrom && [movingFrom.id, toDateStr(movingFrom.scheduled_date ?? movingFrom.dateStr),
    movingFrom.technician_id ?? null, movingFrom.route_order ?? null,
    String(movingFrom.window_start).slice(0, 5), String(movingFrom.window_end).slice(0, 5)];
  return createHash('sha256').update(JSON.stringify([facts, sourcePlacement])).digest('hex');
}

function targetStamp(row) {
  return JSON.stringify([row.id, row.customer_id ?? null, row.technician_id, row.status,
    String(row.window_start).slice(0, 5), String(row.window_end).slice(0, 5), Number(row.estimated_duration_minutes) || 0,
    row.service_type ?? null, !!row.is_recurring, !!row.is_callback, row.reservation_service_mix ?? null,
    row.geo?.lat, row.geo?.lng]);
}

function routeFits(rows, order, { origin, departureMin, dayEndMin, blocks = [] }) {
  const byId = new Map(rows.map(r => [r.id, r]));
  if (order.length !== rows.length || byId.size !== rows.length || new Set(order).size !== rows.length) return false;
  // groupRouteStops canonicalizes through currentOrder, so stamp the
  // projected numbers first; the mover still carries its source-day number
  // on the row object until the writer persists this destination order.
  const seq = order.map((id, index) => ({ ...byId.get(id), route_order: index + 1 }));
  if (!Number.isFinite(dayEndMin) || seq.some(r => !r || !r.window_start || r.lat == null || r.lng == null)) return false;
  // The canonical arrival model collapses visit_id groups and version-2
  // allocations into one physical arrival with summed work. It also rejects
  // a split group/allocation or members that disagree on technician/pin.
  // Keep `order` itself row-shaped: those member IDs are the route numbers
  // the writer persists after this feasibility check.
  const physical = groupRouteStops(seq);
  if (!physical) return false;
  return !!simulateArrivalRoute(RouteOptimizer, row => row.arrivalRange || effectiveWindowRange(row), physical, {
    origin, end: origin, startMin: departureMin, dayEndMin, blockedIntervals: blocks, legMinutes: driveMin,
  });
}

// Existing commitments stay in the order dispatch reads. Insert the new window between those commitments.
// A group still travels through its own unit writer. Unassigned stops, holds and live routes retain their
// existing scoring and ownership. An otherwise supported insertion that misses a promise is refused.
function positionFor(stops, target, {
  origin, sourceOrigin = origin, departureMin, dayEndMin, sourceStamp, blocks = [], configuredDeparture = false,
}) {
  // Moving one member of an allocation would price only part of its physical
  // stop. The unit mover supports visit_id groups; allocation-only units do
  // not have a corresponding writer, so fail closed instead of mispricing.
  if (target.reservation_service_mix?.version === 2) return null;
  if (!sourceStamp || !target.technician_id || target.visit_id
      || stops.some(r => r.technician_id !== target.technician_id || isHoldStop(r)
        || !['pending', 'confirmed'].includes(r.status) || r.geo == null)) return undefined;
  const numbered = currentOrder(stops).map((r, i) => ({ ...r, route_order: i + 1 }));
  if (staleOrderReasons(numbered).length) return null;
  const order = timeFallbackOrder(numbered, target);
  if (!order || !routeFits([...stops, target], order, { origin, departureMin, dayEndMin, blocks })) return null;
  return {
    order, sourceStamp, destinationStamp: routeStamp(stops), targetStamp: targetStamp(target),
    origin, sourceOrigin, departureMin, configuredDeparture: configuredDeparture === true,
  };
}

module.exports = { ROUTE_POSITION, routeStamp, targetStamp, routeFits, positionFor };
