'use strict';

const { createHash } = require('node:crypto');
const { currentOrder, staleOrderReasons, effectiveWindowRange, simulateArrivalRoute } = require('../route-reorder-window-fit');
const { timeFallbackOrder } = require('../scheduling/route-order-time-fallback');
const { driveMin } = require('./geo');
const RouteOptimizer = require('../route-optimizer');

// Run-local evidence, like ROAD_LEGS. The audit log stores metrics, never the address inputs.
const ROUTE_POSITION = Symbol('dispatch route position');

function routeStamp(rows) {
  const facts = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(r => [
    r.id, r.visit_id, r.technician_id, r.status, r.window_start, r.window_end, r.route_order, r.created_at,
    r.reservation_expires_at, r.estimated_duration_minutes, r.service_type, r.is_recurring, r.is_callback,
    r.preserveCapacity, r.geo?.lat, r.geo?.lng, r.customer_id,
    r.service_address_line1, r.service_address_line2, r.service_address_city, r.service_address_zip,
    r.customer_address_line1, r.customer_address_line2, r.customer_city, r.customer_state, r.customer_zip,
  ]);
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

function targetStamp(row) {
  return JSON.stringify([row.id, row.customer_id ?? null, row.technician_id, row.status,
    String(row.window_start).slice(0, 5), String(row.window_end).slice(0, 5), Number(row.estimated_duration_minutes) || 0,
    row.service_type ?? null, !!row.is_recurring, !!row.is_callback, row.geo?.lat, row.geo?.lng]);
}

function routeFits(rows, order, origin, departureMin, blocks = []) {
  const byId = new Map(rows.map(r => [r.id, r]));
  const seq = order.map(id => byId.get(id));
  if (seq.some(r => !r || !r.window_start || r.lat == null || r.lng == null)) return false;
  return !!simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, seq, {
    origin, end: origin, startMin: departureMin, blockedIntervals: blocks, legMinutes: driveMin,
  });
}

// Existing commitments stay in the order dispatch reads. Insert the new window between those commitments.
// A group still travels through its own unit writer. Unassigned stops, holds and live routes retain their
// existing scoring and ownership. An otherwise supported insertion that misses a promise is refused.
function positionFor(stops, target, { origin, departureMin, sourceStamp }) {
  if (!sourceStamp || !target.technician_id || target.visit_id
      || stops.some(r => r.technician_id !== target.technician_id || r.reservation_expires_at
        || !['pending', 'confirmed'].includes(r.status) || r.geo == null)) return undefined;
  const numbered = currentOrder(stops).map((r, i) => ({ ...r, route_order: i + 1 }));
  if (staleOrderReasons(numbered).length) return null;
  const order = timeFallbackOrder(numbered, target);
  if (!order || !routeFits([...stops, target], order, origin, departureMin)) return null;
  return { order, sourceStamp, destinationStamp: routeStamp(stops), targetStamp: targetStamp(target), origin, departureMin };
}

module.exports = { ROUTE_POSITION, routeStamp, targetStamp, routeFits, positionFor };
