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
const { etParts } = require('../../utils/datetime-et');
const { premiseStampConflicts } = require('../stamped-address');
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

function hhmmOf(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
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
    status: s.status,
  };
}

function premiseOf(s) {
  const p = s.premise || {};
  return { service_address_line1: p.line1, service_address_line2: p.line2, service_address_city: p.city, service_address_zip: p.zip };
}

// isCoVisitPair's rule on day-feed rows: no visit group on either side, the
// same customer, the same promised window, the same pin and the same
// premise by the canonical rule (premiseStampConflicts: "St." = "Street",
// ZIP = ZIP+4). A row without a street line is unknown, not a pair.
function coVisitPair(a, b) {
  if (a.visitId || b.visitId) return false;
  if (a.customerId == null || String(a.customerId) !== String(b.customerId)) return false;
  if (minutesOf(a.windowStart) !== minutesOf(b.windowStart)) return false;
  if (!samePlace(a, b)) return false;
  if (!a.premise?.line1 || !b.premise?.line1) return false;
  return !premiseStampConflicts(premiseOf(a), premiseOf(b));
}

// A stop's work as the simulator's pieces, in day order, each keeping its
// own promised window (a 13:00 visit at the same pin as a 09:00 one still
// waits for 13:00): a visit group is one piece that sums its rows
// (arrival-route.js groupRouteStops); a run of co-visit rows is one piece
// (startCoVisitChain/advanceCoVisit, so two span-only rows sharing an hour
// stay one hour); every other row is its own piece.
// The planned work of a visit under way (driven to or being worked): time
// on site can use it up, never the work of a visit not started.
function workUnderWay(row) {
  return UNDER_WAY.has(row.status) ? workDuration(row) : 0;
}

function stopPieces(members) {
  const pieces = [];
  const byVisit = new Map();
  let chain = null;
  let prevLoose = null;
  for (const m of members) {
    const row = simRow(m);
    if (m.visitId) {
      chain = null;
      prevLoose = null;
      if (!byVisit.has(m.visitId)) {
        const piece = { id: m.id, rows: [], open: false, ids: [] };
        byVisit.set(m.visitId, piece);
        pieces.push(piece);
      }
      byVisit.get(m.visitId).rows.push(row);
      if (NOT_REACHED.has(m.status)) { byVisit.get(m.visitId).open = true; byVisit.get(m.visitId).ids.push(m.id); }
      continue;
    }
    if (chain && coVisitPair(prevLoose, m)) {
      chain.state = advanceCoVisit(chain.state, row);
      chain.work = chain.state.coMerged;
      if (NOT_REACHED.has(m.status)) { chain.open = true; chain.ids.push(m.id); }
      chain.startedWork += workUnderWay(row);
    } else {
      const state = { ...startCoVisitChain(row), arrivalMin: 0 };
      state.clock = state.coMerged;
      const open = NOT_REACHED.has(m.status);
      chain = { id: m.id, start: minutesOf(m.windowStart), work: state.coMerged, state, open, ids: open ? [m.id] : [], startedWork: workUnderWay(row) };
      pieces.push(chain);
    }
    prevLoose = m;
  }
  // A visit group runs its rows in turn and must keep every member's
  // promise: groupRouteStops' arrival range (each member's window, shifted
  // by the work before it; one shared range when all share an arrival).
  for (const piece of pieces) {
    if (!piece.rows) continue;
    const rows = [...piece.rows].sort((x, y) => minutesOf(x.window_start) - minutesOf(y.window_start));
    const shared = rows.every((r) => String(r.window_start) === String(rows[0].window_start));
    let work = 0;
    let startedWork = 0;
    let startMin = -Infinity;
    let endMin = Infinity;
    for (const r of rows) {
      const range = effectiveWindowRange(r);
      const offset = shared ? 0 : work;
      startMin = Math.max(startMin, range.startMin - offset);
      endMin = Math.min(endMin, range.endMin - offset);
      work += workDuration(r);
      startedWork += workUnderWay(r);
    }
    piece.start = minutesOf(rows[0].window_start);
    piece.work = work;
    piece.startedWork = startedWork;
    piece.range = endMin >= startMin ? { startMin, endMin } : null;
    // No single arrival keeps every promise (09:00 and 13:00 members): run
    // each member as its own zero-drive piece, so the tech waits for 13:00.
    if (!piece.range) {
      piece.split = rows.map((r) => ({
        id: r.id, start: minutesOf(r.window_start), work: workDuration(r), range: null,
        open: NOT_REACHED.has(r.status), ids: NOT_REACHED.has(r.status) ? [r.id] : [],
        startedWork: workUnderWay(r),
      }));
    }
  }
  // Day order across every piece at the pin: a loose 10:00 visit between a
  // split group's 09:00 and 13:00 members is worked in between, not after.
  return pieces.flatMap((p) => p.split || [p])
    .map((p, i) => ({ p, i }))
    .sort((x, y) => (x.p.start - y.p.start) || (x.i - y.i))
    .map(({ p }) => p);
}

