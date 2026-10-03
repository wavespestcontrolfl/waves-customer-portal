// Drive minutes into and out of each stop on a technician's day, for the
// admin schedule's "~N min from last stop / ~N min to next" labels (owner ask
// 2026-10-03). DISPLAY ONLY: the straight-line estimate (driveMin, no paid
// routing call), nothing written, no stop reordered.
//
// Order is the one the day list shows: window start, then the tie-proximity
// displayOrder when present, then route_order. Rows of one physical stop (a
// visit group, or two services at the same coordinates) share their legs and
// never get a leg between each other. A cancelled or skipped row is not a
// stop. A missing coordinate yields null on its legs — never a 0 that would
// read as "next door".

const { driveMin } = require('../auto-dispatch/geo');

const NOT_A_STOP = new Set(['cancelled', 'skipped']);

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : Infinity;
}

function hasGeo(s) {
  return Number.isFinite(s.lat) && Number.isFinite(s.lng);
}

function samePlace(a, b) {
  if (a.visitId && a.visitId === b.visitId) return true;
  return hasGeo(a) && hasGeo(b) && a.lat === b.lat && a.lng === b.lng;
}

function stopOrder(a, b) {
  return (minutesOf(a.windowStart) - minutesOf(b.windowStart))
    || ((a.displayOrder ?? Infinity) - (b.displayOrder ?? Infinity))
    || ((a.routeOrder ?? Infinity) - (b.routeOrder ?? Infinity));
}

/**
 * Sets `driveFromPrevMin` / `driveToNextMin` (number or null) and
 * `firstStop` / `lastStop` in place on one technician's services.
 */
function attachDriveLegs(services) {
  const rows = (services || []).filter((s) => !NOT_A_STOP.has(s.status));
  for (const s of services || []) {
    s.driveFromPrevMin = null;
    s.driveToNextMin = null;
    s.firstStop = false;
    s.lastStop = false;
  }
  const stops = [];
  for (const s of [...rows].sort(stopOrder)) {
    const last = stops[stops.length - 1];
    if (last && samePlace(last.anchor, s)) last.members.push(s);
    else stops.push({ anchor: s, members: [s] });
  }
  if (stops.length) {
    stops[0].members.forEach((s) => { s.firstStop = true; });
    stops[stops.length - 1].members.forEach((s) => { s.lastStop = true; });
  }
  for (let i = 1; i < stops.length; i += 1) {
    const prev = stops[i - 1];
    const cur = stops[i];
    const leg = hasGeo(prev.anchor) && hasGeo(cur.anchor) ? driveMin(prev.anchor, cur.anchor) : null;
    prev.members.forEach((s) => { s.driveToNextMin = leg; });
    cur.members.forEach((s) => { s.driveFromPrevMin = leg; });
  }
}

module.exports = { attachDriveLegs };
