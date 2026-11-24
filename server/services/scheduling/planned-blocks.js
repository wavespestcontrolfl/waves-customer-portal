// Where each visit sits on the admin Schedule's Day grid: the PLANNED route
// arrival (`plannedArrivalMin`, minutes after midnight, Eastern wall clock)
// and the PLANNED on-site minutes (`plannedMinutes`), stamped on each day-feed
// row (owner 2026-11-24, "option A"). DISPLAY ONLY: the booked visit row stays
// one hour and its window stays on the hour; nothing is written and no stop
// is reordered.
//
// The model is day-quality.js's: simulateArrivalRoute over the straight-line
// fallback leg model (no Google, no paid call), the work of each stop from
// workDuration (owner planning minutes, else window span or estimate). One
// simulation per technician-day. Stops run in the order the day list shows
// (stopOrder: tie-proximity displayOrder, else window start); the van waits
// for a window to open and carries every earlier delay forward, so a late
// stop lands past its window (reportLate) instead of failing the model.
//
// Both fields are null for a row the model cannot place: a completed,
// cancelled, skipped or no-show row, a row with no start time, a row with no
// usable pin, or a day whose simulation fails. The grid then draws that row
// as it always did (window start, window or estimated length).

const RouteOptimizer = require('../route-optimizer');
const { simulateArrivalRoute, effectiveWindowRange } = require('../route-reorder-window-fit');
const { stopOrder, simRow, hasGeo, minutesOf, NOT_A_STOP } = require('./stop-drive-legs');

function clearPlanned(services) {
  for (const s of services || []) {
    s.plannedArrivalMin = null;
    s.plannedMinutes = null;
  }
}

// Open work with a start time: what the route simulation can place.
function isPlaceable(s) {
  return !NOT_A_STOP.has(s.status) && s.status !== 'completed' && Number.isFinite(minutesOf(s.windowStart));
}

/**
 * Sets `plannedArrivalMin` / `plannedMinutes` (whole minutes or null) in
 * place on one technician's services.
 */
function attachPlannedBlocks(services) {
  clearPlanned(services);
  const rows = (services || []).filter(isPlaceable).sort(stopOrder);
  if (!rows.length) return;
  // A stop without a pin rides the simulation with no leg (advanceSim) so its
  // work still moves the clock, but it is never drawn at a planned time.
  const seq = rows.map((s) => ({ ...simRow(s), lat: s.lat, lng: s.lng }));
  // Display only: a model error must never fail the day feed, so the rows
  // keep null fields and draw as before.
  let sim = null;
  try {
    sim = simulateArrivalRoute(RouteOptimizer, effectiveWindowRange, seq, {
      startMin: 0,
      reportLate: true,
    });
  } catch {
    sim = null;
  }
  if (!sim) return;
  const byId = new Map(sim.arrivals.map((a) => [a.id, a]));
  for (const s of rows) {
    const a = byId.get(s.id);
    if (!a || !hasGeo(s)) continue;
    const minutes = Math.round(a.departureMin - a.arrivalMin);
    if (!Number.isFinite(a.arrivalMin) || !(minutes > 0)) continue;
    s.plannedArrivalMin = Math.round(a.arrivalMin);
    s.plannedMinutes = minutes;
  }
}

module.exports = { attachPlannedBlocks };
