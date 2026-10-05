// Drive minutes into and out of each stop on a technician's day, for the
// admin schedule's "~N min from last stop / ~N min to next" labels (owner ask
// 2026-10-03). DISPLAY ONLY: the straight-line estimate (driveMin, no paid
// routing call), nothing written, no stop reordered.
//
// Order is the one the day list shows: the tie-proximity displayOrder when
// stamped, else window start, then route_order. Rows of one physical stop (a
// visit group, or two services at the same coordinates) share their legs and
// never get a leg between each other. A cancelled, skipped or no-show row is
// not a stop. A missing coordinate yields null on its legs — never a 0 that would
// read as "next door".

const { driveMin } = require('../auto-dispatch/geo');
const RouteOptimizer = require('../route-optimizer');
const {
  simulateArrivalRoute, effectiveWindowRange, workDuration, startCoVisitChain, advanceCoVisit,
} = require('../route-reorder-window-fit');

// Visits the tech will not drive to.
const NOT_A_STOP = new Set(['cancelled', 'skipped', 'no_show']);

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : Infinity;
}

// The tie-proximity rule (schedule-tie-proximity.js hasCoords): a 0/0 pin
// is a failed geocode, never a place.
function hasGeo(s) {
  const lat = Number(s?.lat);
  const lng = Number(s?.lng);
  return s?.lat != null && s?.lng != null && Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
}

// One day-feed row as the route simulator reads a scheduled_services row,
// so its work comes from the same workDuration (owner planning minutes
// under GATE_SCHEDULING_CAPACITY, else window span or stored estimate).
function simRow(s) {
  return {
    id: s.id,
    window_start: s.windowStart,
    window_end: s.windowEnd,
    estimated_duration_minutes: 'rawEstimateMinutes' in s ? s.rawEstimateMinutes : s.estimatedDuration,
    service_type: s.serviceTypeRaw || s.serviceType,
    is_recurring: s.isRecurring === true,
    is_callback: s.isCallback === true,
  };
}

// isCoVisitPair's rule on day-feed rows: no visit group on either side, the
// same customer, the same promised window, the same pin and the same
// resolved premise (the feed's `address` is the effective service address,
// unit included). Anything unknown is not a pair.
function coVisitPair(a, b) {
  if (a.visitId || b.visitId) return false;
  if (a.customerId == null || String(a.customerId) !== String(b.customerId)) return false;
  if (minutesOf(a.windowStart) !== minutesOf(b.windowStart)) return false;
  if (!samePlace(a, b)) return false;
  return Boolean(a.address) && a.address === b.address;
}

// On-site minutes for one physical stop, with the simulator's own pieces:
// a visit group sums its rows (arrival-route.js groupRouteStops); a run of
// co-visit rows is one chain (startCoVisitChain/advanceCoVisit, so two
// span-only rows sharing an hour stay one hour); every other piece adds up.
function stopWork(members) {
  const groups = new Map();
  const loose = [];
  for (const m of members) {
    if (!m.visitId) { loose.push(m); continue; }
    if (!groups.has(m.visitId)) groups.set(m.visitId, []);
    groups.get(m.visitId).push(simRow(m));
  }
  let work = 0;
  for (const g of groups.values()) work += g.reduce((sum, r) => sum + workDuration(r), 0);
  let chain = null;
  let prev = null;
  for (const m of loose) {
    if (chain && coVisitPair(prev, m)) {
      chain = advanceCoVisit(chain, simRow(m));
    } else {
      if (chain) work += chain.coMerged;
      chain = { ...startCoVisitChain(simRow(m)), arrivalMin: 0 };
      chain.clock = chain.coMerged;
    }
    prev = m;
  }
  if (chain) work += chain.coMerged;
  return work;
}

// Minutes past each stop's 2-hour arrival window, from the shared route
// simulator (simulateArrivalRoute, reportLate): the clock carries every
// earlier delay forward, waits for a window to open, and uses the same legs
// the lines show. The day starts at the first stop at its booked time.
// After a leg that cannot be measured, arrivals are unknown: no lateness.
function lateByStop(stops, legs) {
  const seq = stops.map((st) => ({
    id: st.legs[0].id,
    window_start: st.legs[0].windowStart,
    estimated_duration_minutes: stopWork(st.members),
    memberIds: st.members.map((m) => m.id),
    lat: st.anchor.lat,
    lng: st.anchor.lng,
  }));
  const known = legs.findIndex((l) => l == null);
  const upTo = known === -1 ? seq.length : known + 1;
  if (upTo < 2) return new Map();
  const legById = new Map(seq.slice(1).map((r, i) => [r.id, legs[i]]));
  const sim = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, seq.slice(0, upTo), {
    startMin: minutesOf(seq[0].window_start),
    origin: { lat: Number(seq[0].lat), lng: Number(seq[0].lng) },
    reportLate: true,
    legMinutes: (_prev, stop) => legById.get(stop.id) ?? 0,
  });
  return new Map((sim?.arrivals || []).map((a) => [a.id, a.lateMinutes]));
}