// One simulator row per piece of work, at its stop's pin.
function seqRow(id, p, st) {
  return {
    id,
    arrivalRange: p.range || null,
    window_start: hhmmOf(p.start),
    estimated_duration_minutes: p.work,
    memberIds: [p.id],
    lat: st.anchor.lat,
    lng: st.anchor.lng,
  };
}

// The booked plan (any day but today): the day starts at the first stop at
// its booked time and every piece, reached or not, takes its planned work.
// The legs are the ones the lines show (0 between pieces of one stop).
// After a leg that cannot be measured, arrivals are unknown: no lateness
// from there on.
function planRoute(stops, legs) {
  const unknown = legs.findIndex((l) => l == null);
  const upTo = unknown === -1 ? stops.length : unknown + 1;
  if (upTo < 2) return null;
  const seq = [];
  const legIn = new Map();
  // Every piece of a stop answers for its card: a later piece that misses
  // its own promise (a split visit's 13:00 member) still makes it late.
  const piecesOf = new Map();
  stops.slice(0, upTo).forEach((st, i) => {
    piecesOf.set(st.legs[0].id, []);
    stopPieces(st.members).forEach((p, j) => {
      const id = `${i}:${j}`;
      // Only work the tech has not reached can still run late.
      if (p.open) piecesOf.get(st.legs[0].id).push({ id, ids: p.ids });
      if (j === 0 && i > 0) legIn.set(id, legs[i - 1]);
      seq.push(seqRow(id, p, st));
    });
  });
  return { seq, legIn, piecesOf, startMin: minutesOf(seq[0].window_start) };
}

// The last time a visit was touched: en route, check-in or check-out.
function touchedAt(m) {
  return Math.max(-Infinity, ...[m.enRouteAt, m.checkInTime, m.checkOutTime]
    .filter(Boolean).map((t) => new Date(t).getTime()).filter(Number.isFinite));
}

// Reached stops, the one touched last first: the tech is at (or driving
// to) the first. A stale on-site mark (an old check-in) never wins over
// later work, and a later stop worked early does not pull the tech forward.
// Without time stamps, day order decides.
function touchOrder(stops) {
  return stops.map((st, i) => {
    const reached = st.members.filter((m) => !NOT_REACHED.has(m.status));
    return { i, n: reached.length, t: Math.max(-Infinity, ...reached.map(touchedAt)) };
  }).filter((x) => x.n).sort((a, b) => (b.t - a.t) || (b.i - a.i)).map((x) => x.i);
}

// The drive still ahead to an en-route stop: the leg from the stop touched
// before it, less the minutes since the tech set off (all of it without an
// en-route time; none without a stop to come from, or once checked in).
function driveLeft(here, from, now) {
  const enRoute = here?.members.find((m) => m.status === 'en_route');
  if (!enRoute || !from || here.members.some((m) => m.checkInTime && UNDER_WAY.has(m.status))) return 0;
  const setOff = enRoute.enRouteAt ? new Date(enRoute.enRouteAt).getTime() : NaN;
  const gone = Number.isFinite(setOff) ? Math.max(0, Math.floor((now.getTime() - setOff) / 60000)) : 0;
  return Math.max(0, (legBetween(from, here) || 0) - gone);
}

