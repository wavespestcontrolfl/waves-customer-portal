// Where each visit sits on the admin Schedule's Day grid: the PLANNED route
// arrival (`plannedArrivalMin`, minutes after midnight, Eastern wall clock)
// and the PLANNED on-site minutes (`plannedMinutes`), plus the arrival at the
// stop (`plannedStopArrivalMin`, the same for every service of a group), stamped on each day-feed
// row (owner 2026-11-24, "option A"). DISPLAY ONLY: the booked visit row stays
// one hour and its window stays on the hour; nothing is written and no stop
// is reordered.
//
// The model is day-quality.js's: simulateArrivalRoute over the straight-line
// fallback leg model (no Google, no paid call), the work of each stop from
// workDuration (owner planning minutes, else window span or estimate), the van
// leaving the tech's start point at the day's departure time. One simulation
// per technician-day. The stops, their order, the visit-group and co-visit
// pieces and their timing are the ones attachDriveLegs builds for the drive
// lines (stop-drive-legs.js buildStops / planRoute), so the grid and the
// drive lines never disagree. The van waits for a window to open and carries
// every earlier delay forward, so a late stop lands past its window
// (reportLate) instead of failing the model.
//
// One stop is one block: the rows of a visit group, or of a co-visit, share
// the piece's arrival and minutes. Both fields are null for a row the model
// cannot place: a completed, cancelled, skipped or no-show row, a row with no
// start time, a row at or after a leg that cannot be measured (no pin), or a
// day whose simulation fails. The grid then draws that row as it always did
// (window start, window or estimated length).

const RouteOptimizer = require('../route-optimizer');
const { driveMin } = require('../auto-dispatch/geo');
const { simulateArrivalRoute, effectiveWindowRange, workDuration } = require('../route-reorder-window-fit');
const {
  buildStops, planRoute, legBetween, hasGeo, minutesOf, NOT_A_STOP,
} = require('./stop-drive-legs');

// The office's departure when the caller gives none: day-quality's legacy 08:00.
const DEFAULT_DEPARTURE_MIN = 8 * 60;

function clearPlanned(services) {
  for (const s of services || []) {
    s.plannedArrivalMin = null;
    s.plannedMinutes = null;
    s.plannedStopArrivalMin = null;
    s.plannedStopKey = null;
  }
}

// Open work with a start time: what gets a planned block.
function isPlaceable(s) {
  return !NOT_A_STOP.has(s.status) && s.status !== 'completed' && Number.isFinite(minutesOf(s.windowStart));
}

// The day's route as the drive lines plan it, run from the departure at the
// tech's start point. Null when it cannot be run (no pin on the first stop).
function simulateDay(rows, { departureMin, home, blockedIntervals }) {
  const stops = buildStops(rows.filter((s) => !NOT_A_STOP.has(s.status) && Number.isFinite(minutesOf(s.windowStart))));
  if (!stops.length || !hasGeo(stops[0].anchor)) return null;
  const legs = stops.slice(1).map((st, i) => legBetween(stops[i], st));
  const route = planRoute(stops, legs);
  if (!route) return null;
  const firstId = route.seq[0].id;
  const firstLeg = driveMin(home, stops[0].anchor);
  const rangeFor = (row) => row.arrivalRange || effectiveWindowRange(row);
  const sim = simulateArrivalRoute(RouteOptimizer, rangeFor, route.seq, {
    startMin: departureMin,
    origin: home,
    end: home,
    reportLate: true,
    blockedIntervals,
    legMinutes: (_prev, stop) => (stop.id === firstId ? firstLeg : route.legIn.get(stop.id) ?? 0),
  });
  return sim ? { sim, membersOf: route.membersOf, pieceOf: route.pieceOf } : null;
}

// Each row of a piece with its modeled start and minutes. A visit group runs
// its services one after another inside the stop (planRoute sums their work),
// so each draws at its own start; a co-visit chain is one stretch of work that
// its rows share.
function memberSlots(piece, arrival, members) {
  const total = Math.round(arrival.departureMin - arrival.arrivalMin);
  if (!piece?.rows || piece.rows.length < 2) return members.map((id) => ({ id, start: arrival.arrivalMin, minutes: total }));
  let offset = 0;
  return [...piece.rows].sort((a, b) => minutesOf(a.window_start) - minutesOf(b.window_start)).map((r) => {
    const minutes = workDuration(r);
    const slot = { id: r.id, start: arrival.arrivalMin + offset, minutes };
    offset += minutes;
    return slot;
  });
}

/**
 * Sets `plannedArrivalMin` / `plannedMinutes` (whole minutes or null) in
 * place on one technician's services. `departureMin` is the van's departure
 * (departure-time.js dayDepartureMinutes); `home` its start point
 * (tech-start-point.js, the office by default); `blockedIntervals` the tech's
 * unavailable time (arrival-route.js blockedIntervalsFor).
 */
function attachPlannedBlocks(services, { departureMin = DEFAULT_DEPARTURE_MIN, home = RouteOptimizer.HQ, blockedIntervals = [] } = {}) {
  clearPlanned(services);
  const rows = (services || []).filter(isPlaceable);
  if (!rows.length) return;
  // Display only: a model error must never fail the day feed, so the rows
  // keep null fields and draw as before.
  let day = null;
  try {
    day = simulateDay(services, { departureMin, home, blockedIntervals });
  } catch {
    day = null;
  }
  if (!day) return;
  const byId = new Map(services.map((s) => [s.id, s]));
  for (const a of day.sim.arrivals) {
    if (!Number.isFinite(a.arrivalMin) || !(a.departureMin > a.arrivalMin)) continue;
    const members = day.membersOf.get(a.id) || [];
    // The physical stop (planRoute's stop index; a piece id is "stop:piece"):
    // every row of one stop, planned or not, so a list numbers it once.
    const stopKey = `stop-${String(a.id).split(':')[0]}`;
    for (const id of members) {
      const row = byId.get(id);
      if (row) row.plannedStopKey = stopKey;
    }
    for (const slot of memberSlots(day.pieceOf.get(a.id), a, members)) {
      const s = byId.get(slot.id);
      if (!s || !isPlaceable(s) || !(slot.minutes > 0)) continue;
      s.plannedArrivalMin = Math.round(slot.start);
      s.plannedMinutes = Math.round(slot.minutes);
      // Where the van reaches the stop: the promise is kept or missed here,
      // whichever service of a group starts later inside it.
      s.plannedStopArrivalMin = Math.round(a.arrivalMin);
    }
  }
}

module.exports = { attachPlannedBlocks };
