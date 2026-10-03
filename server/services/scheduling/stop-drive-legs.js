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
 * `firstStop` / `lastStop` in place on one technician's services.
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
  }
}

module.exports = { attachDriveLegs };