// Visits the tech has not reached yet: only these can still run late.
const NOT_REACHED = new Set(['pending', 'confirmed', 'rescheduled']);

function samePlace(a, b) {
  return hasGeo(a) && hasGeo(b) && a.lat === b.lat && a.lng === b.lng;
}

function stopOrder(a, b) {
  // The tie-proximity order is the tech's whole displayed route (a 09:30
  // stop can run before a 09:00 one), so it wins outright when stamped.
  if (a.displayOrder != null && b.displayOrder != null) return a.displayOrder - b.displayOrder;
  return (minutesOf(a.windowStart) - minutesOf(b.windowStart))
    || ((a.routeOrder ?? Infinity) - (b.routeOrder ?? Infinity));
}

/**
 * Sets `driveFromPrevMin` / `driveToNextMin` (number or null) and
 * `firstStop` / `lastStop` in place on one technician's services. Each leg
 * in is also stamped once (`driveInShown`, on the stop's first card) with
 * the stop it comes from (`drivePrevName`, `drivePrevId`) and `driveLateMin`: the minutes
 * past the customer's 2-hour arrival window (start + 120) the tech lands if
 * the previous stop ends as planned, else null. A leg that cannot be
 * measured marks its stop's first card `driveLegUnknown`.
 */
function attachDriveLegs(services) {
  // A stop with no start time (the grid's all-day strip) has no place in
  // the timed route: it gets no legs and is skipped between its neighbours.
  const rows = (services || []).filter((s) => !NOT_A_STOP.has(s.status) && Number.isFinite(minutesOf(s.windowStart)));
  for (const s of services || []) {
    s.driveFromPrevMin = null;
    s.driveToNextMin = null;
    s.firstStop = false;
    s.lastStop = false;
    s.driveInShown = false;
    s.drivePrevName = null;
    s.driveLateMin = null;
    s.driveLegUnknown = false;
    s.drivePrevId = null;
  }
  // A visit group is one stop wherever its rows sort (route-model.js
  // physicalStops groups every visit_id the same way): placed at its
  // earliest member, located by its first member with a pin (groupUnit's
  // rule). Its legs show on that earliest card only (`legs`): the list
  // renders each member at its own time, so a later member's card would
  // otherwise claim legs that point backwards. Then back-to-back stops at
  // the same pin merge too (two services at one address without a group).
  const units = [];
  const groups = new Map();
  for (const s of [...rows].sort(stopOrder)) {
    if (!s.visitId) { units.push({ anchor: s, members: [s], legs: [s] }); continue; }
    if (!groups.has(s.visitId)) {
      const unit = { anchor: s, members: [], legs: [s] };
      groups.set(s.visitId, unit);
      units.push(unit);
    }
    const unit = groups.get(s.visitId);
    unit.members.push(s);
    if (!hasGeo(unit.anchor) && hasGeo(s)) unit.anchor = s;
  }
  const stops = [];
  for (const unit of units) {
    const last = stops[stops.length - 1];
    if (last && samePlace(last.anchor, unit.anchor)) {
      last.members.push(...unit.members);
      last.legs.push(...unit.legs);
    } else stops.push(unit);
  }
  if (stops.length) {
    stops[0].legs.forEach((s) => { s.firstStop = true; });
    stops[stops.length - 1].legs.forEach((s) => { s.lastStop = true; });
  }
  const legs = [];
  for (let i = 1; i < stops.length; i += 1) {
    const prev = stops[i - 1];
    const cur = stops[i];
    // Distinct pins are never "~0 min" apart: the estimator rounds a very
    // short hop to 0, so it floors at one minute.
    const leg = hasGeo(prev.anchor) && hasGeo(cur.anchor) ? Math.max(1, driveMin(prev.anchor, cur.anchor)) : null;
    legs.push(leg);
    prev.legs.forEach((s) => { s.driveToNextMin = leg; });
    cur.legs.forEach((s) => { s.driveFromPrevMin = leg; });
    // A leg without coordinates: the day total cannot claim to be whole.
    if (leg == null) { cur.legs[0].driveLegUnknown = true; continue; }
    cur.legs[0].driveInShown = true;
    cur.legs[0].drivePrevName = String(prev.legs[0].customerName || '').trim() || null;
    cur.legs[0].drivePrevId = prev.legs[0].id;
  }
  const late = stops.length > 1 && hasGeo(stops[0].anchor) ? lateByStop(stops, legs) : new Map();
  for (const st of stops.slice(1)) {
    const first = st.legs[0];
    const min = late.get(first.id);
    if (NOT_REACHED.has(first.status) && min > 0) first.driveLateMin = min;
  }
}

module.exports = { attachDriveLegs };
