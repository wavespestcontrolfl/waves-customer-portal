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
const { ARRIVAL_WINDOW_MINUTES } = require('../../utils/sms-time-format');

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

// A row's planned work: its window span (window end is the service-end
// estimate), else its stored duration, else one hour.
function workMinutes(s) {
  const start = minutesOf(s.windowStart);
  const end = minutesOf(s.windowEnd);
  if (Number.isFinite(end) && end > start) return end - start;
  const dur = Number(s.estimatedDuration);
  return Number.isFinite(dur) && dur > 0 ? dur : 60;
}

// A row's real work estimate, 0 when it has none. The day feed fills a
// missing estimate with 60 for display, so it also sends the stored value
// (rawEstimateMinutes); only that counts (coVisitWork's raw_estimate_minutes
// rule). A row without the field uses estimatedDuration as stored.
function realEstimate(s) {
  const raw = 'rawEstimateMinutes' in s ? s.rawEstimateMinutes : s.estimatedDuration;
  const dur = Number(raw);
  return Number.isFinite(dur) && dur > 0 ? dur : 0;
}

// When the tech leaves a stop. A visit group's rows run one after another
// (arrival-route.js groupRouteStops sums a visit's work), so two 60-minute
// rows of one visit booked at 09:00 leave at 11:00. Ungrouped rows merged
// by sharing a pin follow route-reorder-window-fit.js coVisitWork: the sum
// of their real estimates, floored by the longest row's own work, so two
// span-only rows sharing an hour stay one hour (the phantom hour).
function departure(rows) {
  const ends = [];
  const groups = new Map();
  const loose = [];
  for (const m of rows) {
    if (!m.visitId) { loose.push(m); continue; }
    if (!groups.has(m.visitId)) groups.set(m.visitId, []);
    groups.get(m.visitId).push(m);
  }
  for (const g of groups.values()) {
    const starts = g.map((m) => minutesOf(m.windowStart));
    const summed = Math.min(...starts) + g.reduce((sum, m) => sum + workMinutes(m), 0);
    ends.push(Math.max(summed, ...g.map((m, i) => starts[i] + workMinutes(m))));
  }
  if (loose.length) {
    const starts = loose.map((m) => minutesOf(m.windowStart));
    const estimates = loose.reduce((sum, m) => sum + realEstimate(m), 0);
    ends.push(Math.max(Math.min(...starts) + estimates, ...loose.map((m, i) => starts[i] + workMinutes(m))));
  }
  return Math.max(...ends);
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
 * the stop it comes from (`drivePrevName`) and `driveLateMin`: the minutes
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
  for (let i = 1; i < stops.length; i += 1) {
    const prev = stops[i - 1];
    const cur = stops[i];
    // Distinct pins are never "~0 min" apart: the estimator rounds a very
    // short hop to 0, so it floors at one minute.
    const leg = hasGeo(prev.anchor) && hasGeo(cur.anchor) ? Math.max(1, driveMin(prev.anchor, cur.anchor)) : null;
    prev.legs.forEach((s) => { s.driveToNextMin = leg; });
    cur.legs.forEach((s) => { s.driveFromPrevMin = leg; });
    // A leg without coordinates: the day total cannot claim to be whole.
    if (leg == null) { cur.legs[0].driveLegUnknown = true; continue; }
    const first = cur.legs[0];
    first.driveInShown = true;
    first.drivePrevName = String(prev.legs[0].customerName || '').trim() || null;
    if (NOT_REACHED.has(first.status)) {
      // The previous stop's work that runs before this one: a group member
      // booked later than this stop does not hold the tech here.
      const startMin = minutesOf(first.windowStart);
      const before = prev.members.filter((m) => minutesOf(m.windowStart) <= startMin);
      const arrive = departure(before.length ? before : prev.legs.slice(0, 1)) + leg;
      const late = arrive - (startMin + ARRIVAL_WINDOW_MINUTES);
      if (late > 0) first.driveLateMin = late;
    }
  }
}

module.exports = { attachDriveLegs };