// A visit group part-way through at the tech's stop: the work under way
// runs at once, and each member not started keeps its own window (a 12:00
// member still waits for 12:00). A co-visit chain shares one window, so it
// stays whole.
function remainingPieces(p) {
  if (!p.rows || !(p.startedWork > 0) || p.startedWork >= p.work) return [p];
  const later = p.rows.filter((r) => !UNDER_WAY.has(r.status)).map((r) => ({
    id: r.id, start: minutesOf(r.window_start), work: workDuration(r), range: null, startedWork: 0,
  }));
  return [{ ...p, work: p.startedWork, range: null }, ...later];
}

// Today (owner 2026-11-01, "build clock"): the day restarts from now at the
// stop the tech touched last (touchOrder). An en-route stop first takes the
// rest of its drive (driveLeft). Everything there not finished yet runs
// next, as one stop's pieces (a co-visit pair shares its hour): work under
// way starts at once, less the minutes since check-in, and a later piece
// there still waits for its own window. The tech is at that stop, so it is
// not flagged. Then every other stop's unreached visits run in day order; a
// reached visit elsewhere counts as done. After a leg that cannot be
// measured, arrivals are unknown.
function clockRoute(stops, now) {
  const [at = -1, before = -1] = touchOrder(stops);
  const here = stops[at] || null;
  const ahead = here ? here.members.filter((m) => NOT_REACHED.has(m.status) || UNDER_WAY.has(m.status)) : [];
  const checkIns = ahead.filter((m) => UNDER_WAY.has(m.status) && m.checkInTime)
    .map((m) => new Date(m.checkInTime).getTime()).filter(Number.isFinite);
  let worked = checkIns.length ? Math.max(0, Math.floor((now.getTime() - Math.min(...checkIns)) / 60000)) : 0;
  const seq = [];
  const legIn = new Map();
  const piecesOf = new Map();
  // Work under way first, then the rest by start time.
  const herePieces = stopPieces(ahead).flatMap(remainingPieces)
    .sort((a, b) => (Number(b.startedWork > 0) - Number(a.startedWork > 0)) || (a.start - b.start));
  herePieces.forEach((p, j) => {
    const done = Math.min(p.startedWork, p.work, worked);
    worked -= done;
    if (p.work - done <= 0) return;
    const row = seqRow(`${at}:${j}`, { ...p, work: p.work - done }, here);
    seq.push(p.startedWork > 0 ? { ...row, arrivalRange: NO_WAIT } : row);
  });
  let prev = here;
  for (const [i, st] of stops.entries()) {
    const open = i === at ? [] : stopPieces(st.members.filter((m) => NOT_REACHED.has(m.status)));
    if (!open.length) continue;
    const leg = prev ? legBetween(prev, st) : 0;
    if (leg == null) break;
    piecesOf.set(st.legs[0].id, open.map((p, j) => ({ id: `${i}:${j}`, ids: p.ids })));
    open.forEach((p, j) => {
      if (j === 0) legIn.set(`${i}:${j}`, leg);
      seq.push(seqRow(`${i}:${j}`, p, st));
    });
    prev = st;
  }
  if (!seq.length) return null;
  const { hour, minute } = etParts(now);
  return { seq, legIn, piecesOf, startMin: hour * 60 + minute + driveLeft(here, stops[before], now) };
}

// Minutes past each stop's 2-hour arrival window, from the shared route
// simulator (simulateArrivalRoute, reportLate): the clock carries every
// earlier delay forward and waits for each window to open. `now` (today
// only) runs the day from the clock instead of the booked plan.
function lateByStop(stops, legs, now) {
  const route = now ? clockRoute(stops, now) : planRoute(stops, legs);
  if (!route) return new Map();
  const { seq, legIn, piecesOf } = route;
  const rangeFor = (row) => row.arrivalRange || effectiveWindowRange(row);
  const sim = simulateArrivalRoute(RouteOptimizer, rangeFor, seq, {
    startMin: route.startMin,
    origin: { lat: Number(seq[0].lat), lng: Number(seq[0].lng) },
    reportLate: true,
    legMinutes: (_prev, stop) => legIn.get(stop.id) ?? 0,
  });
  const lateById = new Map((sim?.arrivals || []).map((a) => [a.id, a.lateMinutes]));
  const rangeById = new Map(seq.map((row) => [row.id, rangeFor(row)]));
  // Per card: the largest lateness, the window it misses (the line names
  // it: a split visit's 13:00 member, or a visit group's shared range, is
  // not the card's own start + 2 h), and the unreached visits that carry it
  // (the phone drops the red once all of them are on the way).
  return new Map([...piecesOf].map(([cardId, pieces]) => {
    const late = pieces.filter((p) => (lateById.get(p.id) || 0) > 0);
    const worst = late.reduce((w, p) => (!w || lateById.get(p.id) > lateById.get(w.id) ? p : w), null);
    const missed = worst ? rangeById.get(worst.id) : null;
    return [cardId, {
      min: worst ? lateById.get(worst.id) : 0,
      windowStart: missed ? hhmmOf(missed.startMin) : null,
      windowEnd: missed ? hhmmOf(missed.endMin) : null,
      ids: late.flatMap((p) => p.ids),
    }];
  }));
}

// Visits the tech has not reached yet: only these can still run late.
const NOT_REACHED = new Set(['pending', 'confirmed', 'rescheduled']);

// Visits the tech is driving to or working now: their work is still ahead.
const UNDER_WAY = new Set(['en_route', 'on_site', 'in_progress']);

// Work already started waits for no window and is never late.
const NO_WAIT = { startMin: -Infinity, endMin: Infinity };

function samePlace(a, b) {
  return hasGeo(a) && hasGeo(b) && a.lat === b.lat && a.lng === b.lng;
}

// The drive between two stops, or null when either has no pin. Distinct
// pins are never "0 min" apart: the estimator rounds a very short hop to 0,
// so it floors at one minute.
function legBetween(a, b) {
  return hasGeo(a.anchor) && hasGeo(b.anchor) ? Math.max(1, driveMin(a.anchor, b.anchor)) : null;
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
 * the previous stop ends as planned, else null, with that window as
 * `driveLateWindowStart` / `driveLateWindowEnd` ("HH:MM"). Pass `now` for
 * today's list: lateness then runs from the clock and the tech's progress,
 * not the booked plan. A leg that cannot be measured marks its stop's first
 * card `driveLegUnknown`.
 */
function attachDriveLegs(services, { now = null } = {}) {
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
    s.driveLateServiceIds = null;
    s.driveLateWindowStart = null;
    s.driveLateWindowEnd = null;
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
  const legs = [];
  for (let i = 1; i < stops.length; i += 1) {
    const prev = stops[i - 1];
    const cur = stops[i];
    const leg = legBetween(prev, cur);
    legs.push(leg);
    prev.legs.forEach((s) => { s.driveToNextMin = leg; });
    cur.legs.forEach((s) => { s.driveFromPrevMin = leg; });
    // A leg without coordinates: the day total cannot claim to be whole.
    if (leg == null) { cur.legs[0].driveLegUnknown = true; continue; }
    cur.legs[0].driveInShown = true;
    // The tech leaves a stop after its last piece of work: name that one.
    const lastWorked = prev.members[prev.members.length - 1];
    cur.legs[0].drivePrevName = String(lastWorked.customerName || '').trim() || null;
  }
  // A first stop without a pin leaves legs[0] null: the plan predicts nothing.
  const late = stops.length > 1 ? lateByStop(stops, legs, now) : new Map();
  for (const st of stops.slice(1)) {
    const first = st.legs[0];
    // The line sits on the stop's first card; any unreached piece of the
    // stop can make it late (a completed 9 AM neighbour does not hide it).
    const risk = late.get(first.id);
    if (risk?.min > 0) {
      first.driveLateMin = risk.min;
      first.driveLateServiceIds = risk.ids;
      first.driveLateWindowStart = risk.windowStart;
      first.driveLateWindowEnd = risk.windowEnd;
    }
  }
}

module.exports = { attachDriveLegs };
